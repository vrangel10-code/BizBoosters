import { randomUUID } from 'node:crypto';
import { beforeEach, afterAll, describe, expect, it } from 'vitest';
import type { Card, Room, School, User } from '@prisma/client';
import { prisma, resetDatabase, createSchool, seedUser, testIp } from './helpers';
import { createRoom, updateRoom } from '../src/server/services/rooms';
import { createAndEnrollStudent } from '../src/server/services/roster';
import { createCard } from '../src/server/services/cards';
import { getDeckOdds, setDeck } from '../src/server/services/decks';
import { awardTokens } from '../src/server/services/tokens';
import { drawCard, listInventory } from '../src/server/services/draws';
import {
  acknowledgeUse,
  grantCard,
  handsByStudent,
  heldByStudent,
  revokeCard,
  listRecentUses,
  returnCard,
  tradeUp,
  useCard,
} from '../src/server/services/card-actions';
import { listNotifications, markRead } from '../src/server/services/notifications';
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

async function addStudent(name: string, tokens = 200) {
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

async function card(name: string, rarity: 'C' | 'U' | 'R' | 'L', copies: number): Promise<Card> {
  const created = await createCard({ actor: educator, schoolId: school.id, name, rarity });
  const existing = await prisma.roomCard.findMany({
    where: { roomId: room.id },
    include: { card: true },
  });
  await setDeck(educator, room, [
    ...existing.map((row) => ({ card_id: row.cardId, copies_total: row.copiesTotal })),
    { card_id: created.id, copies_total: copies },
  ]);
  return created;
}

const draw = (student: { enrollmentId: string; user: User }) =>
  drawCard({
    actor: student.user,
    room,
    enrollmentId: student.enrollmentId,
    idempotencyKey: randomUUID(),
  });

describe('useCard', () => {
  it('spends the card and returns the copy to the deck in one step', async () => {
    await card('Snack Rush', 'C', 3);
    const student = await addStudent('Aisha Tan');
    const drawn = await draw(student);

    const before = await getDeckOdds(room);
    expect(before.in_deck).toBe(2);
    expect(before.held).toBe(1);

    await useCard(student.user, room, student.enrollmentId, drawn.inventoryItemId);

    const after = await getDeckOdds(room);
    // The copy is back immediately: this is what makes using a card pro-social.
    expect(after.in_deck).toBe(3);
    expect(after.held).toBe(0);
    expect(after.total).toBe(3);

    const item = await prisma.inventoryItem.findUniqueOrThrow({
      where: { id: drawn.inventoryItemId },
    });
    expect(item.state).toBe('used');
    expect(item.usedAt).not.toBeNull();
    expect(item.returnedAt).not.toBeNull();

    await expectIntegrity();
  });

  it('needs no educator approval — the card is spent on return', async () => {
    await card('Snack Rush', 'C', 3);
    const student = await addStudent('Aisha Tan');
    const drawn = await draw(student);

    await useCard(student.user, room, student.enrollmentId, drawn.inventoryItemId);

    // No pending state anywhere; the only record is history plus a notification.
    expect(await listInventory(student.enrollmentId)).toHaveLength(0);
    const events = await prisma.activityEvent.findMany({ where: { type: 'card.used' } });
    expect(events).toHaveLength(1);
  });

  it('notifies every educator in the room', async () => {
    const colleague = await seedUser({
      schoolId: school.id,
      role: 'educator',
      email: 'alex@school.edu',
      password: 'correct-horse-battery',
    });
    await prisma.roomEducator.create({
      data: { roomId: room.id, userId: colleague.id, role: 'assistant' },
    });

    await card('Snack Rush', 'C', 3);
    const student = await addStudent('Aisha Tan');
    const drawn = await draw(student);
    await useCard(student.user, room, student.enrollmentId, drawn.inventoryItemId);

    for (const teacher of [educator, colleague]) {
      const { data, unread } = await listNotifications(teacher.id);
      const used = data.filter((row) => row.type === 'card.used');
      expect(used).toHaveLength(1);
      expect(used[0]?.payload).toMatchObject({
        card_name: 'Snack Rush',
        student_name: 'Aisha Tan',
      });
      expect(unread).toBeGreaterThan(0);
    }
  });

  it('carries the student’s note through to the educator', async () => {
    await card('Snack Rush', 'C', 3);
    const student = await addStudent('Aisha Tan');
    const drawn = await draw(student);

    await useCard(
      student.user,
      room,
      student.enrollmentId,
      drawn.inventoryItemId,
      'Using this for tomorrow’s homework',
    );

    const uses = await listRecentUses(room.id);
    expect(uses[0]).toMatchObject({ note: 'Using this for tomorrow’s homework' });
  });

  it('is safe to double-click: the copy returns exactly once', async () => {
    await card('Snack Rush', 'C', 3);
    const student = await addStudent('Aisha Tan');
    const drawn = await draw(student);

    const [first, second] = await Promise.allSettled([
      useCard(student.user, room, student.enrollmentId, drawn.inventoryItemId),
      useCard(student.user, room, student.enrollmentId, drawn.inventoryItemId),
    ]);

    const settled = [first, second];
    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      settled.some(
        (r) =>
          r.status === 'rejected' &&
          r.reason instanceof ApiError &&
          r.reason.code === 'item_state_conflict',
      ),
    ).toBe(true);

    // A double return would inflate the deck to 4 of a 3-copy card.
    const odds = await getDeckOdds(room);
    expect(odds.in_deck).toBe(3);
    expect(odds.total).toBe(3);
    await expectIntegrity();
  });

  it('refuses a card the student does not own', async () => {
    await card('Snack Rush', 'C', 3);
    const owner = await addStudent('Aisha Tan');
    const other = await addStudent('Ben Cole');
    const drawn = await draw(owner);

    await expectApiError(
      useCard(other.user, room, other.enrollmentId, drawn.inventoryItemId),
      'item_not_owned',
    );
  });

  it('refuses a card already used', async () => {
    await card('Snack Rush', 'C', 3);
    const student = await addStudent('Aisha Tan');
    const drawn = await draw(student);

    await useCard(student.user, room, student.enrollmentId, drawn.inventoryItemId);
    await expectApiError(
      useCard(student.user, room, student.enrollmentId, drawn.inventoryItemId),
      'item_state_conflict',
    );
  });

  it('makes a rare card drawable again once spent', async () => {
    await card('Fortune Teller', 'L', 1);
    const holder = await addStudent('Aisha Tan');
    const other = await addStudent('Ben Cole');

    const drawn = await draw(holder);
    // One student holding the only Legendary denies it to everyone else.
    await expectApiError(draw(other), 'pool_empty');

    await useCard(holder.user, room, holder.enrollmentId, drawn.inventoryItemId);

    // Spending it puts it back in circulation.
    const second = await draw(other);
    expect(second.card.name).toBe('Fortune Teller');
    await expectIntegrity();
  });
});

