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
const { awardTokens } = await import('../src/server/services/tokens');
const { POST: loginRoute } = await import('../src/app/api/v1/auth/login/route');
const { POST: changePasswordRoute } = await import(
  '../src/app/api/v1/auth/change-password/route'
);
const { POST: drawRoute } = await import('../src/app/api/v1/rooms/[roomId]/draws/route');
const { GET: inventoryRoute } = await import(
  '../src/app/api/v1/rooms/[roomId]/inventory/route'
);

let school: School;

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('http://localhost/api/v1/x', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.10', ...headers },
    body: JSON.stringify(body),
  });

const get = (query = '') =>
  new Request(`http://localhost/api/v1/x${query}`, {
    headers: { 'x-forwarded-for': '203.0.113.10' },
  });

const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });

interface Envelope {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

const read = async (response: Response): Promise<Envelope> => ({
  status: response.status,
  body: ((await response.json().catch(() => ({}))) ?? {}) as Envelope['body'],
});

const signInAs = async (identifier: string, password: string) => {
  jar.clear();
  return read(await loginRoute(post({ identifier, password })));
};

beforeEach(async () => {
  jar.clear();
  await resetDatabase();
  school = await createSchool();
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** A room with a stocked deck and one student past their first-login gate. */
async function setup({ copies = 5, tokens = 100 } = {}) {
  const educator = await seedUser({
    schoolId: school.id,
    role: 'educator',
    email: 'sam@school.edu',
    password: 'correct-horse-battery',
  });
  const room = await createRoom({ actor: educator, schoolId: school.id, name: 'Enterprise 7B' });

  const card = await createCard({
    actor: educator,
    schoolId: school.id,
    name: 'Cashflow Boost',
    rarity: 'C',
  });
  await setDeck(educator, room, [{ card_id: card.id, copies_total: copies }]);

  const student = await createAndEnrollStudent({
    actor: educator,
    schoolId: school.id,
    roomId: room.id,
    displayName: 'Aisha Tan',
    ip: testIp,
  });
  if (tokens > 0) {
    await awardTokens({
      actor: educator,
      roomId: room.id,
      enrollmentIds: [student.enrollmentId],
      amount: tokens,
    });
  }

  await signInAs(student.loginId, student.defaultPassword);
  await changePasswordRoute(
    post({ current_password: student.defaultPassword, new_password: 'aisha-picks-this' }),
  );

  return { room, student, educator, password: 'aisha-picks-this' };
}

describe('POST /rooms/:roomId/draws', () => {
  it('draws a card and returns the new balance and odds', async () => {
    const { room } = await setup();

    const response = await read(
      await drawRoute(post({}, { 'idempotency-key': randomUUID() }), params({ roomId: room.id })),
    );

    expect(response.status).toBe(200);
    expect(response.body.card.name).toBe('Cashflow Boost');
    expect(response.body.token_balance).toBe(80);
    expect(response.body.odds.in_deck).toBe(4);
    expect(response.body.odds.held).toBe(1);
  });

  it('requires an idempotency key', async () => {
    const { room } = await setup();

    const response = await read(await drawRoute(post({}), params({ roomId: room.id })));

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('validation_failed');
  });

  it('replays the same card for a repeated key', async () => {
    const { room } = await setup();
    const key = randomUUID();

    const first = await read(
      await drawRoute(post({}, { 'idempotency-key': key }), params({ roomId: room.id })),
    );
    const second = await read(
      await drawRoute(post({}, { 'idempotency-key': key }), params({ roomId: room.id })),
    );

    expect(second.body.draw.id).toBe(first.body.draw.id);
    expect(second.body.draw.replayed).toBe(true);
    expect(second.body.token_balance).toBe(first.body.token_balance);
  });

  it('409s with insufficient_tokens and does not charge', async () => {
    const { room } = await setup({ tokens: 10 });

    const response = await read(
      await drawRoute(post({}, { 'idempotency-key': randomUUID() }), params({ roomId: room.id })),
    );

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('insufficient_tokens');
    expect(response.body.error.details).toMatchObject({ required: 20, balance: 10 });
  });

  it('409s with pool_empty once every copy is held', async () => {
    const { room } = await setup({ copies: 1 });

    await drawRoute(post({}, { 'idempotency-key': randomUUID() }), params({ roomId: room.id }));
    const response = await read(
      await drawRoute(post({}, { 'idempotency-key': randomUUID() }), params({ roomId: room.id })),
    );

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('pool_empty');
    expect(response.body.error.details.held_by_students).toBe(1);
  });

  it('404s a student drawing from a room they are not in', async () => {
    const { educator } = await setup();
    const other = await createRoom({ actor: educator, schoolId: school.id, name: 'Enterprise 8C' });

    const response = await read(
      await drawRoute(post({}, { 'idempotency-key': randomUUID() }), params({ roomId: other.id })),
    );

    expect(response.status).toBe(404);
  });

  it('forbids an educator from drawing', async () => {
    const { room } = await setup();
    await signInAs('sam@school.edu', 'correct-horse-battery');

    const response = await read(
      await drawRoute(post({}, { 'idempotency-key': randomUUID() }), params({ roomId: room.id })),
    );

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('forbidden');
  });

  it('401s with no session', async () => {
    const { room } = await setup();
    jar.clear();

    const response = await read(
      await drawRoute(post({}, { 'idempotency-key': randomUUID() }), params({ roomId: room.id })),
    );

    expect(response.status).toBe(401);
  });
});

describe('GET /rooms/:roomId/inventory', () => {
  it('returns the student’s own stacked cards', async () => {
    const { room } = await setup();

    await drawRoute(post({}, { 'idempotency-key': randomUUID() }), params({ roomId: room.id }));
    await drawRoute(post({}, { 'idempotency-key': randomUUID() }), params({ roomId: room.id }));

    const response = await read(await inventoryRoute(get(), params({ roomId: room.id })));

    expect(response.status).toBe(200);
    expect(response.body.stacks).toHaveLength(1);
    expect(response.body.stacks[0]).toMatchObject({ name: 'Cashflow Boost', count: 2 });
  });

  it('lets an educator drill into one student’s inventory', async () => {
    const { room, student } = await setup();
    await drawRoute(post({}, { 'idempotency-key': randomUUID() }), params({ roomId: room.id }));

    await signInAs('sam@school.edu', 'correct-horse-battery');
    const response = await read(
      await inventoryRoute(
        get(`?enrollment_id=${student.enrollmentId}`),
        params({ roomId: room.id }),
      ),
    );

    expect(response.status).toBe(200);
    expect(response.body.stacks[0]).toMatchObject({ count: 1 });
  });

  it('never lets a student pass another enrolment id', async () => {
    const { room, educator } = await setup();
    const other = await createAndEnrollStudent({
      actor: educator,
      schoolId: school.id,
      roomId: room.id,
      displayName: 'Ben Cole',
      ip: testIp,
    });

    // The student route ignores the parameter entirely: the acting enrolment
    // comes from the session, so there is no input to abuse.
    const response = await read(
      await inventoryRoute(get(`?enrollment_id=${other.enrollmentId}`), params({ roomId: room.id })),
    );

    expect(response.status).toBe(200);
    expect(response.body.enrollment_id).not.toBe(other.enrollmentId);
  });
});
