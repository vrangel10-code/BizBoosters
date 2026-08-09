import { beforeEach, afterAll, describe, expect, it } from 'vitest';
import type { Room, School, User } from '@prisma/client';
import { prisma, resetDatabase, createSchool, seedUser, testIp } from './helpers';
import {
  addRoomEducator,
  archiveRoom,
  createRoom,
  listRoomsForEducator,
  listRoomsForStudent,
  updateRoom,
} from '../src/server/services/rooms';
import {
  createAndEnrollStudent,
  addExistingStudents,
  importRoster,
  parseRosterCsv,
  removeStudent,
  listRoster,
} from '../src/server/services/roster';
import { awardTokens } from '../src/server/services/tokens';
import { requireRoomEducator, requireRoomEnrollment } from '../src/server/auth/room-guard';
import { ApiError } from '../src/server/errors';
import { DEFAULT_STUDENT_PASSWORD } from '../src/server/auth/identifiers';

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

const addStudent = (name: string, roomId = room.id) =>
  createAndEnrollStudent({
    actor: educator,
    schoolId: school.id,
    roomId,
    displayName: name,
    ip: testIp,
  });

describe('createRoom', () => {
  it('makes the creator the owner', async () => {
    const membership = await prisma.roomEducator.findUniqueOrThrow({
      where: { roomId_userId: { roomId: room.id, userId: educator.id } },
    });
    expect(membership.role).toBe('owner');
  });

  it('defaults the draw cost to 20 tokens', async () => {
    expect(room.drawCostTokens).toBe(20);
  });

  it('logs its own creation', async () => {
    const events = await prisma.activityEvent.findMany({ where: { roomId: room.id } });
    expect(events.map((e) => e.type)).toContain('room.created');
  });
});

describe('room access', () => {
  it('hides another educator’s room behind a 404, not a 403', async () => {
    const stranger = await seedUser({
      schoolId: school.id,
      role: 'educator',
      email: 'stranger@school.edu',
      password: 'correct-horse-battery',
    });

    // 404 on purpose: a 403 would confirm the room exists.
    await expectApiError(requireRoomEducator(stranger, room.id), 'not_found');
  });

  it('hides another school’s room entirely', async () => {
    const otherSchool = await createSchool('Southgate High');
    const otherAdmin = await seedUser({
      schoolId: otherSchool.id,
      role: 'school_admin',
      email: 'head@southgate.edu',
      password: 'correct-horse-battery',
    });

    await expectApiError(requireRoomEducator(otherAdmin, room.id), 'not_found');
  });

  it('lets a co-teacher in once added', async () => {
    const colleague = await seedUser({
      schoolId: school.id,
      role: 'educator',
      email: 'alex@school.edu',
      password: 'correct-horse-battery',
    });

    await expectApiError(requireRoomEducator(colleague, room.id), 'not_found');
    await addRoomEducator(educator, room.id, colleague.id);

    const context = await requireRoomEducator(colleague, room.id);
    expect(context.room.id).toBe(room.id);
    expect(context.isOwner).toBe(false);
  });

  it('lets a school admin oversee a room they do not teach', async () => {
    const admin = await seedUser({
      schoolId: school.id,
      role: 'school_admin',
      email: 'head@school.edu',
      password: 'correct-horse-battery',
    });

    const context = await requireRoomEducator(admin, room.id);
    expect(context.room.id).toBe(room.id);
  });

  it('refuses a student on the educator path even when enrolled', async () => {
    const student = await addStudent('Aisha Tan');
    const studentUser = await prisma.user.findUniqueOrThrow({ where: { id: student.userId } });

    await expectApiError(requireRoomEducator(studentUser, room.id), 'not_found');
  });

  it('refuses a student who is not enrolled', async () => {
    const other = await createRoom({ actor: educator, schoolId: school.id, name: 'Enterprise 8C' });
    const student = await addStudent('Aisha Tan');
    const studentUser = await prisma.user.findUniqueOrThrow({ where: { id: student.userId } });

    await expect(requireRoomEnrollment(studentUser, room.id)).resolves.toBeTruthy();
    await expectApiError(requireRoomEnrollment(studentUser, other.id), 'not_found');
  });

  it('refuses a removed student', async () => {
    const student = await addStudent('Aisha Tan');
    const studentUser = await prisma.user.findUniqueOrThrow({ where: { id: student.userId } });

    await removeStudent(educator, room.id, student.enrollmentId);
    await expectApiError(requireRoomEnrollment(studentUser, room.id), 'not_found');
  });
});