describe('returnCard', () => {
  it('gives an unused copy back without marking it used', async () => {
    await card('Snack Rush', 'C', 3);
    const student = await addStudent('Aisha Tan');
    const drawn = await draw(student);

    await returnCard(student.user, room, student.enrollmentId, drawn.inventoryItemId);

    const item = await prisma.inventoryItem.findUniqueOrThrow({
      where: { id: drawn.inventoryItemId },
    });
    expect(item.state).toBe('returned');
    // Reporting cares about the difference between "spent" and "given back".
    expect(item.usedAt).toBeNull();
    expect(item.returnedAt).not.toBeNull();

    expect((await getDeckOdds(room)).in_deck).toBe(3);
    await expectIntegrity();
  });

  it('does not appear in the educator’s uses list', async () => {
    await card('Snack Rush', 'C', 3);
    const student = await addStudent('Aisha Tan');
    const drawn = await draw(student);

    await returnCard(student.user, room, student.enrollmentId, drawn.inventoryItemId);
    expect(await listRecentUses(room.id)).toHaveLength(0);
  });
});

describe('tradeUp', () => {
  const stockLadder = async () => {
    await card('C one', 'C', 10);
    await card('U one', 'U', 5);
    await card('R one', 'R', 2);
    await card('L one', 'L', 1);
  };

  /** Draws until the student holds `count` cards of `rarity`. */
  async function collect(
    student: { enrollmentId: string; user: User },
    rarity: 'C' | 'U' | 'R' | 'L',
    count: number,
  ) {
    const ids: string[] = [];
    for (let i = 0; i < 60 && ids.length < count; i += 1) {
      const result = await draw(student);
      if (result.card.rarity === rarity) ids.push(result.inventoryItemId);
      else await returnCard(student.user, room, student.enrollmentId, result.inventoryItemId);
    }
    if (ids.length < count) throw new Error(`could not collect ${count} ${rarity}`);
    return ids;
  }

  it('surrenders three of one rarity for one of the next', async () => {
    await stockLadder();
    const student = await addStudent('Aisha Tan', 2000);
    const commons = await collect(student, 'C', 3);

    const result = await tradeUp(student.user, room, student.enrollmentId, commons, randomUUID());

    expect(result.card.rarity).toBe('U');
    expect(result.consumed).toEqual(commons);

    const surrendered = await prisma.inventoryItem.findMany({ where: { id: { in: commons } } });
    expect(surrendered.every((item) => item.state === 'returned')).toBe(true);

    // Costs no tokens, matching the prototype.
    const draws = await prisma.draw.findFirstOrThrow({ where: { id: result.drawId } });
    expect(draws.tokenCost).toBe(0);
    expect(draws.kind).toBe('trade_upgrade');

    await expectIntegrity();
  });

  it('conserves copies: three go back, one comes out', async () => {
    await stockLadder();
    const student = await addStudent('Aisha Tan', 2000);
    const commons = await collect(student, 'C', 3);

    const before = await getDeckOdds(room);
    await tradeUp(student.user, room, student.enrollmentId, commons, randomUUID());
    const after = await getDeckOdds(room);

    expect(after.total).toBe(before.total);
    expect(after.in_deck).toBe(before.in_deck + 2); // +3 returned, −1 taken
    await expectIntegrity();
  });

  it('rejects a mixed-rarity selection', async () => {
    await stockLadder();
    const student = await addStudent('Aisha Tan', 2000);
    const commons = await collect(student, 'C', 2);
    const uncommons = await collect(student, 'U', 1);

    await expectApiError(
      tradeUp(student.user, room, student.enrollmentId, [...commons, ...uncommons], randomUUID()),
      'invalid_trade_selection',
    );
  });

  it('rejects the wrong number of cards', async () => {
    await stockLadder();
    const student = await addStudent('Aisha Tan', 2000);
    const commons = await collect(student, 'C', 2);

    await expectApiError(
      tradeUp(student.user, room, student.enrollmentId, commons, randomUUID()),
      'invalid_trade_selection',
    );
  });

  it('rejects cards the student does not own', async () => {
    await stockLadder();
    const student = await addStudent('Aisha Tan', 2000);
    const other = await addStudent('Ben Cole', 2000);
    const mine = await collect(student, 'C', 2);
    const theirs = await collect(other, 'C', 1);

    await expectApiError(
      tradeUp(student.user, room, student.enrollmentId, [...mine, ...theirs], randomUUID()),
      'invalid_trade_selection',
    );
  });

  it('refuses to trade up from Legendary', async () => {
    await card('L one', 'L', 5);
    const student = await addStudent('Aisha Tan', 2000);
    const legendaries = await collect(student, 'L', 3);

    await expectApiError(
      tradeUp(student.user, room, student.enrollmentId, legendaries, randomUUID()),
      'invalid_trade_selection',
    );
  });

  it('refuses when the target rarity is empty, keeping the student’s cards', async () => {
    await card('C one', 'C', 10);
    await card('U one', 'U', 1);
    const student = await addStudent('Aisha Tan', 2000);
    const other = await addStudent('Ben Cole', 2000);

    // Ben takes the only Uncommon.
    await collect(other, 'U', 1);
    const commons = await collect(student, 'C', 3);

    await expectApiError(
      tradeUp(student.user, room, student.enrollmentId, commons, randomUUID()),
      'target_rarity_empty',
    );

    // A failed trade must not cost the three cards.
    const kept = await prisma.inventoryItem.findMany({ where: { id: { in: commons } } });
    expect(kept.every((item) => item.state === 'owned')).toBe(true);
    await expectIntegrity();
  });

  it('respects the room switch', async () => {
    await stockLadder();
    const student = await addStudent('Aisha Tan', 2000);
    const commons = await collect(student, 'C', 3);

    const updated = await updateRoom({ actor: educator, room, tradesEnabled: false });

    await expectApiError(
      tradeUp(student.user, updated, student.enrollmentId, commons, randomUUID()),
      'trades_disabled',
    );
  });

  it('replays on a repeated idempotency key', async () => {
    await stockLadder();
    const student = await addStudent('Aisha Tan', 2000);
    const commons = await collect(student, 'C', 3);
    const key = randomUUID();

    const first = await tradeUp(student.user, room, student.enrollmentId, commons, key);
    const second = await tradeUp(student.user, room, student.enrollmentId, commons, key);

    expect(second.replayed).toBe(true);
    expect(second.drawId).toBe(first.drawId);
    expect(await prisma.trade.count()).toBe(1);
    await expectIntegrity();
  });
});

