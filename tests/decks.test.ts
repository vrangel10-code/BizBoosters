import { beforeEach, afterAll, describe, expect, it } from 'vitest';
import type { Room, School, User } from '@prisma/client';
import { prisma, resetDatabase, createSchool, seedUser } from './helpers';
import { createRoom } from '../src/server/services/rooms';
import { createCard, listCards, updateCard, archiveCard } from '../src/server/services/cards';
import {
  evaluateLowStock,
  getDeck,
  getDeckOdds,
  resetDeck,
  setDeck,
} from '../src/server/services/decks';
import { ApiError } from '../src/server/errors';

let school: School;
let educator: User;
let room: Room;

const expectApiError = async (promise: Promise<unknown>, code: string) => {
  await expect(promise).rejects.toSatisfy(
    (error: unknown) => error instanceof ApiError && error.code === code,
    `expected ApiError with code "${code}"`,
  );
};

beforeEach(async () => {
  await resetDatabase();
  school = await createSchool();
  educator = await seedUser({
    schoolId: school.id,
    role: 'educator',
    email: 'sam@school.edu',
    password: 'correct-horse-battery',
  });
  room = await createRoom({ actor: educator, schoolId: school.id, name: 'Enterprise 7B' });
});

afterAll(async () => {
  await prisma.$disconnect();
});

const card = (name: string, rarity: 'C' | 'U' | 'R' | 'L' = 'C') =>
  createCard({ actor: educator, schoolId: school.id, name, rarity });

/**
 * The invariant the circulating-deck model rests on: every copy is either in
 * the deck or in exactly one student's hand. No third bucket.
 */
