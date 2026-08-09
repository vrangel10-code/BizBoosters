import { randomInt } from 'node:crypto';
import type { Prisma, RarityCode, Room, User } from '@prisma/client';
import { prisma } from '../db';
import { apiError } from '../errors';
import { cardImageUrl } from './card-images';
import { evaluateLowStock, getDeckOdds } from './decks';
import { createNotifications, roomEducatorIds } from './notifications';
import { publishAfterCommit } from '../events/bus';
import { pickCopy } from './draws';

/** C → U → R → L. Legendary has nothing above it. */
const RARITY_LADDER: Record<RarityCode, RarityCode | null> = {
  C: 'U',
  U: 'R',
  R: 'L',
  L: null,
};

interface CardSummary {
  id: string;
  name: string;
  rarity: RarityCode;
  effect_text: string | null;
  image_url: string | null;
}

/**
 * Returns one copy to the room's deck.
 *
 * Guarded by `copies_remaining < copies_total` so a double-return can never
 * inflate the deck — the constraint would reject it anyway, but failing to
 * increment is a cleaner outcome than aborting the transaction.
 */
async function returnCopyToDeck(
  tx: Prisma.TransactionClient,
  roomId: string,
  cardId: string,
): Promise<void> {
  await tx.$executeRaw`
    UPDATE room_cards
       SET copies_remaining = copies_remaining + 1
     WHERE room_id = ${roomId}::uuid AND card_id = ${cardId}::uuid
       AND copies_remaining < copies_total
  `;
}

export interface UseCardResult {
  itemId: string;
  card: CardSummary;
}

/**
 * A student spends a card.
 *
 * No approval gate: the card is spent the moment they press the button and the
 * educator is told afterwards. The copy goes straight back to the deck, so
 * using a card visibly improves everyone else's odds — the most motivating
 * moment in the game, and the reason `room.pool_changed` fires here too.
 */
export async function useCard(
  actor: User,
  room: Room,
  enrollmentId: string,
  itemId: string,
  note?: string | null,
): Promise<UseCardResult> {
  if (room.status === 'archived') {
    throw apiError('room_archived', 'This room has been archived.');
  }

  const result = await prisma.$transaction(async (tx) => {
    // Deck mutation: same room lock as the draw.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${room.id}, 0))`;

    const item = await tx.inventoryItem.findUnique({
      where: { id: itemId },
      include: { card: true },
    });

    if (!item || item.enrollmentId !== enrollmentId || item.roomId !== room.id) {
      throw apiError('item_not_owned', 'That card is not in your collection.');
    }

    // The state predicate is what makes a double-click safe: the second attempt
    // matches zero rows and the copy is returned to the deck exactly once.
    const claimed = await tx.inventoryItem.updateMany({
      where: { id: itemId, state: 'owned' },
      data: { state: 'used', usedAt: new Date(), returnedAt: new Date(), studentNote: note?.trim() || null },
    });
    if (claimed.count === 0) {
      throw apiError('item_state_conflict', 'You have already used that card.');
    }

    await returnCopyToDeck(tx, room.id, item.cardId);

    const event = await tx.activityEvent.create({
      data: {
        roomId: room.id,
        type: 'card.used',
        actorUserId: actor.id,
        subjectEnrollmentId: enrollmentId,
        payload: {
          card_id: item.cardId,
          card_name: item.card.name,
          rarity: item.card.rarity,
          item_id: itemId,
          note: note?.trim() || null,
        },
      },
    });

    const educators = await roomEducatorIds(room.id, tx);
    await createNotifications(
      educators.map((userId) => ({
        recipientUserId: userId,
        roomId: room.id,
        activityEventId: event.id,
        type: 'card.used' as const,
        payload: {
          card_name: item.card.name,
          rarity: item.card.rarity,
          student_name: actor.displayName,
          item_id: itemId,
          note: note?.trim() || null,
        },
      })),
      tx,
    );

    return {
      itemId,
      card: {
        id: item.card.id,
        name: item.card.name,
        rarity: item.card.rarity,
        effect_text: item.card.effectText,
        image_url: cardImageUrl(item.card.imageKey),
      },
      educators,
    };
  });

  const odds = await getDeckOdds(room);

  publishAfterCommit([
    ...result.educators.map((userId) => ({
      kind: 'notification' as const,
      userId,
      data: {
        type: 'card.used',
        room_id: room.id,
        card_name: result.card.name,
        student_name: actor.displayName,
      },
    })),
    // Everyone in the room sees the odds tick back up, which is the whole point
    // of a circulating deck.
    { kind: 'room.pool_changed' as const, roomId: room.id, data: { odds, cause: 'card.used' } },
  ]);

  await evaluateLowStock(room.id).catch(() => undefined);

  return { itemId: result.itemId, card: result.card };
}