describe('educator uses list', () => {
  it('lists uses newest first and tracks acknowledgement', async () => {
    await card('Snack Rush', 'C', 5);
    const student = await addStudent('Aisha Tan');

    const first = await draw(student);
    const second = await draw(student);
    await useCard(student.user, room, student.enrollmentId, first.inventoryItemId);
    await useCard(student.user, room, student.enrollmentId, second.inventoryItemId);

    let uses = await listRecentUses(room.id);
    expect(uses).toHaveLength(2);
    expect(uses.every((use) => !use.acknowledged)).toBe(true);

    await acknowledgeUse(educator, room.id, uses[0]!.item_id, 'Honoured in class');

    uses = await listRecentUses(room.id);
    expect(uses.filter((use) => use.acknowledged)).toHaveLength(1);
    expect(await listRecentUses(room.id, { unacknowledgedOnly: true })).toHaveLength(1);
  });

  it('is idempotent — ticking twice does not duplicate', async () => {
    await card('Snack Rush', 'C', 5);
    const student = await addStudent('Aisha Tan');
    const drawn = await draw(student);
    await useCard(student.user, room, student.enrollmentId, drawn.inventoryItemId);

    await acknowledgeUse(educator, room.id, drawn.inventoryItemId);
    await acknowledgeUse(educator, room.id, drawn.inventoryItemId, 'again');

    expect(await prisma.cardUseAcknowledgement.count()).toBe(1);
  });

  it('refuses to acknowledge an item that was never used', async () => {
    await card('Snack Rush', 'C', 5);
    const student = await addStudent('Aisha Tan');
    const drawn = await draw(student);

    await expectApiError(
      acknowledgeUse(educator, room.id, drawn.inventoryItemId),
      'not_found',
    );
  });
});