/**
 * The reported failure: adding a student who already exists to a second room
 * came back saying their login ID was taken, because the only door in was the
 * one that creates an account. A student in two classes is one account with two
 * enrolments, and these are what that has to mean.
 */
describe('a student in more than one room', () => {
  it('enrols an existing student into a second room without a new account', async () => {
    const student = await addStudent('Aisha Tan');
    const second = await createRoom({
      actor: educator,
      schoolId: school.id,
      name: 'Enterprise 8A',
    });

    const roster = await addExistingStudents({
      actor: educator,
      roomId: second.id,
      studentIds: [student.userId],
      ip: testIp,
    });

    expect(roster).toHaveLength(1);
    // One account, two enrolments — not two accounts.
    expect(await prisma.user.count({ where: { role: 'student' } })).toBe(1);
    expect(await prisma.enrollment.count({ where: { studentId: student.userId } })).toBe(2);
  });

  it('keeps the two rooms’ token balances entirely separate', async () => {
    const student = await addStudent('Aisha Tan');
    const second = await createRoom({
      actor: educator,
      schoolId: school.id,
      name: 'Enterprise 8A',
    });
    await addExistingStudents({
      actor: educator,
      roomId: second.id,
      studentIds: [student.userId],
      ip: testIp,
    });

    const secondEnrollment = await prisma.enrollment.findFirstOrThrow({
      where: { studentId: student.userId, roomId: second.id },
    });

    await awardTokens({
      actor: educator,
      roomId: room.id,
      enrollmentIds: [student.enrollmentId],
      amount: 40,
    });

    const here = await prisma.enrollment.findUniqueOrThrow({
      where: { id: student.enrollmentId },
    });
    const there = await prisma.enrollment.findUniqueOrThrow({
      where: { id: secondEnrollment.id },
    });

    expect(here.tokenBalance).toBe(40);
    expect(there.tokenBalance).toBe(0);
  });

  it('is a no-op rather than an error when they are already in the room', async () => {
    const student = await addStudent('Aisha Tan');

    await addExistingStudents({
      actor: educator,
      roomId: room.id,
      studentIds: [student.userId],
      ip: testIp,
    });

    expect(await prisma.enrollment.count({ where: { roomId: room.id } })).toBe(1);
  });
});

describe('archiving', () => {
  it('blocks mutations but still allows reading', async () => {
    await archiveRoom(educator, room);

    await expectApiError(requireRoomEducator(educator, room.id), 'room_archived');
    await expect(
      requireRoomEducator(educator, room.id, { allowArchived: true }),
    ).resolves.toBeTruthy();
  });

  it('drops the room from the student’s room list', async () => {
    const student = await addStudent('Aisha Tan');
    const studentUser = await prisma.user.findUniqueOrThrow({ where: { id: student.userId } });

    expect(await listRoomsForStudent(studentUser)).toHaveLength(1);
    await archiveRoom(educator, room);
    expect(await listRoomsForStudent(studentUser)).toHaveLength(0);
  });

  it('refuses to archive twice', async () => {
    const archived = await archiveRoom(educator, room);
    await expectApiError(archiveRoom(educator, archived), 'room_archived');
  });
});

describe('updateRoom', () => {
  it('bumps the version on every change', async () => {
    const updated = await updateRoom({ actor: educator, room, drawCostTokens: 30 });
    expect(updated.drawCostTokens).toBe(30);
    expect(updated.version).toBe(room.version + 1);
  });

  it('rejects a stale write from a second educator', async () => {
    const stale = { ...room };
    await updateRoom({ actor: educator, room, name: 'Enterprise 7B (period 2)' });

    // Second editor still holds the version they loaded.
    await expectApiError(
      updateRoom({ actor: educator, room: stale, expectedVersion: stale.version, drawCostTokens: 40 }),
      'version_conflict',
    );
  });

  it('rejects an empty change set', async () => {
    await expectApiError(updateRoom({ actor: educator, room }), 'validation_failed');
  });
});

