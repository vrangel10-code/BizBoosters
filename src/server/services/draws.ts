import { randomInt } from 'node:crypto';
import type { Prisma, RarityCode, Room, User } from '@prisma/client';
import { prisma } from '../db';
import { apiError } from '../errors';
import { recordActivity } from './activity';
import { cardImageUrl } from './card-images';
import { evaluateLowStock } from './decks';

export interface DrawResult {
  drawId: string;
  card: {
    id: string;
    name: string;
    rarity: RarityCode;
    effect_text: string | null;
    image_url: string | null;
  };
  inventoryItemId: string;
  tokenBalance: number;
  tokenCost: number;
  /** True when an idempotency key replayed an earlier draw. */
  replayed: boolean;
}

interface StockRow {
  id: string;
  card_id: string;
  copies_remaining: number;
}

/**
 * Picks one copy uniformly at random from every copy remaining in the room.
 *
 * This is the physical-deck model: 103 cards in a box, pull one. The prototype
 * instead chose a rarity by copy count and then a card type *uniformly among
 * types with stock*, which made a card with one copy left as likely as one with
 * ten — so a near-exhausted card became more likely per remaining copy. A
 * single weighted pick removes that distortion and produces exactly the odds
 * the panel advertises.
 */
export function pickCopy(rows: StockRow[], roll: number): StockRow {
  let cursor = roll;
  for (const row of rows) {
    cursor -= row.copies_remaining;
    if (cursor < 0) return row;
  }
  // Only reachable if roll >= sum(copies), which the caller prevents.
  throw new Error('Roll exceeded the deck size.');
}

export interface DrawInput {
  actor: User;
  room: Room;
  enrollmentId: string;
  idempotencyKey: string;
}

/**
 * Spend tokens, take one copy out of the shared deck, and hand it to the
 * student — exactly once, under concurrency.
 *
 * Ordering matters throughout: stock is confirmed before tokens are debited, so
 * a failed draw never costs anything; and the room advisory lock serialises
 * every deck mutation in the room, so thirty students clicking the last
 * Legendary produce exactly one winner.
 */
