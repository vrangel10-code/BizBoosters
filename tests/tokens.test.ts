import { beforeEach, afterAll, describe, expect, it } from 'vitest';
import type { Room, School, User } from '@prisma/client';
import { prisma, resetDatabase, createSchool, seedUser, testIp } from './helpers';
import { createRoom } from '../src/server/services/rooms';
import { createAndEnrollStudent } from '../src/server/services/roster';
import { adjustTokens, awardTokens, undoTokenTransaction } from '../src/server/services/tokens';
import { findBalanceDrift } from '../src/server/services/reconciliation';
import { listActivity } from '../src/server/services/activity';
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

const addStudent = async (name: string) =>
  createAndEnrollStudent({
    actor: educator,
    schoolId: school.id,
    roomId: room.id,
    displayName: name,
    ip: testIp,
  });

/** The invariant that makes the whole economy trustworthy. */
const expectLedgerBalances = async () => {
  expect(await findBalanceDrift()).toEqual([]);
};

describe('awardTokens', () => {
  it('credits a student and records the reason', async () => {
    const student = await addStudent('Aisha Tan');

    const result = await awardTokens({
      actor: educator,
      roomId: room.id,
      enrollmentIds: [student.enrollmentId],
      amount: 40,
      note: 'Great pitch in week 4',
    });

    expect(result.awarded[0]?.balance).toBe(40);

    const ledger = await prisma.tokenTransaction.findMany({
      where: { enrollmentId: student.enrollmentId },
    });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      delta: 40,
      balanceAfter: 40,
      reason: 'educator_award',
      note: 'Great pitch in week 4',
    });
    await expectLedgerBalances();
  });

  it('accumulates across awards', async () => {
    const student = await addStudent('Aisha Tan');

    await awardTokens({ actor: educator, roomId: room.id, enrollmentIds: [student.enrollmentId], amount: 20 });
    await awardTokens({ actor: educator, roomId: room.id, enrollmentIds: [student.enrollmentId], amount: 25 });

    const enrollment = await prisma.enrollment.findUniqueOrThrow({
      where: { id: student.enrollmentId },
    });
    expect(enrollment.tokenBalance).toBe(45);
    await expectLedgerBalances();
  });

  it('writes one ledger row AND one activity event per student in a bulk award', async () => {
    // The phase-1 acceptance case: 30 students, one award, everybody sees it.
    const students = await Promise.all(
      Array.from({ length: 30 }, (_, i) => addStudent(`Student ${String(i).padStart(2, '0')}`)),
    );

    const result = await awardTokens({
      actor: educator,
      roomId: room.id,
      enrollmentIds: students.map((s) => s.enrollmentId),
      amount: 40,
      note: 'Great pitch in week 4',
    });

    expect(result.awarded).toHaveLength(30);

    const ledger = await prisma.tokenTransaction.findMany({ where: { batchId: result.batchId } });
    expect(ledger).toHaveLength(30);
    expect(ledger.every((row) => row.delta === 40)).toBe(true);

    // Every student must find it in their OWN history, which is filtered by
    // enrolment — a single room-level event would be invisible to all of them.
    for (const student of students) {
      const { rows } = await listActivity({
        roomId: room.id,
        subjectEnrollmentId: student.enrollmentId,
      });
      const awarded = rows.filter((row) => row.type === 'tokens.awarded');
      expect(awarded).toHaveLength(1);
      expect(awarded[0]?.payload).toMatchObject({ amount: 40, note: 'Great pitch in week 4' });
    }

    await expectLedgerBalances();
  });

  it('shares one batch id across the award so the room log can collapse it', async () => {
    const students = await Promise.all([addStudent('A'), addStudent('B'), addStudent('C')]);

    const result = await awardTokens({
      actor: educator,
      roomId: room.id,
      enrollmentIds: students.map((s) => s.enrollmentId),
      amount: 10,
    });

    const batches = await prisma.tokenTransaction.groupBy({
      by: ['batchId'],
      where: { batchId: result.batchId },
      _count: true,
    });
    expect(batches).toHaveLength(1);
    expect(batches[0]?._count).toBe(3);
  });

  it('rejects a non-positive amount', async () => {
    const student = await addStudent('Aisha Tan');
    await expectApiError(
      awardTokens({ actor: educator, roomId: room.id, enrollmentIds: [student.enrollmentId], amount: 0 }),
      'validation_failed',
    );
    await expectApiError(
      awardTokens({ actor: educator, roomId: room.id, enrollmentIds: [student.enrollmentId], amount: -5 }),
      'validation_failed',
    );
  });

  it('refuses an enrolment from another room and awards nothing', async () => {
    const other = await createRoom({ actor: educator, schoolId: school.id, name: 'Enterprise 8C' });
    const mine = await addStudent('Aisha Tan');
    const theirs = await createAndEnrollStudent({
      actor: educator,
      schoolId: school.id,
      roomId: other.id,
      displayName: 'Ben Cole',
      ip: testIp,
    });

    await expectApiError(
      awardTokens({
        actor: educator,
        roomId: room.id,
        enrollmentIds: [mine.enrollmentId, theirs.enrollmentId],
        amount: 10,
      }),
      'not_found',
    );

    // All-or-nothing: the valid student in the batch must not have been paid.
    const enrollment = await prisma.enrollment.findUniqueOrThrow({ where: { id: mine.enrollmentId } });
    expect(enrollment.tokenBalance).toBe(0);
    await expectLedgerBalances();
  });

  it('keeps balances independent per room for the same student', async () => {
    const other = await createRoom({ actor: educator, schoolId: school.id, name: 'Enterprise 8C' });
    const student = await addStudent('Aisha Tan');

    const secondEnrollment = await prisma.enrollment.create({
      data: { roomId: other.id, studentId: student.userId },
    });

    await awardTokens({ actor: educator, roomId: room.id, enrollmentIds: [student.enrollmentId], amount: 40 });

    const first = await prisma.enrollment.findUniqueOrThrow({ where: { id: student.enrollmentId } });
    const second = await prisma.enrollment.findUniqueOrThrow({ where: { id: secondEnrollment.id } });

    expect(first.tokenBalance).toBe(40);
    expect(second.tokenBalance).toBe(0);
  });

  it('stays consistent under concurrent awards to the same student', async () => {
    const student = await addStudent('Aisha Tan');

    await Promise.all(
      Array.from({ length: 10 }, () =>
        awardTokens({
          actor: educator,
          roomId: room.id,
          enrollmentIds: [student.enrollmentId],
          amount: 5,
        }),
      ),
    );

    const enrollment = await prisma.enrollment.findUniqueOrThrow({
      where: { id: student.enrollmentId },
    });
    // Without the row lock this is a lost-update race and lands below 50.
    expect(enrollment.tokenBalance).toBe(50);
    await expectLedgerBalances();
  });
});