describe('roster', () => {
  it('lists enrolled students with their balances', async () => {
    const student = await addStudent('Aisha Tan');
    await awardTokens({
      actor: educator,
      roomId: room.id,
      enrollmentIds: [student.enrollmentId],
      amount: 40,
    });

    const roster = await listRoster(room.id);
    expect(roster).toHaveLength(1);
    expect(roster[0]).toMatchObject({ display_name: 'Aisha Tan', token_balance: 40 });
  });

  /**
   * Removal now zeroes the balance, by explicit product decision — a student
   * taken out of a room should not be able to walk back in later with a term's
   * savings intact, and while they are out the room's totals should not include
   * tokens belonging to someone who is not in it.
   *
   * The zeroing is a compensating ledger row, never a write to the column, so
   * `token_balance = SUM(token_transactions.delta)` still holds and the nightly
   * reconciliation stays green.
   */
  it('zeroes the balance on removal, through the ledger', async () => {
    const student = await addStudent('Aisha Tan');
    await awardTokens({
      actor: educator,
      roomId: room.id,
      enrollmentIds: [student.enrollmentId],
      amount: 40,
    });

    await removeStudent(educator, room.id, student.enrollmentId);

    const enrollment = await prisma.enrollment.findUniqueOrThrow({
      where: { id: student.enrollmentId },
    });
    expect(enrollment.tokenBalance).toBe(0);

    const ledger = await prisma.tokenTransaction.findMany({
      where: { enrollmentId: student.enrollmentId },
    });
    expect(ledger.reduce((sum, row) => sum + row.delta, 0)).toBe(0);

    // Re-adding reactivates the same enrolment rather than making a second one;
    // they simply start again from zero.
    const readded = await prisma.enrollment.update({
      where: { id: student.enrollmentId },
      data: { status: 'active', removedAt: null },
    });
    expect(readded.tokenBalance).toBe(0);
    expect(await prisma.enrollment.count({ where: { roomId: room.id } })).toBe(1);
  });

  it('retains history after removal', async () => {
    const student = await addStudent('Aisha Tan');
    await awardTokens({
      actor: educator,
      roomId: room.id,
      enrollmentIds: [student.enrollmentId],
      amount: 40,
    });
    await removeStudent(educator, room.id, student.enrollmentId);

    // The award, plus the compensating row that zeroed the balance. Nothing is
    // deleted — how they earned the tokens stays answerable.
    expect(
      await prisma.tokenTransaction.count({ where: { enrollmentId: student.enrollmentId } }),
    ).toBe(2);
    const events = await prisma.activityEvent.findMany({
      where: { subjectEnrollmentId: student.enrollmentId },
    });
    expect(events.map((e) => e.type)).toContain('enrollment.removed');
  });

  it('will not award to a removed student', async () => {
    const student = await addStudent('Aisha Tan');
    await removeStudent(educator, room.id, student.enrollmentId);

    await expectApiError(
      awardTokens({
        actor: educator,
        roomId: room.id,
        enrollmentIds: [student.enrollmentId],
        amount: 10,
      }),
      'not_found',
    );
  });

  it('rejects an enrolment id from another room', async () => {
    const other = await createRoom({ actor: educator, schoolId: school.id, name: 'Enterprise 8C' });
    const theirs = await addStudent('Ben Cole', other.id);

    await expectApiError(removeStudent(educator, room.id, theirs.enrollmentId), 'not_found');
  });
});

describe('parseRosterCsv', () => {
  it('reads a bare list of names', () => {
    expect(parseRosterCsv('Aisha Tan\nBen Cole\n')).toEqual([
      { displayName: 'Aisha Tan' },
      { displayName: 'Ben Cole' },
    ]);
  });

  it('skips a header row', () => {
    expect(parseRosterCsv('Name,LoginID\nAisha Tan,s123\n')).toEqual([
      { displayName: 'Aisha Tan', loginId: 's123' },
    ]);
  });

  it('handles quoted names containing commas', () => {
    // "Tan, Aisha" is an ordinary way for a school export to write a name.
    expect(parseRosterCsv('"Tan, Aisha",s123')).toEqual([
      { displayName: 'Tan, Aisha', loginId: 's123' },
    ]);
  });

  it('handles escaped quotes and blank lines', () => {
    expect(parseRosterCsv('\n"Aisha ""AJ"" Tan"\n\n')).toEqual([
      { displayName: 'Aisha "AJ" Tan' },
    ]);
  });

  it('ignores rows with no name', () => {
    expect(parseRosterCsv('Aisha Tan\n,\nBen Cole')).toEqual([
      { displayName: 'Aisha Tan' },
      { displayName: 'Ben Cole' },
    ]);
  });
});