describe('held-by-student breakdown', () => {
  it('explains an empty deck', async () => {
    await card('Snack Rush', 'C', 3);
    const first = await addStudent('Aisha Tan');
    const second = await addStudent('Ben Cole');

    await draw(first);
    await draw(first);
    await draw(second);

    const odds = await getDeckOdds(room);
    expect(odds.is_empty).toBe(true);
    expect(odds.held).toBe(3);

    const breakdown = await heldByStudent(room.id);
    expect(breakdown).toEqual([
      { enrollment_id: first.enrollmentId, student_name: 'Aisha Tan', held: 2 },
      { enrollment_id: second.enrollmentId, student_name: 'Ben Cole', held: 1 },
    ]);
  });
});

describe('notifications', () => {
  it('marks read only the recipient’s own', async () => {
    const colleague = await seedUser({
      schoolId: school.id,
      role: 'educator',
      email: 'alex@school.edu',
      password: 'correct-horse-battery',
    });
    await prisma.roomEducator.create({
      data: { roomId: room.id, userId: colleague.id, role: 'assistant' },
    });

    await card('Snack Rush', 'C', 3);
    const student = await addStudent('Aisha Tan');
    const drawn = await draw(student);
    await useCard(student.user, room, student.enrollmentId, drawn.inventoryItemId);

    const mine = await listNotifications(educator.id);
    // Passing someone else's ids marks nothing: the update is scoped by recipient.
    const marked = await markRead(colleague.id, { ids: mine.data.map((row) => row.id) });
    expect(marked).toBe(0);

    expect((await listNotifications(educator.id)).unread).toBe(mine.unread);
  });

  it('clears the badge with all: true', async () => {
    await card('Snack Rush', 'C', 5);
    const student = await addStudent('Aisha Tan');
    await draw(student);
    await draw(student);

    expect((await listNotifications(educator.id)).unread).toBeGreaterThan(0);
    await markRead(educator.id, { all: true });
    expect((await listNotifications(educator.id)).unread).toBe(0);
  });
});