describe('adjustTokens', () => {
  it('applies a delta and appends a compensating row rather than editing', async () => {
    const student = await addStudent('Aisha Tan');
    await awardTokens({ actor: educator, roomId: room.id, enrollmentIds: [student.enrollmentId], amount: 60 });

    const result = await adjustTokens({
      actor: educator,
      roomId: room.id,
      enrollmentId: student.enrollmentId,
      delta: -20,
      note: 'Double-counted the group bonus',
    });

    expect(result.balance).toBe(40);

    const ledger = await prisma.tokenTransaction.findMany({
      where: { enrollmentId: student.enrollmentId },
      orderBy: { createdAt: 'asc' },
    });
    // The original award is untouched; the correction sits beside it.
    expect(ledger).toHaveLength(2);
    expect(ledger[0]?.delta).toBe(60);
    expect(ledger[1]).toMatchObject({ delta: -20, reason: 'educator_adjustment' });
    await expectLedgerBalances();
  });

  it('sets an absolute target balance', async () => {
    const student = await addStudent('Aisha Tan');
    await awardTokens({ actor: educator, roomId: room.id, enrollmentIds: [student.enrollmentId], amount: 60 });

    const result = await adjustTokens({
      actor: educator,
      roomId: room.id,
      enrollmentId: student.enrollmentId,
      targetBalance: 25,
      note: 'Corrected after review',
    });

    expect(result.balance).toBe(25);
    expect(result.delta).toBe(-35);
    await expectLedgerBalances();
  });

  it('requires a reason', async () => {
    const student = await addStudent('Aisha Tan');
    await expectApiError(
      adjustTokens({
        actor: educator,
        roomId: room.id,
        enrollmentId: student.enrollmentId,
        delta: 10,
        note: '   ',
      }),
      'validation_failed',
    );
  });

  it('refuses to take a balance below zero rather than clamping', async () => {
    const student = await addStudent('Aisha Tan');
    await awardTokens({ actor: educator, roomId: room.id, enrollmentIds: [student.enrollmentId], amount: 10 });

    // Clamping to zero would break `balance = SUM(ledger)` silently.
    await expectApiError(
      adjustTokens({
        actor: educator,
        roomId: room.id,
        enrollmentId: student.enrollmentId,
        delta: -50,
        note: 'Trying to remove more than they have',
      }),
      'insufficient_tokens',
    );

    const enrollment = await prisma.enrollment.findUniqueOrThrow({
      where: { id: student.enrollmentId },
    });
    expect(enrollment.tokenBalance).toBe(10);
    await expectLedgerBalances();
  });

  it('rejects a no-op adjustment', async () => {
    const student = await addStudent('Aisha Tan');
    await expectApiError(
      adjustTokens({
        actor: educator,
        roomId: room.id,
        enrollmentId: student.enrollmentId,
        targetBalance: 0,
        note: 'No change',
      }),
      'validation_failed',
    );
  });
});

