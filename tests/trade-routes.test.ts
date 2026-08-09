import { randomUUID } from 'node:crypto';
import { beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import type { School } from '@prisma/client';

const jar = new Map<string, string>();

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = jar.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set: (name: string, value: string) => {
      if (value === '') jar.delete(name);
      else jar.set(name, value);
    },
    delete: (name: string) => jar.delete(name),
  }),
}));

const { prisma, resetDatabase, createSchool, seedUser, testIp } = await import('./helpers');
const { createRoom } = await import('../src/server/services/rooms');
const { createCard } = await import('../src/server/services/cards');
const { setDeck } = await import('../src/server/services/decks');
const { createAndEnrollStudent } = await import('../src/server/services/roster');
const { POST: loginRoute } = await import('../src/app/api/v1/auth/login/route');
const { POST: changePasswordRoute } = await import(
  '../src/app/api/v1/auth/change-password/route'
);
const { POST: tradeRoute } = await import('../src/app/api/v1/rooms/[roomId]/trades/route');

let school: School;

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('http://localhost/api/v1/x', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.10', ...headers },
    body: JSON.stringify(body),
  });

const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });

const read = async (response: Response) => ({
  status: response.status,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: ((await response.json().catch(() => ({}))) ?? {}) as any,
});

beforeEach(async () => {
  jar.clear();
  await resetDatabase();
  school = await createSchool();
});

afterAll(async () => {
  await prisma.$disconnect();
});

/**
 * A room holding three commons and one uncommon, with the three commons dealt
 * into a signed-in student's hand — the exact state a student is in when they
 * press "trade up".
 */
async function setup({ uncommonCopies = 2 } = {}) {
  const educator = await seedUser({
    schoolId: school.id,
    role: 'educator',
    email: 'sam@school.edu',
    password: 'correct-horse-battery',
  });
  const room = await createRoom({ actor: educator, schoolId: school.id, name: 'Enterprise 7B' });

  const common = await createCard({
    actor: educator,
    schoolId: school.id,
    name: 'Snack Rush',
    rarity: 'C',
  });
  const uncommon = await createCard({
    actor: educator,
    schoolId: school.id,
    name: 'Market Insider',
    rarity: 'U',
  });
  await setDeck(educator, room, [
    { card_id: common.id, copies_total: 6 },
    { card_id: uncommon.id, copies_total: uncommonCopies },
  ]);

  const student = await createAndEnrollStudent({
    actor: educator,
    schoolId: school.id,
    roomId: room.id,
    displayName: 'Aisha Tan',
    ip: testIp,
  });

  // Deal three commons out of the deck by hand, so the test is about trading
  // rather than about drawing.
  const items = [];
  for (let i = 0; i < 3; i += 1) {
    items.push(
      await prisma.inventoryItem.create({
        data: {
          enrollmentId: student.enrollmentId,
          roomId: room.id,
          cardId: common.id,
          state: 'owned',
          acquiredVia: 'draw',
        },
      }),
    );
  }
  await prisma.roomCard.updateMany({
    where: { roomId: room.id, cardId: common.id },
    data: { copiesRemaining: 3 },
  });

  await read(await loginRoute(post({ identifier: student.loginId, password: student.defaultPassword })));
  await changePasswordRoute(
    post({ current_password: student.defaultPassword, new_password: 'aisha-picks-this' }),
  );

  return { room, student, itemIds: items.map((item) => item.id) };
}

/** Same idea as `setup`, but the student holds three *distinct* commons. */
async function setupDistinct() {
  const educator = await seedUser({
    schoolId: school.id,
    role: 'educator',
    email: 'sam@school.edu',
    password: 'correct-horse-battery',
  });
  const room = await createRoom({ actor: educator, schoolId: school.id, name: 'Enterprise 7B' });

  const commons = [];
  for (const name of ['Snack Rush', 'Express Shipping', 'Time Extension']) {
    commons.push(
      await createCard({ actor: educator, schoolId: school.id, name, rarity: 'C' }),
    );
  }
  const uncommon = await createCard({
    actor: educator,
    schoolId: school.id,
    name: 'Market Insider',
    rarity: 'U',
  });
  await setDeck(educator, room, [
    ...commons.map((card) => ({ card_id: card.id, copies_total: 1 })),
    { card_id: uncommon.id, copies_total: 1 },
  ]);

  const student = await createAndEnrollStudent({
    actor: educator,
    schoolId: school.id,
    roomId: room.id,
    displayName: 'Aisha Tan',
    ip: testIp,
  });

  for (const card of commons) {
    await prisma.inventoryItem.create({
      data: {
        enrollmentId: student.enrollmentId,
        roomId: room.id,
        cardId: card.id,
        state: 'owned',
        acquiredVia: 'draw',
      },
    });
    await prisma.roomCard.updateMany({
      where: { roomId: room.id, cardId: card.id },
      data: { copiesRemaining: 0 },
    });
  }

  await read(
    await loginRoute(post({ identifier: student.loginId, password: student.defaultPassword })),
  );
  await changePasswordRoute(
    post({ current_password: student.defaultPassword, new_password: 'aisha-picks-this' }),
  );

  return { room, student, educator };
}