/** Give an unused copy back to the deck — the prototype's "Claim / Return". */
export async function returnCard(
  actor: User,
  room: Room,
  enrollmentId: string,
  itemId: string,
): Promise<{ itemId: string; card: CardSummary }> {
  if (room.status === 'archived') {
    throw apiError('room_archived', 'This room has been archived.');
  }

  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${room.id}, 0))`;

    const item = await tx.inventoryItem.findUnique({
      where: { id: itemId },
      include: { card: true },
    });
    if (!item || item.enrollmentId !== enrollmentId || item.roomId !== room.id) {
      throw apiError('item_not_owned', 'That card is not in your collection.');
    }

    const claimed = await tx.inventoryItem.updateMany({
      where: { id: itemId, state: 'owned' },
      data: { state: 'returned', returnedAt: new Date() },
    });
    if (claimed.count === 0) {
      throw apiError('item_state_conflict', 'That card is no longer in your collection.');
    }

    await returnCopyToDeck(tx, room.id, item.cardId);

    const event = await tx.activityEvent.create({
      data: {
        roomId: room.id,
        type: 'card.returned',
        actorUserId: actor.id,
        subjectEnrollmentId: enrollmentId,
        payload: { card_id: item.cardId, card_name: item.card.name, rarity: item.card.rarity },
      },
    });

    const educators = await roomEducatorIds(room.id, tx);
    await createNotifications(
      educators.map((userId) => ({
        recipientUserId: userId,
        roomId: room.id,
        activityEventId: event.id,
        type: 'card.returned' as const,
        payload: { card_name: item.card.name, student_name: actor.displayName },
      })),
      tx,
    );

    return {
      itemId,
      card: {
        id: item.card.id,
        name: item.card.name,
        rarity: item.card.rarity,
        effect_text: item.card.effectText,
        image_url: cardImageUrl(item.card.imageKey),
      },
    };
  });

  const odds = await getDeckOdds(room);
  publishAfterCommit([
    { kind: 'room.pool_changed', roomId: room.id, data: { odds, cause: 'card.returned' } },
  ]);

  return result;
}

export interface TradeResult {
  drawId: string;
  card: CardSummary;
  inventoryItemId: string;
  consumed: string[];
  replayed: boolean;
}

/**
 * The prototype's marketplace upgrade: surrender `trade_ratio` copies of one
 * rarity, get one of the next rarity up.
 *
 * The surrendered cards are specific items the student owns — the prototype
 * inferred "what you hold" from gaps in the pool, which was a single-player
 * fiction. Costs no tokens, matching the original.
 */
export async function tradeUp(
  actor: User,
  room: Room,
  enrollmentId: string,
  itemIds: string[],
  idempotencyKey: string,
): Promise<TradeResult> {
  if (room.status === 'archived') {
    throw apiError('room_archived', 'This room has been archived.');
  }
  if (!room.tradesEnabled) {
    throw apiError('trades_disabled', 'Trading is switched off in this room.');
  }
  if (!idempotencyKey.trim()) {
    throw apiError('validation_failed', 'An idempotency key is required.');
  }
  if (new Set(itemIds).size !== itemIds.length) {
    throw apiError('invalid_trade_selection', 'The same card was selected twice.');
  }
  if (itemIds.length !== room.tradeRatio) {
    throw apiError(
      'invalid_trade_selection',
      `Select exactly ${room.tradeRatio} cards of the same rarity.`,
      { required: room.tradeRatio },
    );
  }

  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${room.id}, 0))`;

    const existing = await tx.draw.findUnique({
      where: { enrollmentId_idempotencyKey: { enrollmentId, idempotencyKey } },
      include: { card: true, items: true, trade: true },
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
        consumed: existing.trade?.consumedItems ?? [],
        replayed: true,
        educators: [] as string[],
      };
    }

    const items = await tx.inventoryItem.findMany({
      where: { id: { in: itemIds }, enrollmentId, roomId: room.id, state: 'owned' },
      include: { card: true },
    });

    if (items.length !== itemIds.length) {
      throw apiError('invalid_trade_selection', 'Those cards are not all in your collection.');
    }

    const fromRarity = items[0]!.card.rarity;
    if (!items.every((item) => item.card.rarity === fromRarity)) {
      throw apiError('invalid_trade_selection', 'All the cards must be the same rarity.');
    }

    const toRarity = RARITY_LADDER[fromRarity];
    if (!toRarity) {
      throw apiError('invalid_trade_selection', 'Legendary cards cannot be traded up.');
    }

    // Check the target has stock BEFORE surrendering anything, so a failed
    // trade never costs the student their three cards.
    const stock = await tx.$queryRaw<{ id: string; card_id: string; copies_remaining: number }[]>`
      SELECT rc.id, rc.card_id, rc.copies_remaining
        FROM room_cards rc JOIN cards c ON c.id = rc.card_id
       WHERE rc.room_id = ${room.id}::uuid AND c.rarity = ${toRarity}::"RarityCode"
         AND rc.copies_remaining > 0
       ORDER BY rc.id
    `;
    const poolSize = stock.reduce((sum, row) => sum + row.copies_remaining, 0);
    if (poolSize === 0) {
      throw apiError('target_rarity_empty', 'There are none of those left in the deck right now.', {
        rarity: toRarity,
      });
    }

    // Surrender the copies back to the deck. One statement for all of them:
    // the loop this replaces cost a round trip per card inside a transaction
    // Prisma abandons after five seconds, which is survivable next to the
    // database and not survivable across an ocean.
    //
    // Grouping by card id matters — trading three copies of the same card must
    // return three, not one — and `copies_remaining < copies_total` still
    // guards each row against exceeding what exists.
    await tx.inventoryItem.updateMany({
      where: { id: { in: itemIds } },
      data: { state: 'returned', returnedAt: new Date() },
    });
    await tx.$executeRaw`
      UPDATE room_cards rc
         SET copies_remaining = LEAST(rc.copies_total, rc.copies_remaining + back.n)
        FROM (
          SELECT card_id, COUNT(*)::int AS n
            FROM unnest(${items.map((item) => item.cardId)}::uuid[]) AS s(card_id)
           GROUP BY card_id
        ) AS back
       WHERE rc.room_id = ${room.id}::uuid
         AND rc.card_id = back.card_id
         AND rc.copies_remaining < rc.copies_total
    `;

    const roll = randomInt(poolSize);
    const picked = pickCopy(stock, roll);

    const consumed = await tx.$executeRaw`
      UPDATE room_cards SET copies_remaining = copies_remaining - 1
       WHERE id = ${picked.id}::uuid AND copies_remaining > 0
    `;
    if (consumed === 0) throw apiError('target_rarity_empty', 'That card was taken. Try again.');

    const card = await tx.card.findUniqueOrThrow({ where: { id: picked.card_id } });

    const snapshot = await tx.$queryRaw<{ rarity: RarityCode; n: number }[]>`
      SELECT c.rarity, SUM(rc.copies_remaining)::int AS n
        FROM room_cards rc JOIN cards c ON c.id = rc.card_id
       WHERE rc.room_id = ${room.id}::uuid GROUP BY c.rarity
    `;

    const draw = await tx.draw.create({
      data: {
        roomId: room.id,
        enrollmentId,
        kind: 'trade_upgrade',
        tokenCost: 0,
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

    await tx.trade.create({
      data: {
        drawId: draw.id,
        enrollmentId,
        fromRarity,
        toRarity,
        consumedItems: itemIds,
      },
    });

    const granted = await tx.inventoryItem.create({
      data: {
        enrollmentId,
        roomId: room.id,
        cardId: card.id,
        state: 'owned',
        acquiredVia: 'trade',
        drawId: draw.id,
      },
    });

    const event = await tx.activityEvent.create({
      data: {
        roomId: room.id,
        type: 'card.traded',
        actorUserId: actor.id,
        subjectEnrollmentId: enrollmentId,
        payload: {
          from_rarity: fromRarity,
          to_rarity: toRarity,
          card_id: card.id,
          card_name: card.name,
          gave_up: items.map((item) => item.card.name),
        },
      },
    });

    const educators = await roomEducatorIds(room.id, tx);
    await createNotifications(
      educators.map((userId) => ({
        recipientUserId: userId,
        roomId: room.id,
        activityEventId: event.id,
        type: 'card.traded' as const,
        payload: {
          student_name: actor.displayName,
          card_name: card.name,
          from_rarity: fromRarity,
          to_rarity: toRarity,
        },
      })),
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
      inventoryItemId: granted.id,
      consumed: itemIds,
      replayed: false,
      educators,
    };
  });

  if (!result.replayed) {
    const odds = await getDeckOdds(room);
    publishAfterCommit([
      ...result.educators.map((userId) => ({
        kind: 'notification' as const,
        userId,
        data: { type: 'card.traded', room_id: room.id, card_name: result.card.name },
      })),
      { kind: 'room.pool_changed' as const, roomId: room.id, data: { odds, cause: 'card.traded' } },
    ]);
    await evaluateLowStock(room.id).catch(() => undefined);
  }

  return {
    drawId: result.drawId,
    card: result.card,
    inventoryItemId: result.inventoryItemId,
    consumed: result.consumed,
    replayed: result.replayed,
  };
}