/**
 * The educator's view of every hand, and the two edits that go with it.
 *
 * Both edits *move* a copy — the deck is finite and conserved, so granting must
 * fail rather than mint, and taking back must return rather than destroy. Those
 * are the assertions that matter here; the listing is the easy half.
 */
describe('handsByStudent / grantCard / revokeCard', () => {
  let commonCardId: string;

  beforeEach(async () => {
    commonCardId = (await card('Snack Rush', 'C', 5)).id;
  });

  const enrollStudent = (name: string) => addStudent(name, 0);

  it('lists every active student, including one holding nothing', async () => {
    const holder = await enrollStudent('Aisha Tan');
    await enrollStudent('Ben Cole');
    await grantCard(educator, room, holder.enrollmentId, commonCardId);

    const hands = await handsByStudent(room.id);

    expect(hands).toHaveLength(2);
    const byName = new Map(hands.map((row) => [row.student_name, row]));
    expect(byName.get('Aisha Tan')?.held).toBe(1);
    expect(byName.get('Aisha Tan')?.stacks[0]?.card_name).toBeTruthy();
    expect(byName.get('Ben Cole')?.held).toBe(0);
    expect(byName.get('Ben Cole')?.stacks).toEqual([]);
  });

  it('stacks multiple copies of one card under a single row', async () => {
    const student = await enrollStudent('Aisha Tan');
    await grantCard(educator, room, student.enrollmentId, commonCardId);
    await grantCard(educator, room, student.enrollmentId, commonCardId);

    const [hand] = await handsByStudent(room.id);
    expect(hand?.stacks).toHaveLength(1);
    expect(hand?.stacks[0]?.count).toBe(2);
    expect(hand?.stacks[0]?.item_ids).toHaveLength(2);
  });

  it('takes the granted copy out of the deck rather than minting one', async () => {
    const student = await enrollStudent('Aisha Tan');
    const before = await getDeckOdds(room);

    await grantCard(educator, room, student.enrollmentId, commonCardId);
    const after = await getDeckOdds(room);

    expect(after.total).toBe(before.total);
    expect(after.in_deck).toBe(before.in_deck - 1);
    expect(after.held).toBe(before.held + 1);
  });

  it('refuses to grant a card the deck has none of', async () => {
    const student = await enrollStudent('Aisha Tan');
    await prisma.roomCard.updateMany({
      where: { roomId: room.id, cardId: commonCardId },
      data: { copiesRemaining: 0 },
    });

    await expectApiError(
      grantCard(educator, room, student.enrollmentId, commonCardId),
      'pool_empty',
    );
  });

  it('returns a revoked copy to the deck and leaves the totals alone', async () => {
    const student = await enrollStudent('Aisha Tan');
    const granted = await grantCard(educator, room, student.enrollmentId, commonCardId);
    const before = await getDeckOdds(room);

    await revokeCard(educator, room, granted.itemId);
    const after = await getDeckOdds(room);

    expect(after.total).toBe(before.total);
    expect(after.in_deck).toBe(before.in_deck + 1);
    expect(after.held).toBe(before.held - 1);
    expect(await handsByStudent(room.id).then((rows) => rows[0]?.held)).toBe(0);
  });

  it('cannot revoke the same copy twice', async () => {
    const student = await enrollStudent('Aisha Tan');
    const granted = await grantCard(educator, room, student.enrollmentId, commonCardId);

    await revokeCard(educator, room, granted.itemId);
    await expectApiError(revokeCard(educator, room, granted.itemId), 'item_state_conflict');
  });

  it('records both edits in the room log, naming the card', async () => {
    const student = await enrollStudent('Aisha Tan');
    const granted = await grantCard(educator, room, student.enrollmentId, commonCardId);
    await revokeCard(educator, room, granted.itemId);

    const events = await prisma.activityEvent.findMany({
      where: { roomId: room.id, subjectEnrollmentId: student.enrollmentId },
    });
    const types = events.map((event) => event.type);
    expect(types).toContain('card.granted');
    expect(types).toContain('card.revoked');
    for (const event of events.filter((row) => row.type.startsWith('card.'))) {
      expect((event.payload as { card_name?: string }).card_name).toBeTruthy();
    }
  });
});
