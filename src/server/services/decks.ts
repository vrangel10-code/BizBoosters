import type { Prisma, RarityCode, Room, User } from '@prisma/client';
import { prisma } from '../db';
import { apiError } from '../errors';
import { recordActivity } from './activity';
import { cardImageUrl } from './card-images';

export const RARITY_ORDER: RarityCode[] = ['C', 'U', 'R', 'L'];

export const DEFAULT_RARITIES: Record<RarityCode, { label: string; colorHex: string }> = {
  C: { label: 'Common', colorHex: '#3b82f6' },
  U: { label: 'Uncommon', colorHex: '#10b981' },
  R: { label: 'Rare', colorHex: '#8b5cf6' },
  L: { label: 'Legendary', colorHex: '#fbbf24' },
};

export async function ensureRoomRarities(
  roomId: string,
  tx: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<void> {
  await tx.roomRarity.createMany({
    data: RARITY_ORDER.map((code, index) => ({
      roomId,
      code,
      label: DEFAULT_RARITIES[code].label,
      colorHex: DEFAULT_RARITIES[code].colorHex,
      sortOrder: index,
    })),
    skipDuplicates: true,
  });
}

// ─── Odds ────────────────────────────────────────────────────────────────────

export interface RarityOdds {
  code: RarityCode;
  label: string;
  color_hex: string;
  in_deck: number;
  held: number;
  total: number;
  /** Share of the deck, not of all copies — this is the actual draw chance. */
  chance: number;
}

export interface DeckOdds {
  rarities: RarityOdds[];
  in_deck: number;
  held: number;
  total: number;
  is_empty: boolean;
  is_low: boolean;
  low_stock_threshold: number;
}

/**
 * Live odds, derived and never stored.
 *
 * `chance` is a copy's share of what is *in the deck*, which is what a draw
 * actually rolls against. `held` is reported alongside because with a
 * circulating deck a thin deck means hoarding, not exhaustion — without that
 * number an empty deck looks like a bug.
 */
export async function getDeckOdds(room: Room): Promise<DeckOdds> {
  const rows = await prisma.$queryRaw<
    { rarity: RarityCode; in_deck: number; total: number }[]
  >`
    SELECT c.rarity,
           COALESCE(SUM(rc.copies_remaining), 0)::int AS in_deck,
           COALESCE(SUM(rc.copies_total), 0)::int     AS total
      FROM room_cards rc
      JOIN cards c ON c.id = rc.card_id
     WHERE rc.room_id = ${room.id}::uuid
     GROUP BY c.rarity
  `;

  const byRarity = new Map(rows.map((row) => [row.rarity, row]));
  const inDeck = rows.reduce((sum, row) => sum + row.in_deck, 0);
  const total = rows.reduce((sum, row) => sum + row.total, 0);

  const labels = await prisma.roomRarity.findMany({ where: { roomId: room.id } });
  const labelFor = new Map(labels.map((row) => [row.code, row]));

  return {
    rarities: RARITY_ORDER.map((code) => {
      const row = byRarity.get(code);
      const deckCount = row?.in_deck ?? 0;
      const totalCount = row?.total ?? 0;
      return {
        code,
        label: labelFor.get(code)?.label ?? DEFAULT_RARITIES[code].label,
        color_hex: labelFor.get(code)?.colorHex ?? DEFAULT_RARITIES[code].colorHex,
        in_deck: deckCount,
        held: totalCount - deckCount,
        total: totalCount,
        chance: inDeck > 0 ? deckCount / inDeck : 0,
      };
    }),
    in_deck: inDeck,
    held: total - inDeck,
    total,
    is_empty: inDeck === 0,
    is_low: total > 0 && inDeck <= room.lowStockThreshold,
    low_stock_threshold: room.lowStockThreshold,
  };
}

export interface DeckEntry {
  card_id: string;
  name: string;
  rarity: RarityCode;
  image_url: string | null;
  copies_total: number;
  in_deck: number;
  held: number;
}

export async function getDeck(roomId: string): Promise<DeckEntry[]> {
  const rows = await prisma.roomCard.findMany({
    where: { roomId },
    include: { card: true },
    orderBy: [{ card: { rarity: 'asc' } }, { card: { name: 'asc' } }],
  });

  return rows.map((row) => ({
    card_id: row.cardId,
    name: row.card.name,
    rarity: row.card.rarity,
    image_url: cardImageUrl(row.card.imageKey),
    copies_total: row.copiesTotal,
    in_deck: row.copiesRemaining,
    held: row.copiesTotal - row.copiesRemaining,
  }));
}

// ─── Editing the deck ────────────────────────────────────────────────────────

export interface DeckEntryInput {
  card_id: string;
  copies_total: number;
}

export interface SetDeckResult {
  applied: { card_id: string; copies_total: number; in_deck: number }[];
  capped: { card_id: string; requested: number; applied: number; held: number }[];
}

/**
 * Educators set **total** copies; `copies_remaining` is derived here.
 *
 * The rule that makes this safe: a change of N to the total moves the deck
 * count by the same N. Never assign `remaining = total` — that is the refill
 * that mints cards out of students' hands (MECHANICS §3.1). Total can never
 * fall below what students are already holding, so a request that would is
 * capped and reported rather than silently obeyed.
 */
export async function setDeck(
  actor: User,
  room: Room,
  entries: DeckEntryInput[],
): Promise<SetDeckResult> {
  if (entries.length === 0) throw apiError('validation_failed', 'The deck cannot be empty.');

  const cardIds = entries.map((entry) => entry.card_id);
  if (new Set(cardIds).size !== cardIds.length) {
    throw apiError('validation_failed', 'The same card appears twice.');
  }

  const cards = await prisma.card.findMany({
    where: { id: { in: cardIds }, schoolId: room.schoolId },
  });
  if (cards.length !== cardIds.length) {
    throw apiError('not_found', 'One or more of those cards could not be found.');
  }

  const result = await prisma.$transaction(async (tx) => {
    await ensureRoomRarities(room.id, tx);

    const existing = await tx.roomCard.findMany({ where: { roomId: room.id } });
    const byCard = new Map(existing.map((row) => [row.cardId, row]));

    const applied: SetDeckResult['applied'] = [];
    const capped: SetDeckResult['capped'] = [];

    for (const entry of entries) {
      const current = byCard.get(entry.card_id);

      if (!current) {
        const created = await tx.roomCard.create({
          data: {
            roomId: room.id,
            cardId: entry.card_id,
            copiesTotal: entry.copies_total,
            copiesRemaining: entry.copies_total,
          },
        });
        applied.push({
          card_id: entry.card_id,
          copies_total: created.copiesTotal,
          in_deck: created.copiesRemaining,
        });
        continue;
      }

      const held = current.copiesTotal - current.copiesRemaining;
      let target = entry.copies_total;

      if (target < held) {
        // Reducing below what students hold would need reaching into their
        // hands. Cap at `held` and say so.
        capped.push({
          card_id: entry.card_id,
          requested: entry.copies_total,
          applied: held,
          held,
        });
        target = held;
      }

      const delta = target - current.copiesTotal;
      const updated = await tx.roomCard.update({
        where: { id: current.id },
        data: {
          copiesTotal: target,
          copiesRemaining: current.copiesRemaining + delta,
        },
      });

      applied.push({
        card_id: entry.card_id,
        copies_total: updated.copiesTotal,
        in_deck: updated.copiesRemaining,
      });
    }

    // Cards left out of the request drop to zero in the deck but keep any
    // copies students hold, which leave circulation as they are used.
    const omitted = existing.filter((row) => !cardIds.includes(row.cardId));
    for (const row of omitted) {
      const held = row.copiesTotal - row.copiesRemaining;
      if (held === 0) {
        await tx.roomCard.delete({ where: { id: row.id } });
      } else {
        await tx.roomCard.update({
          where: { id: row.id },
          data: { copiesTotal: held, copiesRemaining: 0 },
        });
      }
    }

    await recordActivity(
      {
        roomId: room.id,
        type: 'pool.updated',
        actorUserId: actor.id,
        payload: { cards: entries.length, capped: capped.length },
      },
      tx,
    );

    return { applied, capped };
  });

  await evaluateLowStock(room.id, actor.id);
  return result;
}

/**
 * Reset Deck — the semester-boundary action, and the only one that destroys
 * student collections.
 *
 * Refilling on its own would mint copies from nothing; refilling **and**
 * clearing every hand in one transaction lands back on `held = 0`,
 * `remaining = total`, so conservation holds by construction. The two halves
 * are why this is a single operation and not two.
 */
export async function resetDeck(
  actor: User,
  room: Room,
  confirmation: string,
): Promise<{ cardsRefilled: number; copiesReturned: number }> {
  if (confirmation.trim() !== room.name) {
    throw apiError(
      'confirmation_required',
      'Type the room name exactly to confirm. This wipes every student’s cards.',
      { expected: room.name },
    );
  }

  const result = await prisma.$transaction(async (tx) => {
    // Same room lock as the draw: this is a deck mutation, and a draw landing
    // mid-reset would leave a copy owned by nobody.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${room.id}, 0))`;

    const before = await tx.roomCard.findMany({ where: { roomId: room.id } });
    const copiesReturned = before.reduce(
      (sum, row) => sum + (row.copiesTotal - row.copiesRemaining),
      0,
    );

    // Both halves, in one transaction. Refilling alone would mint the held
    // copies from nothing; clearing hands alone would strand them. Together
    // they land on held = 0, remaining = total.
    const revoked = await tx.inventoryItem.updateMany({
      where: { roomId: room.id, state: 'owned' },
      data: { state: 'revoked', returnedAt: new Date() },
    });

    const refilled = await tx.$executeRaw`
      UPDATE room_cards SET copies_remaining = copies_total WHERE room_id = ${room.id}::uuid
    `;

    await recordActivity(
      {
        roomId: room.id,
        type: 'pool.reset',
        actorUserId: actor.id,
        payload: {
          cards_refilled: refilled,
          copies_returned: copiesReturned,
          items_revoked: revoked.count,
        },
      },
      tx,
    );

    // Reset clears the condition, so the alert must re-arm.
    await tx.room.update({ where: { id: room.id }, data: { lowStockAlerted: false } });

    return { cardsRefilled: refilled, copiesReturned };
  });

  return result;
}

/**
 * Edge-triggered low-stock alerting.
 *
 * Evaluating on every draw would send a notification per draw for a room
 * hovering at the threshold, so the alert fires once on the way down and
 * re-arms only after the deck climbs back above the threshold plus a hysteresis
 * band — which happens naturally as students spend cards.
 */
const LOW_STOCK_HYSTERESIS = 5;

export async function evaluateLowStock(roomId: string, actorUserId?: string): Promise<void> {
  const room = await prisma.room.findUnique({ where: { id: roomId } });
  if (!room) return;

  const odds = await getDeckOdds(room);
  if (odds.total === 0) return;

  const belowThreshold = odds.in_deck <= room.lowStockThreshold;
  const recovered = odds.in_deck > room.lowStockThreshold + LOW_STOCK_HYSTERESIS;

  if (belowThreshold && !room.lowStockAlerted) {
    await prisma.$transaction(async (tx) => {
      await tx.room.update({ where: { id: roomId }, data: { lowStockAlerted: true } });
      await recordActivity(
        {
          roomId,
          type: odds.in_deck === 0 ? 'pool.empty' : 'pool.low',
          actorUserId: actorUserId ?? null,
          payload: {
            in_deck: odds.in_deck,
            held: odds.held,
            total: odds.total,
            threshold: room.lowStockThreshold,
          },
        },
        tx,
      );
    });
    return;
  }

  if (recovered && room.lowStockAlerted) {
    await prisma.room.update({ where: { id: roomId }, data: { lowStockAlerted: false } });
  }
}