// ─── Educator: recent uses and acknowledgement ───────────────────────────────

export interface RecentUse {
  item_id: string;
  card_name: string;
  rarity: RarityCode;
  student_name: string;
  enrollment_id: string;
  used_at: string;
  note: string | null;
  acknowledged: boolean;
}

export async function listRecentUses(
  roomId: string,
  options: { unacknowledgedOnly?: boolean; limit?: number } = {},
): Promise<RecentUse[]> {
  // Was two serial queries — the uses, then which of them had been
  // acknowledged. The acknowledgement is a left join, so it costs nothing to
  // fetch alongside, and the room page waits on one round trip instead of two.
  const limit = Math.min(options.limit ?? 50, 200);

  const found = await prisma.$queryRaw<
    {
      item_id: string;
      card_name: string;
      rarity: RecentUse['rarity'];
      student_name: string;
      enrollment_id: string;
      used_at: Date;
      note: string | null;
      acknowledged: boolean;
    }[]
  >`
    SELECT i.id                                   AS item_id,
           c.name                                 AS card_name,
           -- ::text on purpose; see the note in decks.ts getDeckOdds.
           c.rarity::text                         AS rarity,
           u.display_name                         AS student_name,
           i.enrollment_id                        AS enrollment_id,
           COALESCE(i.used_at, i.acquired_at)     AS used_at,
           i.student_note                         AS note,
           (a.inventory_item_id IS NOT NULL)      AS acknowledged
      FROM inventory_items i
      JOIN cards c        ON c.id = i.card_id
      JOIN enrollments e  ON e.id = i.enrollment_id
      JOIN users u        ON u.id = e.student_id
      LEFT JOIN card_use_acknowledgements a ON a.inventory_item_id = i.id
     WHERE i.room_id = ${roomId}::uuid
       AND i.state = 'used'
     ORDER BY i.used_at DESC NULLS LAST
     LIMIT ${limit}
  `;

  const rows = found.map((row) => ({
    item_id: row.item_id,
    card_name: row.card_name,
    rarity: row.rarity,
    student_name: row.student_name,
    enrollment_id: row.enrollment_id,
    used_at: row.used_at.toISOString(),
    note: row.note,
    acknowledged: row.acknowledged,
  }));

  return options.unacknowledgedOnly ? rows.filter((row) => !row.acknowledged) : rows;
}