describe('POST /rooms/:roomId/trades', () => {
  it('trades three commons for an uncommon', async () => {
    const { room, itemIds } = await setup();

    const response = await read(
      await tradeRoute(
        post({ item_ids: itemIds }, { 'idempotency-key': randomUUID() }),
        params({ roomId: room.id }),
      ),
    );

    expect(response.status).toBe(200);
    expect(response.body.card.rarity).toBe('U');
    expect(response.body.consumed).toEqual(itemIds);
  });

  /**
   * Conservation across a trade: three copies go back into the deck and one
   * comes out, so the room's totals must be unchanged and `in_deck` up by two.
   */
  it('returns every surrendered copy to the deck', async () => {
    const { room, itemIds } = await setup();

    await tradeRoute(
      post({ item_ids: itemIds }, { 'idempotency-key': randomUUID() }),
      params({ roomId: room.id }),
    );

    const rows = await prisma.roomCard.findMany({ where: { roomId: room.id } });
    const total = rows.reduce((sum, row) => sum + row.copiesTotal, 0);
    const inDeck = rows.reduce((sum, row) => sum + row.copiesRemaining, 0);

    expect(total).toBe(8);
    // Started with 5 in the deck (3 commons + 2 uncommons); +3 back, −1 taken.
    expect(inDeck).toBe(7);
  });

  /**
   * The three surrendered cards are usually three *different* commons, not
   * three copies of one. The single statement that returns them groups by card
   * id, so this is the case that would break if that grouping were wrong.
   */
  it('returns copies correctly when the three cards are all different', async () => {
    const { room, student, educator } = await setupDistinct();

    const items = await prisma.inventoryItem.findMany({
      where: { enrollmentId: student.enrollmentId, state: 'owned' },
    });
    expect(items).toHaveLength(3);

    const response = await read(
      await tradeRoute(
        post({ item_ids: items.map((i) => i.id) }, { 'idempotency-key': randomUUID() }),
        params({ roomId: room.id }),
      ),
    );
    expect(response.status).toBe(200);

    const rows = await prisma.roomCard.findMany({ where: { roomId: room.id } });
    for (const row of rows) {
      expect(row.copiesRemaining).toBeLessThanOrEqual(row.copiesTotal);
    }
    // Each of the three distinct commons is back to full, and one uncommon left.
    const commons = rows.filter((row) => row.copiesTotal === 1 && row.copiesRemaining === 1);
    expect(commons).toHaveLength(3);
    expect(educator).toBeTruthy();
  });

  it('rejects a request with no idempotency key', async () => {
    const { room, itemIds } = await setup();

    const response = await read(
      await tradeRoute(post({ item_ids: itemIds }), params({ roomId: room.id })),
    );

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('validation_failed');
  });

  it('replays rather than trading twice for a repeated key', async () => {
    const { room, itemIds } = await setup();
    const key = randomUUID();

    const first = await read(
      await tradeRoute(post({ item_ids: itemIds }, { 'idempotency-key': key }), params({ roomId: room.id })),
    );
    const second = await read(
      await tradeRoute(post({ item_ids: itemIds }, { 'idempotency-key': key }), params({ roomId: room.id })),
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.draw.replayed).toBe(true);
    expect(await prisma.trade.count()).toBe(1);
  });

  /** The student must keep their cards when the target rarity is exhausted. */
  it('refuses cleanly when nothing of the next rarity is left', async () => {
    const { room, itemIds } = await setup({ uncommonCopies: 0 });

    const response = await read(
      await tradeRoute(
        post({ item_ids: itemIds }, { 'idempotency-key': randomUUID() }),
        params({ roomId: room.id }),
      ),
    );

    expect(response.status).toBeLessThan(500);
    expect(response.body.error.code).toBe('target_rarity_empty');

    const stillOwned = await prisma.inventoryItem.count({
      where: { id: { in: itemIds }, state: 'owned' },
    });
    expect(stillOwned).toBe(3);
  });
});