const expectConservation = async () => {
  const rows = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM room_cards WHERE copies_remaining > copies_total OR copies_remaining < 0
  `;
  expect(Number(rows[0]?.n ?? 0)).toBe(0);
};

/** Simulates students holding copies, which phase 3 will do for real. */
const holdCopies = async (cardId: string, count: number) => {
  await prisma.roomCard.updateMany({
    where: { roomId: room.id, cardId },
    data: { copiesRemaining: { decrement: count } },
  });
};

describe('card catalog', () => {
  it('requires a name and rejects duplicates within a school', async () => {
    await card('Cashflow Boost');
    await expectApiError(card('Cashflow Boost'), 'card_name_in_use');
    await expectApiError(card('   '), 'validation_failed');
  });

  it('lets the same name exist at a different school', async () => {
    const other = await createSchool('Southgate High');
    const otherEducator = await seedUser({
      schoolId: other.id,
      role: 'educator',
      email: 'other@southgate.edu',
      password: 'correct-horse-battery',
    });

    await card('Cashflow Boost');
    await expect(
      createCard({
        actor: otherEducator,
        schoolId: other.id,
        name: 'Cashflow Boost',
        rarity: 'C',
      }),
    ).resolves.toBeTruthy();
  });

  it('allows renaming at any time', async () => {
    const created = await card('Cashflo Bost');
    const renamed = await updateCard({ actor: educator, cardId: created.id, name: 'Cashflow Boost' });
    expect(renamed.name).toBe('Cashflow Boost');
  });

  it('locks rarity once the card is in a live deck', async () => {
    const created = await card('Cashflow Boost', 'C');

    // Free to change while unused...
    await expect(
      updateCard({ actor: educator, cardId: created.id, rarity: 'R' }),
    ).resolves.toBeTruthy();

    await setDeck(educator, room, [{ card_id: created.id, copies_total: 10 }]);

    // ...but not once it is dropping, which would move copies between rarity
    // buckets and shift everyone's odds mid-term.
    await expectApiError(
      updateCard({ actor: educator, cardId: created.id, rarity: 'L' }),
      'rarity_locked',
    );
    // Renaming stays allowed.
    await expect(
      updateCard({ actor: educator, cardId: created.id, name: 'Cashflow Surge' }),
    ).resolves.toBeTruthy();
  });

  it('hides archived cards from the catalog but leaves decks alone', async () => {
    const created = await card('Cashflow Boost');
    await setDeck(educator, room, [{ card_id: created.id, copies_total: 5 }]);

    await archiveCard(educator, created.id);

    expect(await listCards(school.id)).toHaveLength(0);
    expect(await listCards(school.id, { includeArchived: true })).toHaveLength(1);
    expect(await getDeck(room.id)).toHaveLength(1);
  });

  it('refuses to touch another school’s card', async () => {
    const other = await createSchool('Southgate High');
    const otherEducator = await seedUser({
      schoolId: other.id,
      role: 'educator',
      email: 'other@southgate.edu',
      password: 'correct-horse-battery',
    });
    const created = await card('Cashflow Boost');

    await expectApiError(
      updateCard({ actor: otherEducator, cardId: created.id, name: 'Stolen' }),
      'not_found',
    );
  });
});

describe('setDeck', () => {
  it('starts a new card fully in the deck', async () => {
    const created = await card('Cashflow Boost');
    const result = await setDeck(educator, room, [{ card_id: created.id, copies_total: 10 }]);

    expect(result.applied[0]).toMatchObject({ copies_total: 10, in_deck: 10 });
    await expectConservation();
  });

  it('moves the deck count by the same delta as the total', async () => {
    const created = await card('Cashflow Boost');
    await setDeck(educator, room, [{ card_id: created.id, copies_total: 10 }]);
    await holdCopies(created.id, 4); // students now hold 4

    await setDeck(educator, room, [{ card_id: created.id, copies_total: 12 }]);

    const [entry] = await getDeck(room.id);
    // +2 to the total means +2 in the deck, not a refill to 12.
    expect(entry).toMatchObject({ copies_total: 12, in_deck: 8, held: 4 });
    await expectConservation();
  });

  it('never refills held copies back into the deck', async () => {
    const created = await card('Cashflow Boost');
    await setDeck(educator, room, [{ card_id: created.id, copies_total: 10 }]);
    await holdCopies(created.id, 6);

    // Re-submitting the same total must be a no-op, not a refill. A refill here
    // would mint 6 copies from nothing and break conservation forever.
    await setDeck(educator, room, [{ card_id: created.id, copies_total: 10 }]);

    const [entry] = await getDeck(room.id);
    expect(entry).toMatchObject({ copies_total: 10, in_deck: 4, held: 6 });
    await expectConservation();
  });

  it('reduces the deck when the total drops', async () => {
    const created = await card('Cashflow Boost');
    await setDeck(educator, room, [{ card_id: created.id, copies_total: 10 }]);
    await holdCopies(created.id, 2);

    await setDeck(educator, room, [{ card_id: created.id, copies_total: 6 }]);

    const [entry] = await getDeck(room.id);
    expect(entry).toMatchObject({ copies_total: 6, in_deck: 4, held: 2 });
    await expectConservation();
  });

  it('caps a reduction at what students already hold, and says so', async () => {
    const created = await card('Cashflow Boost');
    await setDeck(educator, room, [{ card_id: created.id, copies_total: 10 }]);
    await holdCopies(created.id, 7);

    const result = await setDeck(educator, room, [{ card_id: created.id, copies_total: 2 }]);

    // Reaching into a student's hand is not an option, so the request is capped
    // and reported rather than silently obeyed.
    expect(result.capped).toEqual([
      { card_id: created.id, requested: 2, applied: 7, held: 7 },
    ]);
    const [entry] = await getDeck(room.id);
    expect(entry).toMatchObject({ copies_total: 7, in_deck: 0, held: 7 });
    await expectConservation();
  });

  it('removes an omitted card outright when nobody holds it', async () => {
    const keep = await card('Cashflow Boost');
    const drop = await card('Snack Rush');
    await setDeck(educator, room, [
      { card_id: keep.id, copies_total: 5 },
      { card_id: drop.id, copies_total: 5 },
    ]);

    await setDeck(educator, room, [{ card_id: keep.id, copies_total: 5 }]);

    const deck = await getDeck(room.id);
    expect(deck.map((entry) => entry.card_id)).toEqual([keep.id]);
  });

  it('keeps an omitted card at zero when students still hold copies', async () => {
    const keep = await card('Cashflow Boost');
    const drop = await card('Snack Rush');
    await setDeck(educator, room, [
      { card_id: keep.id, copies_total: 5 },
      { card_id: drop.id, copies_total: 5 },
    ]);
    await holdCopies(drop.id, 3);

    await setDeck(educator, room, [{ card_id: keep.id, copies_total: 5 }]);

    const dropped = (await getDeck(room.id)).find((entry) => entry.card_id === drop.id);
    // It stops dropping, and the copies in hands leave circulation as they are
    // used — rather than vanishing from a student's inventory.
    expect(dropped).toMatchObject({ copies_total: 3, in_deck: 0, held: 3 });
    await expectConservation();
  });

  it('rejects a duplicate card in one request', async () => {
    const created = await card('Cashflow Boost');
    await expectApiError(
      setDeck(educator, room, [
        { card_id: created.id, copies_total: 5 },
        { card_id: created.id, copies_total: 7 },
      ]),
      'validation_failed',
    );
  });

  it('rejects a card from another school', async () => {
    const other = await createSchool('Southgate High');
    const otherEducator = await seedUser({
      schoolId: other.id,
      role: 'educator',
      email: 'other@southgate.edu',
      password: 'correct-horse-battery',
    });
    const foreign = await createCard({
      actor: otherEducator,
      schoolId: other.id,
      name: 'Foreign Card',
      rarity: 'C',
    });

    await expectApiError(
      setDeck(educator, room, [{ card_id: foreign.id, copies_total: 5 }]),
      'not_found',
    );
  });

  it('rejects an empty deck', async () => {
    await expectApiError(setDeck(educator, room, []), 'validation_failed');
  });
});

describe('odds', () => {
  /** The prototype's deck: 6 C x10, 6 U x5, 5 R x2, 3 L x1 = 103 copies. */
  const buildPrototypeDeck = async () => {
    const entries: { card_id: string; copies_total: number }[] = [];
    const spec: [('C' | 'U' | 'R' | 'L'), number, number][] = [
      ['C', 6, 10],
      ['U', 6, 5],
      ['R', 5, 2],
      ['L', 3, 1],
    ];
    for (const [rarity, count, copies] of spec) {
      for (let i = 0; i < count; i += 1) {
        const created = await card(`${rarity}${i}`, rarity);
        entries.push({ card_id: created.id, copies_total: copies });
      }
    }
    await setDeck(educator, room, entries);
  };

  it('reproduces the prototype’s starting odds', async () => {
    await buildPrototypeDeck();
    const odds = await getDeckOdds(room);

    expect(odds.total).toBe(103);
    expect(odds.in_deck).toBe(103);
    expect(odds.held).toBe(0);

    const chance = (code: string) =>
      Number((odds.rarities.find((r) => r.code === code)!.chance * 100).toFixed(1));

    expect(chance('C')).toBe(58.3);
    expect(chance('U')).toBe(29.1);
    expect(chance('R')).toBe(9.7);
    expect(chance('L')).toBe(2.9);
  });

  it('shifts as copies leave the deck, and counts them as held', async () => {
    await buildPrototypeDeck();
    const legendary = await prisma.card.findFirstOrThrow({
      where: { schoolId: school.id, rarity: 'L' },
    });
    await holdCopies(legendary.id, 1);

    const odds = await getDeckOdds(room);
    expect(odds.in_deck).toBe(102);
    expect(odds.held).toBe(1);
    expect(odds.total).toBe(103);
    // Total is unchanged — the copy moved, it was not consumed.
    expect(odds.rarities.find((r) => r.code === 'L')!.in_deck).toBe(2);
    expect(odds.rarities.find((r) => r.code === 'L')!.total).toBe(3);
  });

  it('reports zero chances rather than dividing by zero on an empty deck', async () => {
    const created = await card('Cashflow Boost');
    await setDeck(educator, room, [{ card_id: created.id, copies_total: 4 }]);
    await holdCopies(created.id, 4);

    const odds = await getDeckOdds(room);
    expect(odds.is_empty).toBe(true);
    expect(odds.rarities.every((r) => r.chance === 0)).toBe(true);
    // With a circulating deck, empty means hoarded — the number that explains it.
    expect(odds.held).toBe(4);
  });

  it('sums each rarity’s chances to 1 while the deck has cards', async () => {
    await buildPrototypeDeck();
    const odds = await getDeckOdds(room);
    const total = odds.rarities.reduce((sum, r) => sum + r.chance, 0);
    expect(total).toBeCloseTo(1, 10);
  });
});

describe('resetDeck', () => {
  it('requires the room name typed exactly', async () => {
    const created = await card('Cashflow Boost');
    await setDeck(educator, room, [{ card_id: created.id, copies_total: 10 }]);

    await expectApiError(resetDeck(educator, room, 'yes'), 'confirmation_required');
    await expectApiError(resetDeck(educator, room, 'enterprise 7b'), 'confirmation_required');
  });

  it('refills every card and returns held copies in one step', async () => {
    const first = await card('Cashflow Boost');
    const second = await card('Snack Rush', 'U');
    await setDeck(educator, room, [
      { card_id: first.id, copies_total: 10 },
      { card_id: second.id, copies_total: 5 },
    ]);
    await holdCopies(first.id, 7);
    await holdCopies(second.id, 2);

    const result = await resetDeck(educator, room, 'Enterprise 7B');

    expect(result.copiesReturned).toBe(9);

    const deck = await getDeck(room.id);
    // Refill and clear-hands together land on held = 0, remaining = total, so
    // conservation holds by construction. Refill alone would mint 9 copies.
    expect(deck.every((entry) => entry.in_deck === entry.copies_total)).toBe(true);
    expect(deck.every((entry) => entry.held === 0)).toBe(true);
    await expectConservation();
  });

  it('re-arms the low-stock alert', async () => {
    const created = await card('Cashflow Boost');
    await setDeck(educator, room, [{ card_id: created.id, copies_total: 10 }]);
    await evaluateLowStock(room.id);

    expect((await prisma.room.findUniqueOrThrow({ where: { id: room.id } })).lowStockAlerted).toBe(
      true,
    );

    await resetDeck(educator, room, 'Enterprise 7B');
    expect((await prisma.room.findUniqueOrThrow({ where: { id: room.id } })).lowStockAlerted).toBe(
      false,
    );
  });
});

describe('low-stock alerting', () => {
  const deckOf = async (copies: number) => {
    const created = await card(`Deck of ${copies}`);
    await setDeck(educator, room, [{ card_id: created.id, copies_total: copies }]);
    return created;
  };

  it('stays quiet above the threshold', async () => {
    await deckOf(50);
    await evaluateLowStock(room.id);

    const events = await prisma.activityEvent.findMany({
      where: { roomId: room.id, type: { in: ['pool.low', 'pool.empty'] } },
    });
    expect(events).toHaveLength(0);
  });

  it('fires once when the deck crosses the threshold, not on every check', async () => {
    const created = await deckOf(50);
    await setDeck(educator, room, [{ card_id: created.id, copies_total: 18 }]);

    // A room hovering at the threshold would otherwise send a notification per
    // draw, which is how alerting becomes noise people ignore.
    await evaluateLowStock(room.id);
    await evaluateLowStock(room.id);
    await evaluateLowStock(room.id);

    const events = await prisma.activityEvent.findMany({
      where: { roomId: room.id, type: 'pool.low' },
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ in_deck: 18, threshold: 20 });
  });

  it('re-arms only after the deck climbs clear of the hysteresis band', async () => {
    const created = await deckOf(50);
    await setDeck(educator, room, [{ card_id: created.id, copies_total: 18 }]);
    await evaluateLowStock(room.id);

    // Just above the threshold is inside the band: still armed, no re-fire.
    await setDeck(educator, room, [{ card_id: created.id, copies_total: 23 }]);
    await evaluateLowStock(room.id);
    expect((await prisma.room.findUniqueOrThrow({ where: { id: room.id } })).lowStockAlerted).toBe(
      true,
    );

    // Clear of the band: re-armed.
    await setDeck(educator, room, [{ card_id: created.id, copies_total: 40 }]);
    await evaluateLowStock(room.id);
    expect((await prisma.room.findUniqueOrThrow({ where: { id: room.id } })).lowStockAlerted).toBe(
      false,
    );

    // And it can fire again on the next descent.
    await setDeck(educator, room, [{ card_id: created.id, copies_total: 10 }]);
    await evaluateLowStock(room.id);
    expect(
      await prisma.activityEvent.count({ where: { roomId: room.id, type: 'pool.low' } }),
    ).toBe(2);
  });

  it('reports an empty deck distinctly from a low one', async () => {
    const created = await deckOf(30);
    await holdCopies(created.id, 30);
    await evaluateLowStock(room.id);

    const events = await prisma.activityEvent.findMany({
      where: { roomId: room.id, type: 'pool.empty' },
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ in_deck: 0, held: 30 });
  });

  it('says nothing about a room with no deck at all', async () => {
    await evaluateLowStock(room.id);
    expect(
      await prisma.activityEvent.count({
        where: { roomId: room.id, type: { in: ['pool.low', 'pool.empty'] } },
      }),
    ).toBe(0);
  });
});

describe('database constraints', () => {
  it('refuses to put more copies in the deck than exist', async () => {
    const created = await card('Cashflow Boost');
    await setDeck(educator, room, [{ card_id: created.id, copies_total: 5 }]);

    // The last line of defence against a future code path that returns a copy
    // twice — which is exactly how a circulating deck silently inflates.
    await expect(
      prisma.roomCard.updateMany({
        where: { roomId: room.id, cardId: created.id },
        data: { copiesRemaining: 6 },
      }),
    ).rejects.toThrow();
  });

  it('refuses a negative deck count', async () => {
    const created = await card('Cashflow Boost');
    await setDeck(educator, room, [{ card_id: created.id, copies_total: 5 }]);

    await expect(
      prisma.roomCard.updateMany({
        where: { roomId: room.id, cardId: created.id },
        data: { copiesRemaining: -1 },
      }),
    ).rejects.toThrow();
  });
});
