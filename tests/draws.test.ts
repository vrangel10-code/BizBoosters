import { randomUUID } from 'node:crypto';
import { beforeEach, afterAll, describe, expect, it } from 'vitest';
import type { Room, School, User } from '@prisma/client';
import { prisma, resetDatabase, createSchool, seedUser, testIp } from './helpers';
import { createRoom } from '../src/server/services/rooms';
import { createAndEnrollStudent, removeStudent } from '../src/server/services/roster';
import { createCard } from '../src/server/services/cards';
import { resetDeck, setDeck } from '../src/server/services/decks';
import { awardTokens } from '../src/server/services/tokens';
import { drawCard, listInventory, pickCopy } from '../src/server/services/draws';
import { findBalanceDrift, findCopyDrift } from '../src/server/services/reconciliation';
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

/** Both invariants at once — the pair that makes the economy trustworthy. */
const expectIntegrity = async () => {
  expect(await findCopyDrift()).toEqual([]);
  expect(await findBalanceDrift()).toEqual([]);
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

async function addStudent(name: string, tokens = 0) {
  const student = await createAndEnrollStudent({
    actor: educator,
    schoolId: school.id,
    roomId: room.id,
    displayName: name,
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
  const user = await prisma.user.findUniqueOrThrow({ where: { id: student.userId } });
  return { ...student, user };
}

/** Builds a deck of `copies` copies spread over `cards` distinct cards. */
async function buildDeck(cards: number, copies: number, rarity: 'C' | 'U' | 'R' | 'L' = 'C') {
  const entries = [];
  for (let i = 0; i < cards; i += 1) {
    const card = await createCard({
      actor: educator,
      schoolId: school.id,
      name: `${rarity}${i}`,
      rarity,
    });
    entries.push({ card_id: card.id, copies_total: copies });
  }
  await setDeck(educator, room, entries);
  return entries;
}

const draw = (student: { enrollmentId: string; user: User }, key = randomUUID()) =>
  drawCard({ actor: student.user, room, enrollmentId: student.enrollmentId, idempotencyKey: key });

describe('pickCopy', () => {
  const stock = [
    { id: 'a', card_id: 'a', copies_remaining: 3 },
    { id: 'b', card_id: 'b', copies_remaining: 1 },
    { id: 'c', card_id: 'c', copies_remaining: 2 },
  ];

  it('maps each roll to the copy that owns it', () => {
    // 6 copies: rolls 0-2 -> a, 3 -> b, 4-5 -> c.
    expect([0, 1, 2].map((roll) => pickCopy(stock, roll).id)).toEqual(['a', 'a', 'a']);
    expect(pickCopy(stock, 3).id).toBe('b');
    expect([4, 5].map((roll) => pickCopy(stock, roll).id)).toEqual(['c', 'c']);
  });

  it('throws rather than returning a wrong card when the roll is out of range', () => {
    expect(() => pickCopy(stock, 6)).toThrow();
  });
});

describe('drawCard', () => {
  it('spends tokens, moves a copy out of the deck, and grants it', async () => {
    await buildDeck(3, 5);
    const student = await addStudent('Aisha Tan', 40);

    const result = await draw(student);

    expect(result.tokenCost).toBe(20);
    expect(result.tokenBalance).toBe(20);
    expect(result.card.name).toBeTruthy();
    expect(result.replayed).toBe(false);

    const item = await prisma.inventoryItem.findUniqueOrThrow({
      where: { id: result.inventoryItemId },
    });
    expect(item.state).toBe('owned');
    expect(item.acquiredVia).toBe('draw');

    // The copy left the deck; the total is unchanged because it moved, not
    // vanished.
    const roomCard = await prisma.roomCard.findFirstOrThrow({
      where: { roomId: room.id, cardId: result.card.id },
    });
    expect(roomCard.copiesTotal - roomCard.copiesRemaining).toBe(1);

    await expectIntegrity();
  });

  it('writes a ledger row linked to the draw', async () => {
    await buildDeck(2, 5);
    const student = await addStudent('Aisha Tan', 40);
    const result = await draw(student);

    const ledger = await prisma.tokenTransaction.findFirstOrThrow({
      where: { enrollmentId: student.enrollmentId, reason: 'draw_spend' },
    });
    expect(ledger).toMatchObject({ delta: -20, balanceAfter: 20, relatedType: 'draw' });
    expect(ledger.relatedId).toBe(result.drawId);
  });

  it('records the odds it rolled against, so a dispute is answerable', async () => {
    await buildDeck(2, 5, 'C');
    const student = await addStudent('Aisha Tan', 40);
    const result = await draw(student);

    const stored = await prisma.draw.findUniqueOrThrow({ where: { id: result.drawId } });
    expect(stored.poolSize).toBe(10);
    expect(stored.rollValue).toBeGreaterThanOrEqual(0);
    expect(stored.rollValue).toBeLessThan(10);
    // Snapshot is taken after the decrement, so it is the deck the next student
    // will face.
    expect(stored.poolSnapshot).toMatchObject({ C: 9 });
  });

  it('logs the card name so a later rename cannot rewrite history', async () => {
    await buildDeck(1, 5);
    const student = await addStudent('Aisha Tan', 40);
    const result = await draw(student);

    const event = await prisma.activityEvent.findFirstOrThrow({
      where: { roomId: room.id, type: 'card.drawn' },
    });
    expect(event.payload).toMatchObject({ card_name: result.card.name, rarity: result.card.rarity });

    await prisma.card.update({ where: { id: result.card.id }, data: { name: 'Renamed Later' } });
    const after = await prisma.activityEvent.findFirstOrThrow({ where: { id: event.id } });
    expect(after.payload).toMatchObject({ card_name: result.card.name });
  });

  it('refuses when the student cannot afford it, without touching the deck', async () => {
    await buildDeck(2, 5);
    const student = await addStudent('Aisha Tan', 19);

    await expectApiError(draw(student), 'insufficient_tokens');

    const enrollment = await prisma.enrollment.findUniqueOrThrow({
      where: { id: student.enrollmentId },
    });
    expect(enrollment.tokenBalance).toBe(19);
    expect(await prisma.inventoryItem.count()).toBe(0);
    await expectIntegrity();
  });

  it('refuses on an empty deck and leaves the tokens alone', async () => {
    await buildDeck(1, 1);
    const first = await addStudent('Aisha Tan', 40);
    const second = await addStudent('Ben Cole', 40);

    await draw(first);

    // The deck is empty because someone is holding the only copy — the error
    // says so rather than implying the cards were consumed.
    await expect(draw(second)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ApiError &&
        error.code === 'pool_empty' &&
        error.details.held_by_students === 1,
    );

    const enrollment = await prisma.enrollment.findUniqueOrThrow({
      where: { id: second.enrollmentId },
    });
    expect(enrollment.tokenBalance).toBe(40);
    await expectIntegrity();
  });

  it('refuses in an archived room', async () => {
    await buildDeck(2, 5);
    const student = await addStudent('Aisha Tan', 40);
    const archived = await prisma.room.update({
      where: { id: room.id },
      data: { status: 'archived', archivedAt: new Date() },
    });

    await expectApiError(
      drawCard({
        actor: student.user,
        room: archived,
        enrollmentId: student.enrollmentId,
        idempotencyKey: randomUUID(),
      }),
      'room_archived',
    );
  });

  it('refuses for a removed student', async () => {
    await buildDeck(2, 5);
    const student = await addStudent('Aisha Tan', 40);
    await removeStudent(educator, room.id, student.enrollmentId);

    await expectApiError(draw(student), 'not_found');
  });
});

describe('idempotency', () => {
  it('replays the same result and charges once', async () => {
    await buildDeck(3, 5);
    const student = await addStudent('Aisha Tan', 100);
    const key = randomUUID();

    const first = await draw(student, key);
    const second = await draw(student, key);

    expect(second.replayed).toBe(true);
    expect(second.drawId).toBe(first.drawId);
    expect(second.card.id).toBe(first.card.id);
    expect(second.tokenBalance).toBe(first.tokenBalance);

    // One draw, one item, one debit — a lost response must not cost 20 tokens.
    expect(await prisma.draw.count()).toBe(1);
    expect(await prisma.inventoryItem.count()).toBe(1);
    expect(
      await prisma.tokenTransaction.count({ where: { reason: 'draw_spend' } }),
    ).toBe(1);
    await expectIntegrity();
  });

  it('survives a genuine double-click firing both requests at once', async () => {
    await buildDeck(3, 5);
    const student = await addStudent('Aisha Tan', 100);
    const key = randomUUID();

    const [a, b] = await Promise.all([draw(student, key), draw(student, key)]);

    expect(a.drawId).toBe(b.drawId);
    expect(await prisma.draw.count()).toBe(1);
    await expectIntegrity();
  });

  it('treats a different key as a different draw', async () => {
    await buildDeck(3, 5);
    const student = await addStudent('Aisha Tan', 100);

    await draw(student, randomUUID());
    await draw(student, randomUUID());

    expect(await prisma.draw.count()).toBe(2);
    expect((await prisma.enrollment.findUniqueOrThrow({ where: { id: student.enrollmentId } })).tokenBalance).toBe(60);
  });

  it('scopes keys per student, so two students may reuse one', async () => {
    await buildDeck(3, 5);
    const first = await addStudent('Aisha Tan', 40);
    const second = await addStudent('Ben Cole', 40);
    const key = randomUUID();

    await draw(first, key);
    await draw(second, key);

    expect(await prisma.draw.count()).toBe(2);
  });
});

describe('concurrency', () => {
  it('gives the last copy to exactly one of many simultaneous drawers', async () => {
    await buildDeck(1, 1);
    const students = await Promise.all(
      Array.from({ length: 10 }, (_, i) => addStudent(`Student ${i}`, 40)),
    );

    const results = await Promise.allSettled(students.map((student) => draw(student)));

    const winners = results.filter((r) => r.status === 'fulfilled');
    const losers = results.filter((r) => r.status === 'rejected');

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(9);
    // Every loser gets a clean pool_empty, not a deadlock or a 500.
    expect(
      losers.every(
        (r) =>
          r.status === 'rejected' &&
          r.reason instanceof ApiError &&
          r.reason.code === 'pool_empty',
      ),
    ).toBe(true);

    // And crucially, the losers still have their tokens.
    const balances = await prisma.enrollment.findMany({ where: { roomId: room.id } });
    expect(balances.filter((e) => e.tokenBalance === 40)).toHaveLength(9);
    expect(balances.filter((e) => e.tokenBalance === 20)).toHaveLength(1);

    expect(await prisma.inventoryItem.count({ where: { state: 'owned' } })).toBe(1);
    await expectIntegrity();
  });

  it('never over-draws a small deck under heavy parallel load', async () => {
    // The phase-3 acceptance case: 30 students against a 5-card deck.
    await buildDeck(5, 1);
    const students = await Promise.all(
      Array.from({ length: 30 }, (_, i) => addStudent(`Student ${String(i).padStart(2, '0')}`, 40)),
    );

    const results = await Promise.allSettled(students.map((student) => draw(student)));

    const winners = results.filter((r) => r.status === 'fulfilled');
    expect(winners).toHaveLength(5);
    expect(await prisma.inventoryItem.count({ where: { state: 'owned' } })).toBe(5);

    const totals = await prisma.roomCard.aggregate({
      where: { roomId: room.id },
      _sum: { copiesTotal: true, copiesRemaining: true },
    });
    expect(totals._sum.copiesTotal).toBe(5);
    expect(totals._sum.copiesRemaining).toBe(0);

    await expectIntegrity();
  });

  it('lets one student fire many draws at once without losing an update', async () => {
    await buildDeck(10, 2);
    const student = await addStudent('Aisha Tan', 200);

    await Promise.all(Array.from({ length: 10 }, () => draw(student)));

    const enrollment = await prisma.enrollment.findUniqueOrThrow({
      where: { id: student.enrollmentId },
    });
    expect(enrollment.tokenBalance).toBe(0);
    expect(await prisma.inventoryItem.count({ where: { enrollmentId: student.enrollmentId } })).toBe(10);
    await expectIntegrity();
  });

  it('does not let parallel draws in different rooms block each other', async () => {
    const otherRoom = await createRoom({
      actor: educator,
      schoolId: school.id,
      name: 'Enterprise 8C',
    });
    await buildDeck(3, 5);

    const otherCard = await createCard({
      actor: educator,
      schoolId: school.id,
      name: 'Other Room Card',
      rarity: 'C',
    });
    await setDeck(educator, otherRoom, [{ card_id: otherCard.id, copies_total: 5 }]);

    const mine = await addStudent('Aisha Tan', 40);
    const theirStudent = await createAndEnrollStudent({
      actor: educator,
      schoolId: school.id,
      roomId: otherRoom.id,
      displayName: 'Ben Cole',
      ip: testIp,
    });
    await awardTokens({
      actor: educator,
      roomId: otherRoom.id,
      enrollmentIds: [theirStudent.enrollmentId],
      amount: 40,
    });
    const theirUser = await prisma.user.findUniqueOrThrow({ where: { id: theirStudent.userId } });

    const [a, b] = await Promise.all([
      draw(mine),
      drawCard({
        actor: theirUser,
        room: otherRoom,
        enrollmentId: theirStudent.enrollmentId,
        idempotencyKey: randomUUID(),
      }),
    ]);

    expect(a.drawId).not.toBe(b.drawId);
    await expectIntegrity();
  });
});

describe('draw distribution', () => {
  it('matches the advertised odds within statistical noise', async () => {
    // 1 Common x60, 1 Legendary x3 — deliberately lopsided so a bug that
    // ignores copy counts (picking uniformly per card type, as the prototype
    // did) would show up as roughly 50/50 rather than 95/5.
    const common = await createCard({
      actor: educator,
      schoolId: school.id,
      name: 'Common Card',
      rarity: 'C',
    });
    const legendary = await createCard({
      actor: educator,
      schoolId: school.id,
      name: 'Legendary Card',
      rarity: 'L',
    });
    await setDeck(educator, room, [
      { card_id: common.id, copies_total: 60 },
      { card_id: legendary.id, copies_total: 3 },
    ]);

    const student = await addStudent('Aisha Tan', 63 * 20);

    const drawn: Record<string, number> = { C: 0, L: 0 };
    for (let i = 0; i < 63; i += 1) {
      const result = await draw(student);
      drawn[result.card.rarity] = (drawn[result.card.rarity] ?? 0) + 1;
    }

    // Draining the whole deck makes this exact rather than probabilistic: every
    // copy must come out exactly once.
    expect(drawn.C).toBe(60);
    expect(drawn.L).toBe(3);
    await expectIntegrity();
  });

  it('weights by copies remaining, not by card type', async () => {
    const heavy = await createCard({
      actor: educator,
      schoolId: school.id,
      name: 'Heavy',
      rarity: 'C',
    });
    const light = await createCard({
      actor: educator,
      schoolId: school.id,
      name: 'Light',
      rarity: 'C',
    });
    await setDeck(educator, room, [
      { card_id: heavy.id, copies_total: 90 },
      { card_id: light.id, copies_total: 10 },
    ]);

    const student = await addStudent('Aisha Tan', 100 * 20);
    const counts: Record<string, number> = {};
    for (let i = 0; i < 60; i += 1) {
      const result = await draw(student);
      counts[result.card.name] = (counts[result.card.name] ?? 0) + 1;
    }

    // 90:10 by copies. Picking uniformly per card type would land near 30:30;
    // the loosest sane bound still separates the two hypotheses decisively.
    expect(counts.Heavy ?? 0).toBeGreaterThan(40);
    expect(counts.Light ?? 0).toBeLessThan(20);
  });
});

describe('inventory', () => {
  it('stacks duplicates into one entry', async () => {
    const card = await createCard({
      actor: educator,
      schoolId: school.id,
      name: 'Only Card',
      rarity: 'C',
    });
    await setDeck(educator, room, [{ card_id: card.id, copies_total: 5 }]);
    const student = await addStudent('Aisha Tan', 100);

    for (let i = 0; i < 4; i += 1) await draw(student);

    const stacks = await listInventory(student.enrollmentId);
    expect(stacks).toHaveLength(1);
    expect(stacks[0]).toMatchObject({ name: 'Only Card', count: 4 });
    expect(stacks[0]?.item_ids).toHaveLength(4);
  });

  it('orders rarest first', async () => {
    const cards = await Promise.all(
      (['C', 'U', 'R', 'L'] as const).map((rarity) =>
        createCard({ actor: educator, schoolId: school.id, name: `${rarity} card`, rarity }),
      ),
    );
    await setDeck(
      educator,
      room,
      cards.map((card) => ({ card_id: card.id, copies_total: 1 })),
    );
    const student = await addStudent('Aisha Tan', 200);

    for (let i = 0; i < 4; i += 1) await draw(student);

    const stacks = await listInventory(student.enrollmentId);
    expect(stacks.map((stack) => stack.rarity)).toEqual(['L', 'R', 'U', 'C']);
  });

  it('keeps each room’s inventory separate', async () => {
    const otherRoom = await createRoom({
      actor: educator,
      schoolId: school.id,
      name: 'Enterprise 8C',
    });
    await buildDeck(2, 5);
    const student = await addStudent('Aisha Tan', 100);
    await draw(student);

    const secondEnrollment = await prisma.enrollment.create({
      data: { roomId: otherRoom.id, studentId: student.userId },
    });

    expect(await listInventory(student.enrollmentId)).toHaveLength(1);
    expect(await listInventory(secondEnrollment.id)).toHaveLength(0);
  });
});

describe('copies returning to the deck', () => {
  it('returns a removed student’s cards to the deck', async () => {
    await buildDeck(2, 3);
    const student = await addStudent('Aisha Tan', 100);
    await draw(student);
    await draw(student);

    const before = await prisma.roomCard.aggregate({
      where: { roomId: room.id },
      _sum: { copiesRemaining: true },
    });
    expect(before._sum.copiesRemaining).toBe(4);

    await removeStudent(educator, room.id, student.enrollmentId);

    const after = await prisma.roomCard.aggregate({
      where: { roomId: room.id },
      _sum: { copiesRemaining: true },
    });
    // A departed student must not hold the room's cards hostage for the term.
    expect(after._sum.copiesRemaining).toBe(6);
    expect(await prisma.inventoryItem.count({ where: { state: 'owned' } })).toBe(0);
    await expectIntegrity();
  });

  it('reset clears every collection and refills, in one step', async () => {
    await buildDeck(3, 4);
    const first = await addStudent('Aisha Tan', 100);
    const second = await addStudent('Ben Cole', 100);
    for (let i = 0; i < 3; i += 1) await draw(first);
    for (let i = 0; i < 2; i += 1) await draw(second);

    expect(await prisma.inventoryItem.count({ where: { state: 'owned' } })).toBe(5);

    const result = await resetDeck(educator, room, 'Enterprise 7B');
    expect(result.copiesReturned).toBe(5);

    // Refill and clear-hands together: held = 0, remaining = total.
    expect(await prisma.inventoryItem.count({ where: { state: 'owned' } })).toBe(0);
    expect(await prisma.inventoryItem.count({ where: { state: 'revoked' } })).toBe(5);
    const totals = await prisma.roomCard.aggregate({
      where: { roomId: room.id },
      _sum: { copiesTotal: true, copiesRemaining: true },
    });
    expect(totals._sum.copiesRemaining).toBe(totals._sum.copiesTotal);

    await expectIntegrity();
  });

  it('leaves token balances untouched by a reset', async () => {
    await buildDeck(2, 4);
    const student = await addStudent('Aisha Tan', 100);
    await draw(student);

    await resetDeck(educator, room, 'Enterprise 7B');

    const enrollment = await prisma.enrollment.findUniqueOrThrow({
      where: { id: student.enrollmentId },
    });
    // Tokens are earned recognition; only the cards reset.
    expect(enrollment.tokenBalance).toBe(80);
  });
});

describe('reconciliation', () => {
  it('reports nothing on a healthy room', async () => {
    await buildDeck(3, 5);
    const student = await addStudent('Aisha Tan', 100);
    await draw(student);
    await draw(student);

    expect(await findCopyDrift()).toEqual([]);
    expect(await findBalanceDrift()).toEqual([]);
  });

  it('catches a copy that leaked out of the deck', async () => {
    await buildDeck(1, 5);
    const student = await addStudent('Aisha Tan', 100);
    await draw(student);

    // Simulate the bug the check exists for: a copy taken from the deck without
    // a matching inventory row.
    await prisma.roomCard.updateMany({
      where: { roomId: room.id },
      data: { copiesRemaining: { decrement: 1 } },
    });

    const drift = await findCopyDrift();
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({ copiesTotal: 5, inDeck: 3, heldByStudents: 1 });
  });

  it('catches a balance that stopped matching its ledger', async () => {
    const student = await addStudent('Aisha Tan', 40);
    await prisma.enrollment.update({
      where: { id: student.enrollmentId },
      data: { tokenBalance: 999 },
    });

    const drift = await findBalanceDrift();
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({ cached: 999, ledger: 40, studentName: 'Aisha Tan' });
  });
});