/**
 * Ticks off a use. Gates nothing — the card is already spent and back in the
 * deck — but it is how a teacher tracks which perks they still owe.
 */
export async function acknowledgeUse(
  actor: User,
  roomId: string,
  itemId: string,
  note?: string | null,
): Promise<void> {
  const item = await prisma.inventoryItem.findUnique({ where: { id: itemId } });
  if (!item || item.roomId !== roomId || item.state !== 'used') {
    throw apiError('not_found', 'Not found.');
  }

  await prisma.cardUseAcknowledgement.upsert({
    where: { inventoryItemId: itemId },
    create: { inventoryItemId: itemId, roomId, acknowledgedBy: actor.id, note: note?.trim() || null },
    update: { acknowledgedBy: actor.id, acknowledgedAt: new Date(), note: note?.trim() || null },
  });
}

/** The diagnostic for an empty circulating deck: who is holding what. */
export async function heldByStudent(roomId: string) {
  // Counting and then naming used to be two queries, and the second could not
  // start until the first came back. On the room page that serial pair was a
  // second round trip nobody needed — the join does both at once.
  const rows = await prisma.$queryRaw<
    { enrollment_id: string; student_name: string; held: number }[]
  >`
    SELECT i.enrollment_id            AS enrollment_id,
           u.display_name             AS student_name,
           COUNT(*)::int              AS held
      FROM inventory_items i
      JOIN enrollments e ON e.id = i.enrollment_id
      JOIN users u       ON u.id = e.student_id
     WHERE i.room_id = ${roomId}::uuid
       AND i.state = 'owned'
     GROUP BY i.enrollment_id, u.display_name
     ORDER BY held DESC
  `;

  return rows.map((row) => ({
    enrollment_id: row.enrollment_id,
    student_name: row.student_name,
    held: row.held,
  }));
}