describe('importRoster', () => {
  it('creates and enrols a whole class, returning credentials once', async () => {
    const csv = ['Name', 'Aisha Tan', 'Ben Cole', 'Chi Nwosu'].join('\n');

    const result = await importRoster({
      actor: educator,
      schoolId: school.id,
      roomId: room.id,
      csv,
      ip: testIp,
    });

    expect(result.created).toHaveLength(3);
    expect(result.skipped).toHaveLength(0);
    // Every student now starts on the same known password, by explicit product
    // decision — thirty distinct one-time passwords read aloud is the slowest
    // part of a first lesson and the surest route to a locked account.
    expect(new Set(result.created.map((r) => r.defaultPassword))).toEqual(
      new Set([DEFAULT_STUDENT_PASSWORD]),
    );
    expect(await listRoster(room.id)).toHaveLength(3);
  });

  it('lands the good rows and reports the bad ones instead of aborting', async () => {
    await addStudent('Existing Student');
    const taken = (await listRoster(room.id))[0]!.login_id!;

    const csv = ['Aisha Tan', `Ben Cole,${taken}`, 'Chi Nwosu'].join('\n');

    const result = await importRoster({
      actor: educator,
      schoolId: school.id,
      roomId: room.id,
      csv,
      ip: testIp,
    });

    // An all-or-nothing import of a 30-line paste would be maddening to fix.
    expect(result.created.map((r) => r.displayName)).toEqual(['Aisha Tan', 'Chi Nwosu']);
    expect(result.skipped).toEqual([
      { row: 2, name: 'Ben Cole', reason: 'That login ID is already taken.' },
    ]);
  });

  it('rejects an empty import', async () => {
    await expectApiError(
      importRoster({ actor: educator, schoolId: school.id, roomId: room.id, csv: '\n\n', ip: testIp }),
      'validation_failed',
    );
  });
});

describe('room listings', () => {
  it('shows an educator only the rooms they teach', async () => {
    const colleague = await seedUser({
      schoolId: school.id,
      role: 'educator',
      email: 'alex@school.edu',
      password: 'correct-horse-battery',
    });
    await createRoom({ actor: colleague, schoolId: school.id, name: 'Enterprise 9A' });

    const mine = await listRoomsForEducator(educator);
    expect(mine.map((r) => r.name)).toEqual(['Enterprise 7B']);
  });

  it('shows a school admin every room in the school', async () => {
    const admin = await seedUser({
      schoolId: school.id,
      role: 'school_admin',
      email: 'head@school.edu',
      password: 'correct-horse-battery',
    });
    await createRoom({ actor: educator, schoolId: school.id, name: 'Enterprise 9A' });

    expect(await listRoomsForEducator(admin)).toHaveLength(2);
  });

  it('gives a student one entry per room with independent balances', async () => {
    const other = await createRoom({ actor: educator, schoolId: school.id, name: 'Enterprise 8C' });
    const student = await addStudent('Aisha Tan');
    const studentUser = await prisma.user.findUniqueOrThrow({ where: { id: student.userId } });
    const second = await prisma.enrollment.create({
      data: { roomId: other.id, studentId: student.userId },
    });

    await awardTokens({
      actor: educator,
      roomId: room.id,
      enrollmentIds: [student.enrollmentId],
      amount: 45,
    });
    await awardTokens({ actor: educator, roomId: other.id, enrollmentIds: [second.id], amount: 10 });

    const rooms = await listRoomsForStudent(studentUser);
    expect(rooms).toHaveLength(2);

    const first = rooms.find((r) => r.room_id === room.id)!;
    expect(first.token_balance).toBe(45);
    // 45 tokens at 20 per draw is two draws, not two and a bit.
    expect(first.draws_affordable).toBe(2);
    expect(rooms.find((r) => r.room_id === other.id)!.token_balance).toBe(10);
  });
});