export async function drawCard({
  actor,
  room,
  enrollmentId,
  idempotencyKey,
}: DrawInput): Promise<DrawResult> {
  if (room.status === 'archived') {
    throw apiError('room_archived', 'This room has been archived.');
  }
  if (!idempotencyKey.trim()) {
    throw apiError('validation_failed', 'An idempotency key is required.');
  }

  const result = await prisma.$transaction(async (tx) => {
    // Serialise every deck mutation in this room. A classroom is ~30 people, so
    // a coarse room-wide lock costs nothing and is far easier to reason about
    // than ordering row locks across two tables. Different rooms never block
    // each other.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${room.id}, 0))`;

    // Replay before doing anything. Holding the lock means a double-click
    // serialises here and the second request finds the first's row.
    const existing = await tx.draw.findUnique({
      where: { enrollmentId_idempotencyKey: { enrollmentId, idempotencyKey } },
      include: { card: true, items: true, enrollment: true },
    });

    if (existing) {
      return {
        drawId: existing.id,
        card: {
          id: existing.card.id,
          name: existing.card.name,
          rarity: existing.card.rarity,
          effect_text: existing.card.effectText,
          image_url: cardImageUrl(existing.card.imageKey),
        },
        inventoryItemId: existing.items[0]?.id ?? '',
        tokenBalance: existing.enrollment.tokenBalance,
        tokenCost: existing.tokenCost,
        replayed: true,
      };
    }

    // Lock the wallet. Without this, two concurrent draws both read the same
    // balance and both think they can afford it.
    const [wallet] = await tx.$queryRaw<{ token_balance: number; status: string }[]>`
      SELECT token_balance, status FROM enrollments WHERE id = ${enrollmentId}::uuid FOR UPDATE
    `;
    if (!wallet) throw apiError('not_found', 'Not found.');
    if (wallet.status !== 'active') {
      throw apiError('not_found', 'You are no longer in this room.');
    }

    const cost = room.drawCostTokens;
    if (wallet.token_balance < cost) {
      throw apiError('insufficient_tokens', `You need ${cost} tokens to draw a card.`, {
        required: cost,
        balance: wallet.token_balance,
      });
    }

    // Read the deck. A stable order keeps the roll reproducible from the stored
    // snapshot, which is what makes a disputed draw auditable.
    const stock = await tx.$queryRaw<StockRow[]>`
      SELECT id, card_id, copies_remaining
        FROM room_cards
       WHERE room_id = ${room.id}::uuid AND copies_remaining > 0
       ORDER BY id
    `;

    const poolSize = stock.reduce((sum, row) => sum + row.copies_remaining, 0);

    if (poolSize === 0) {
      // Rejected before any debit: an empty deck must never cost a student
      // tokens. With a circulating deck this means hoarding, so the error says
      // how many copies are out.
      const held = await tx.inventoryItem.count({ where: { roomId: room.id, state: 'owned' } });
      throw apiError('pool_empty', 'There are no cards left in the deck right now.', {
        held_by_students: held,
      });
    }

    // Server-side CSPRNG. Never Math.random(), never the client — all a student
    // needs to mint a Legendary otherwise is DevTools.
    const roll = randomInt(poolSize);
    const picked = pickCopy(stock, roll);

    const consumed = await tx.$executeRaw`
      UPDATE room_cards
         SET copies_remaining = copies_remaining - 1
       WHERE id = ${picked.id}::uuid AND copies_remaining > 0
    `;
    if (consumed === 0) {
      // Defence in depth; the advisory lock should make this unreachable.
      throw apiError('pool_empty', 'That card was taken a moment ago. Try again.');
    }

    const balanceAfter = wallet.token_balance - cost;
    await tx.enrollment.update({
      where: { id: enrollmentId },
      data: { tokenBalance: balanceAfter },
    });

    const card = await tx.card.findUniqueOrThrow({ where: { id: picked.card_id } });

    const snapshot = await tx.$queryRaw<{ rarity: RarityCode; n: number }[]>`
      SELECT c.rarity, SUM(rc.copies_remaining)::int AS n
        FROM room_cards rc JOIN cards c ON c.id = rc.card_id
       WHERE rc.room_id = ${room.id}::uuid
       GROUP BY c.rarity
    `;

    const draw = await tx.draw.create({
      data: {
        roomId: room.id,
        enrollmentId,
        kind: 'token_draw',
        tokenCost: cost,
        resultCardId: card.id,
        resultRarity: card.rarity,
        poolSnapshot: Object.fromEntries(
          snapshot.map((row) => [row.rarity, row.n]),
        ) as Prisma.InputJsonValue,
        rollValue: roll,
        poolSize,
        idempotencyKey,
      },
    });

    await tx.tokenTransaction.create({
      data: {
        enrollmentId,
        delta: -cost,
        balanceAfter,
        reason: 'draw_spend',
        actorUserId: actor.id,
        relatedType: 'draw',
        relatedId: draw.id,
      },
    });

    const item = await tx.inventoryItem.create({
      data: {
        enrollmentId,
        roomId: room.id,
        cardId: card.id,
        state: 'owned',
        acquiredVia: 'draw',
        drawId: draw.id,
      },
    });

    await recordActivity(
      {
        roomId: room.id,
        type: 'card.drawn',
        actorUserId: actor.id,
        subjectEnrollmentId: enrollmentId,
        // The card name is snapshotted, so a later rename never rewrites what
        // the log said happened.
        payload: {
          card_id: card.id,
          card_name: card.name,
          rarity: card.rarity,
          token_cost: cost,
        },
      },
      tx,
    );

    return {
      drawId: draw.id,
      card: {
        id: card.id,
        name: card.name,
        rarity: card.rarity,
        effect_text: card.effectText,
        image_url: cardImageUrl(card.imageKey),
      },
      inventoryItemId: item.id,
      tokenBalance: balanceAfter,
      tokenCost: cost,
      replayed: false,
    };
  });

  // After commit, never inside: an alert for a rolled-back draw is a ghost.
  if (!result.replayed) {
    await evaluateLowStock(room.id).catch(() => undefined);
  }

  return result;
}

// ─── Inventory ───────────────────────────────────────────────────────────────

export interface InventoryStack {
  card_id: string;
  name: string;
  rarity: RarityCode;
  effect_text: string | null;
  image_url: string | null;
  count: number;
  item_ids: string[];
}

/** Owned copies, stacked by card — a student with four Snack Rushes sees one
 *  tile reading "x4" rather than four identical tiles. */
export async function listInventory(enrollmentId: string): Promise<InventoryStack[]> {
  const items = await prisma.inventoryItem.findMany({
    where: { enrollmentId, state: 'owned' },
    include: { card: true },
    orderBy: { acquiredAt: 'asc' },
  });

  const stacks = new Map<string, InventoryStack>();
  for (const item of items) {
    const existing = stacks.get(item.cardId);
    if (existing) {
      existing.count += 1;
      existing.item_ids.push(item.id);
      continue;
    }
    stacks.set(item.cardId, {
      card_id: item.cardId,
      name: item.card.name,
      rarity: item.card.rarity,
      effect_text: item.card.effectText,
      image_url: cardImageUrl(item.card.imageKey),
      count: 1,
      item_ids: [item.id],
    });
  }

  const order: RarityCode[] = ['L', 'R', 'U', 'C'];
  return [...stacks.values()].sort(
    (a, b) => order.indexOf(a.rarity) - order.indexOf(b.rarity) || a.name.localeCompare(b.name),
  );
}

export async function countHeldCopies(roomId: string): Promise<number> {
  return prisma.inventoryItem.count({ where: { roomId, state: 'owned' } });
}