// ─── Educator view of every hand ─────────────────────────────────────────────

export interface HeldCardStack {
  card_id: string;
  card_name: string;
  rarity: RarityCode;
  count: number;
  item_ids: string[];
}

export interface StudentHand {
  enrollment_id: string;
  student_name: string;
  login_id: string | null;
  token_balance: number;
  held: number;
  stacks: HeldCardStack[];
}

/**
 * Who is holding what, for the whole room.
 *
 * `heldByStudent` answers only "how many", which is enough for the deck summary
 * and useless for the question an educator actually asks — *which* card is
 * sitting in someone's hand. This returns the cards themselves, in one query,
 * grouped in memory rather than with a query per student.
 *
 * Every active student appears, including those holding nothing, because "who
 * has drawn nothing yet" is as much a teaching signal as who is hoarding.
 */
export async function handsByStudent(roomId: string): Promise<StudentHand[]> {
  const [enrollments, rows] = await Promise.all([
    prisma.enrollment.findMany({
      where: { roomId, status: 'active' },
      select: {
        id: true,
        tokenBalance: true,
        student: { select: { displayName: true, loginId: true } },
      },
    }),
    prisma.$queryRaw<
      {
        enrollment_id: string;
        card_id: string;
        card_name: string;
        rarity: RarityCode;
        item_ids: string[];
      }[]
    >`
      SELECT i.enrollment_id            AS enrollment_id,
             i.card_id                  AS card_id,
             c.name                     AS card_name,
             c.rarity::text             AS rarity,
             array_agg(i.id ORDER BY i.acquired_at) AS item_ids
        FROM inventory_items i
        JOIN cards c ON c.id = i.card_id
       WHERE i.room_id = ${roomId}::uuid
         AND i.state = 'owned'
       GROUP BY i.enrollment_id, i.card_id, c.name, c.rarity
       ORDER BY c.rarity, c.name
    `,
  ]);

  const stacksFor = new Map<string, HeldCardStack[]>();
  for (const row of rows) {
    const list = stacksFor.get(row.enrollment_id) ?? [];
    list.push({
      card_id: row.card_id,
      card_name: row.card_name,
      rarity: row.rarity,
      count: row.item_ids.length,
      item_ids: row.item_ids,
    });
    stacksFor.set(row.enrollment_id, list);
  }

  return enrollments
    .map((enrollment) => {
      const stacks = stacksFor.get(enrollment.id) ?? [];
      return {
        enrollment_id: enrollment.id,
        student_name: enrollment.student.displayName,
        login_id: enrollment.student.loginId,
        token_balance: enrollment.tokenBalance,
        held: stacks.reduce((sum, stack) => sum + stack.count, 0),
        stacks,
      };
    })
    .sort((a, b) => b.held - a.held || a.student_name.localeCompare(b.student_name));
}

/**
 * Give a specific card to a specific student, taking the copy out of the deck.
 *
 * The deck is finite and conserved, so this is a move rather than a creation:
 * it fails when no copy is free rather than minting one, which is what keeps
 * `copies_total = in deck + held` true. It is the counterpart to taking a card
 * back, and exists for the ordinary classroom cases a draw cannot express — a
 * prize, a correction, a card handed out for something done offline.
 */