describe('undoTokenTransaction', () => {
  it('writes the inverse row and links it to the original', async () => {
    const student = await addStudent('Aisha Tan');
    const award = await awardTokens({
      actor: educator,
      roomId: room.id,
      enrollmentIds: [student.enrollmentId],
      amount: 40,
      note: 'Wrong student',
    });

    const original = await prisma.tokenTransaction.findFirstOrThrow({
      where: { batchId: award.batchId },
    });

    const result = await undoTokenTransaction(educator, original.id, room.id);
    expect(result.balance).toBe(0);

    const reversal = await prisma.tokenTransaction.findFirstOrThrow({
      where: { reversesId: original.id },
    });
    expect(reversal.delta).toBe(-40);
    // Nothing is deleted: the mistake and its correction both stay visible.
    expect(await prisma.tokenTransaction.count({ where: { enrollmentId: student.enrollmentId } })).toBe(2);
    await expectLedgerBalances();
  });

  it('refuses to undo the same entry twice', async () => {
    const student = await addStudent('Aisha Tan');
    const award = await awardTokens({
      actor: educator,
      roomId: room.id,
      enrollmentIds: [student.enrollmentId],
      amount: 40,
    });
    const original = await prisma.tokenTransaction.findFirstOrThrow({
      where: { batchId: award.batchId },
    });

    await undoTokenTransaction(educator, original.id, room.id);
    await expectApiError(undoTokenTransaction(educator, original.id, room.id), 'already_undone');
    await expectLedgerBalances();
  });

  it('refuses to undo an undo', async () => {
    const student = await addStudent('Aisha Tan');
    const award = await awardTokens({
      actor: educator,
      roomId: room.id,
      enrollmentIds: [student.enrollmentId],
      amount: 40,
    });
    const original = await prisma.tokenTransaction.findFirstOrThrow({
      where: { batchId: award.batchId },
    });
    await undoTokenTransaction(educator, original.id, room.id);

    const reversal = await prisma.tokenTransaction.findFirstOrThrow({
      where: { reversesId: original.id },
    });
    await expectApiError(undoTokenTransaction(educator, reversal.id, room.id), 'already_undone');
  });

  it('refuses when the student has already spent the tokens', async () => {
    const student = await addStudent('Aisha Tan');
    const award = await awardTokens({
      actor: educator,
      roomId: room.id,
      enrollmentIds: [student.enrollmentId],
      amount: 40,
    });
    await adjustTokens({
      actor: educator,
      roomId: room.id,
      enrollmentId: student.enrollmentId,
      delta: -30,
      note: 'Spent elsewhere',
    });

    const original = await prisma.tokenTransaction.findFirstOrThrow({
      where: { batchId: award.batchId },
    });
    await expectApiError(undoTokenTransaction(educator, original.id, room.id), 'insufficient_tokens');
    await expectLedgerBalances();
  });

  it('expires after the undo window', async () => {
    const student = await addStudent('Aisha Tan');
    const award = await awardTokens({
      actor: educator,
      roomId: room.id,
      enrollmentIds: [student.enrollmentId],
      amount: 40,
    });
    const original = await prisma.tokenTransaction.findFirstOrThrow({
      where: { batchId: award.batchId },
    });

    await prisma.tokenTransaction.update({
      where: { id: original.id },
      data: { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
    });

    await expectApiError(
      undoTokenTransaction(educator, original.id, room.id),
      'undo_window_expired',
    );
  });

  it('refuses a transaction belonging to another room', async () => {
    const other = await createRoom({ actor: educator, schoolId: school.id, name: 'Enterprise 8C' });
    const student = await addStudent('Aisha Tan');
    const award = await awardTokens({
      actor: educator,
      roomId: room.id,
      enrollmentIds: [student.enrollmentId],
      amount: 40,
    });
    const original = await prisma.tokenTransaction.findFirstOrThrow({
      where: { batchId: award.batchId },
    });

    await expectApiError(undoTokenTransaction(educator, original.id, other.id), 'not_found');
  });
});

describe('database constraints', () => {
  it('rejects a negative balance even if a service forgets to check', async () => {
    const student = await addStudent('Aisha Tan');

    // Bypassing the service entirely: the constraint is the last line of
    // defence for any future code path that debits carelessly.
    await expect(
      prisma.enrollment.update({
        where: { id: student.enrollmentId },
        data: { tokenBalance: -1 },
      }),
    ).rejects.toThrow();
  });

  it('rejects a zero-delta ledger row', async () => {
    const student = await addStudent('Aisha Tan');

    await expect(
      prisma.tokenTransaction.create({
        data: {
          enrollmentId: student.enrollmentId,
          delta: 0,
          balanceAfter: 0,
          reason: 'system_correction',
        },
      }),
    ).rejects.toThrow();
  });
});
