import type { Card, RarityCode, User } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { apiError } from '../errors';
import { cardImageUrl, deleteCardImage, processCardImage } from './card-images';

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

export interface CreateCardInput {
  actor: User;
  schoolId: string;
  name: string;
  rarity: RarityCode;
  effectText?: string | null;
  description?: string | null;
  sourceUrl?: string | null;
}

export async function createCard({
  actor,
  schoolId,
  name,
  rarity,
  effectText,
  description,
  sourceUrl,
}: CreateCardInput): Promise<Card> {
  const trimmed = name.trim();
  if (!trimmed) throw apiError('validation_failed', 'A card name is required.');

  try {
    return await prisma.card.create({
      data: {
        schoolId,
        name: trimmed,
        rarity,
        effectText: effectText?.trim() || null,
        description: description?.trim() || null,
        sourceUrl: sourceUrl ?? null,
        createdBy: actor.id,
      },
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw apiError('card_name_in_use', 'A card with that name already exists.');
    }
    throw error;
  }
}

export interface UpdateCardInput {
  actor: User;
  cardId: string;
  name?: string;
  rarity?: RarityCode;
  effectText?: string | null;
  description?: string | null;
}

/**
 * Renaming is expected and safe: activity events snapshot the name they
 * recorded, so a rename in week ten never rewrites what the log said in week
 * two.
 *
 * Rarity is different. It is locked once the card is in any deck, because
 * changing it would silently move copies between rarity buckets and shift every
 * student's odds mid-term.
 */
export async function updateCard({
  actor,
  cardId,
  name,
  rarity,
  effectText,
  description,
}: UpdateCardInput): Promise<Card> {
  const card = await prisma.card.findUnique({
    where: { id: cardId },
    include: { _count: { select: { roomCards: true } } },
  });

  if (!card || card.schoolId !== actor.schoolId) throw apiError('not_found', 'Not found.');

  if (rarity && rarity !== card.rarity && card._count.roomCards > 0) {
    throw apiError(
      'rarity_locked',
      'This card is in a live deck, so its rarity cannot change. Remove it from every deck first.',
      { rooms_using: card._count.roomCards },
    );
  }

  const data: Prisma.CardUpdateInput = {};
  if (name !== undefined) {
    const trimmed = name.trim();
    if (!trimmed) throw apiError('validation_failed', 'A card name is required.');
    data.name = trimmed;
  }
  if (rarity !== undefined) data.rarity = rarity;
  if (effectText !== undefined) data.effectText = effectText?.trim() || null;
  if (description !== undefined) data.description = description?.trim() || null;

  if (Object.keys(data).length === 0) {
    throw apiError('validation_failed', 'Nothing to change.');
  }

  try {
    return await prisma.card.update({ where: { id: cardId }, data });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw apiError('card_name_in_use', 'A card with that name already exists.');
    }
    throw error;
  }
}

export async function setCardImage(
  actor: User,
  cardId: string,
  file: Buffer,
  declaredType?: string,
): Promise<Card> {
  const card = await prisma.card.findUnique({ where: { id: cardId } });
  if (!card || card.schoolId !== actor.schoolId) throw apiError('not_found', 'Not found.');

  const processed = await processCardImage(cardId, file, { declaredType: declaredType ?? '' });

  const updated = await prisma.card.update({
    where: { id: cardId },
    data: { imageKey: processed.keyStem },
  });

  // Only after the new art is committed, so a failed upload never leaves the
  // card with no image at all.
  if (card.imageKey && card.imageKey !== processed.keyStem) {
    await deleteCardImage(card.imageKey);
  }

  return updated;
}

/**
 * Archiving hides a card from new decks but leaves existing decks alone —
 * copies already in circulation keep working.
 */
export async function archiveCard(actor: User, cardId: string): Promise<void> {
  const card = await prisma.card.findUnique({ where: { id: cardId } });
  if (!card || card.schoolId !== actor.schoolId) throw apiError('not_found', 'Not found.');

  await prisma.card.update({ where: { id: cardId }, data: { isArchived: true } });
}

export interface CardView {
  id: string;
  name: string;
  rarity: RarityCode;
  effect_text: string | null;
  description: string | null;
  image_url: string | null;
  is_archived: boolean;
  rooms_using: number;
}

export async function listCards(
  schoolId: string,
  options: { includeArchived?: boolean } = {},
): Promise<CardView[]> {
  const cards = await prisma.card.findMany({
    where: { schoolId, ...(options.includeArchived ? {} : { isArchived: false }) },
    orderBy: [{ rarity: 'asc' }, { name: 'asc' }],
    include: { _count: { select: { roomCards: true } } },
  });

  return cards.map((card) => ({
    id: card.id,
    name: card.name,
    rarity: card.rarity,
    effect_text: card.effectText,
    description: card.description,
    image_url: cardImageUrl(card.imageKey),
    is_archived: card.isArchived,
    rooms_using: card._count.roomCards,
  }));
}