export async function grantCard(
  actor: User,
  room: Room,
  enrollmentId: string,
  cardId: string,
): Promise<{ itemId: string; card: CardSummary }> {
  if (room.status === 'archived') {
    throw apiError('room_archived', 'This room has been archived.');
  }

  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${room.id}, 0))`;

    const enrollment = await tx.enrollment.findFirst({
      where: { id: enrollmentId, roomId: room.id, status: 'active' },
    });
    if (!enrollment) throw apiError('not_found', 'That student is not in this room.');

    // Conditional on a copy being free, so two educators granting the last one
    // cannot both succeed.
    const taken = await tx.$executeRaw`
      UPDATE room_cards
         SET copies_remaining = copies_remaining - 1
       WHERE room_id = ${room.id}::uuid
         AND card_id = ${cardId}::uuid
         AND copies_remaining > 0
    `;
    if (taken === 0) {
      throw apiError('pool_empty', 'There are no copies of that card left in the deck.');
    }

    const card = await tx.card.findUniqueOrThrow({ where: { id: cardId } });

    const item = await tx.inventoryItem.create({
      data: {
        enrollmentId,
        roomId: room.id,
        cardId,
        state: 'owned',
        acquiredVia: 'educator_grant',
      },
    });

    const event = await tx.activityEvent.create({
      data: {
        roomId: room.id,
        type: 'card.granted',
        actorUserId: actor.id,
        subjectEnrollmentId: enrollmentId,
        payload: { card_id: card.id, card_name: card.name, rarity: card.rarity },
      },
    });

    return {
      itemId: item.id,
      card: {
        id: card.id,
        name: card.name,
        rarity: card.rarity,
        effect_text: card.effectText,
        image_url: cardImageUrl(card.imageKey),
      },
      eventId: event.id,
    };
  });

  const odds = await getDeckOdds(room);
  publishAfterCommit([
    { kind: 'room.pool_changed', roomId: room.id, data: { odds, cause: 'card.granted' } },
  ]);
  await evaluateLowStock(room.id).catch(() => undefined);

  return { itemId: result.itemId, card: result.card };
}

/**
 * Take a card out of a student's hand and put the copy back in the deck.
 *
 * Deliberately separate from the student's own `returnCard`: this one is scoped
 * by room rather than by enrolment, because an educator acts on any hand in the
 * room, and it records who did it so the student's history shows the card was
 * taken rather than given up.
 */
export async function revokeCard(
  actor: User,
  room: Room,
  itemId: string,
): Promise<{ itemId: string; card: CardSummary }> {
  if (room.status === 'archived') {
    throw apiError('room_archived', 'This room has been archived.');
  }

  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${room.id}, 0))`;

    const item = await tx.inventoryItem.findUnique({
      where: { id: itemId },
      include: { card: true },
    });
    if (!item || item.roomId !== room.id) {
      throw apiError('not_found', 'That card is not in this room.');
    }

    const claimed = await tx.inventoryItem.updateMany({
      where: { id: itemId, state: 'owned' },
      data: { state: 'revoked', returnedAt: new Date() },
    });
    if (claimed.count === 0) {
      throw apiError('item_state_conflict', 'That card is no longer in their collection.');
    }

    await returnCopyToDeck(tx, room.id, item.cardId);

    const event = await tx.activityEvent.create({
      data: {
        roomId: room.id,
        type: 'card.revoked',
        actorUserId: actor.id,
        subjectEnrollmentId: item.enrollmentId,
        payload: { card_id: item.cardId, card_name: item.card.name, rarity: item.card.rarity },
      },
    });

    return {
      itemId,
      card: {
        id: item.card.id,
        name: item.card.name,
        rarity: item.card.rarity,
        effect_text: item.card.effectText,
        image_url: cardImageUrl(item.card.imageKey),
      },
      eventId: event.id,
    };
  });

  const odds = await getDeckOdds(room);
  publishAfterCommit([
    { kind: 'room.pool_changed', roomId: room.id, data: { odds, cause: 'card.revoked' } },
  ]);

  return { itemId: result.itemId, card: result.card };
}
