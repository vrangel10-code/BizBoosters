import { randomUUID } from 'node:crypto';
import { beforeEach, afterAll, describe, expect, it } from 'vitest';
import type { Room, School, User } from '@prisma/client';
import { prisma, resetDatabase, createSchool, seedUser, testIp } from './helpers';
import { archiveRoom, createRoom } from '../src/server/services/rooms';
import { createAndEnrollStudent } from '../src/server/services/roster';
import { createCard } from '../src/server/services/cards';
import { setDeck } from '../src/server/services/decks';
import { awardTokens } from '../src/server/services/tokens';
import { drawCard } from '../src/server/services/draws';
import { useCard } from '../src/server/services/card-actions';
import {
  cloneRoom,
  deleteRoom,
  deleteStudent,
  findExpiredRooms,
  previewStudentDeletion,
  pruneExpiredSessions,
} from '../src/server/services/retention';
import { csvCell, exportActivityCsv, exportRosterCsv, exportStudentData, toCsv } from '../src/server/services/exports';
import { findBalanceDrift, findCopyDrift } from '../src/server/services/reconciliation';
import { ApiError } from '../src/server/errors';

let school: School;
let educator: User;
let admin: User;
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
  admin = await seedUser({
    schoolId: school.id,
    role: 'school_admin',
    email: 'head@school.edu',
    password: 'correct-horse-battery',
  });
  room = await createRoom({ actor: educator, schoolId: school.id, name: 'Enterprise 7B' });
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function stockedStudent(name = 'Aisha Tan') {
  const card = await createCard({
    actor: educator,
    schoolId: school.id,
    name: `Card ${randomUUID().slice(0, 6)}`,
    rarity: 'C',
  });
  const existing = await prisma.roomCard.findMany({ where: { roomId: room.id } });
  await setDeck(educator, room, [
    ...existing.map((row) => ({ card_id: row.cardId, copies_total: row.copiesTotal })),
    { card_id: card.id, copies_total: 5 },
  ]);

  const student = await createAndEnrollStudent({
    actor: educator,
    schoolId: school.id,
    roomId: room.id,
    displayName: name,
    ip: testIp,
  });
  await awardTokens({
    actor: educator,
    roomId: room.id,
    enrollmentIds: [student.enrollmentId],
    amount: 200,
  });
  const user = await prisma.user.findUniqueOrThrow({ where: { id: student.userId } });
  return { ...student, user, cardId: card.id };
}

const draw = (student: { enrollmentId: string; user: User }) =>
  drawCard({
    actor: student.user,
    room,
    enrollmentId: student.enrollmentId,
    idempotencyKey: randomUUID(),
  });

describe('csv escaping', () => {
  it('quotes commas, quotes and newlines', () => {
    expect(csvCell('Tan, Aisha')).toBe('"Tan, Aisha"');
    expect(csvCell('She said "hi"')).toBe('"She said ""hi"""');
    expect(csvCell('line one\nline two')).toBe('"line one\nline two"');
  });

  it('defuses spreadsheet formulas', () => {
    // These files are opened by teachers on school machines; a note beginning
    // with = is a formula injection, not a note.
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('+SUM(A1)')).toBe("'+SUM(A1)");
    expect(csvCell('@import')).toBe("'@import");
    expect(csvCell('-2')).toBe("'-2");
  });

  it('starts with a BOM so Excel reads UTF-8 names correctly', () => {
    expect(toCsv(['a'], [['陈伟明']]).startsWith('﻿')).toBe(true);
  });
});

describe('exports', () => {
  it('describes each activity row in words, not event codes', async () => {
    const student = await stockedStudent();
    await draw(student);

    const csv = await exportActivityCsv({ roomId: room.id });
    expect(csv).toContain('Drew ');
    expect(csv).toContain('Awarded 200 tokens');
    expect(csv).toContain('Aisha Tan');
  });

  it('summarises the roster with tokens earned and cards held', async () => {
    const student = await stockedStudent();
    const drawn = await draw(student);
    await useCard(student.user, room, student.enrollmentId, drawn.inventoryItemId);
    await draw(student);

    const csv = await exportRosterCsv(room.id);
    const line = csv.split('\r\n').find((row) => row.startsWith('Aisha Tan'))!;
    const cells = line.split(',');

    expect(cells[2]).toBe('160'); // 200 − two draws
    expect(cells[3]).toBe('200'); // earned
    expect(cells[4]).toBe('1'); // held
    expect(cells[5]).toBe('1'); // used
  });

  it('exports everything held about one student', async () => {
    const student = await stockedStudent();
    await draw(student);

    const data = await exportStudentData(student.userId);

    expect(data.student.display_name).toBe('Aisha Tan');
    expect(data.rooms).toHaveLength(1);
    expect(data.rooms[0]?.token_history.length).toBeGreaterThan(0);
    expect(data.rooms[0]?.cards).toHaveLength(1);
    expect(data.rooms[0]?.draws).toHaveLength(1);

    // No credential material anywhere in a subject-access export.
    const serialized = JSON.stringify(data);
    expect(serialized).not.toMatch(/passwordHash|password_hash|tokenHash/);
  });
});

describe('deleteStudent', () => {
  it('previews the damage before doing anything', async () => {
    const student = await stockedStudent();
    await draw(student);

    const preview = await previewStudentDeletion(educator, student.userId);
    expect(preview).toMatchObject({ studentName: 'Aisha Tan', rooms: 1, draws: 1 });

    // Nothing destroyed by looking.
    expect(await prisma.user.count({ where: { id: student.userId } })).toBe(1);
  });

  it('requires the student’s name typed exactly', async () => {
    const student = await stockedStudent();
    await expectApiError(
      deleteStudent(educator, student.userId, 'yes', testIp),
      'confirmation_required',
    );
    await expectApiError(
      deleteStudent(educator, student.userId, 'aisha tan', testIp),
      'confirmation_required',
    );
  });

  it('really deletes — no hidden flag', async () => {
    const student = await stockedStudent();
    await draw(student);

    await deleteStudent(educator, student.userId, 'Aisha Tan', testIp);

    expect(await prisma.user.count({ where: { id: student.userId } })).toBe(0);
    expect(await prisma.enrollment.count({ where: { studentId: student.userId } })).toBe(0);
    expect(await prisma.tokenTransaction.count({ where: { enrollmentId: student.enrollmentId } })).toBe(0);
    expect(await prisma.inventoryItem.count({ where: { enrollmentId: student.enrollmentId } })).toBe(0);
    expect(await prisma.draw.count({ where: { enrollmentId: student.enrollmentId } })).toBe(0);
  });

  it('returns held cards to the deck rather than destroying copies', async () => {
    const student = await stockedStudent();
    await draw(student);
    await draw(student);

    const before = await prisma.roomCard.aggregate({
      where: { roomId: room.id },
      _sum: { copiesRemaining: true, copiesTotal: true },
    });
    expect(before._sum.copiesRemaining).toBe(3);

    await deleteStudent(educator, student.userId, 'Aisha Tan', testIp);

    const after = await prisma.roomCard.aggregate({
      where: { roomId: room.id },
      _sum: { copiesRemaining: true, copiesTotal: true },
    });
    // Erasing a student must not leave the room's deck permanently short.
    expect(after._sum.copiesRemaining).toBe(5);
    expect(after._sum.copiesTotal).toBe(before._sum.copiesTotal);
    await expectIntegrity();
  });

  it('leaves an audit record of the erasure', async () => {
    const student = await stockedStudent();
    await deleteStudent(educator, student.userId, 'Aisha Tan', testIp);

    const entry = await prisma.auditLog.findFirstOrThrow({ where: { action: 'student.deleted' } });
    expect(entry.payload).toMatchObject({ studentName: 'Aisha Tan' });
  });

  it('refuses a student at another school', async () => {
    const other = await createSchool('Southgate High');
    const otherEducator = await seedUser({
      schoolId: other.id,
      role: 'educator',
      email: 'other@southgate.edu',
      password: 'correct-horse-battery',
    });
    const student = await stockedStudent();

    await expectApiError(
      previewStudentDeletion(otherEducator, student.userId),
      'not_found',
    );
  });
});

describe('deleteRoom', () => {
  it('refuses a live room', async () => {
    await expectApiError(
      deleteRoom(admin, room, 'Enterprise 7B', testIp),
      'validation_failed',
    );
  });

  it('deletes an archived room but keeps the student accounts', async () => {
    const student = await stockedStudent();
    await draw(student);
    const archived = await archiveRoom(educator, room);

    await deleteRoom(admin, archived, 'Enterprise 7B', testIp);

    expect(await prisma.room.count({ where: { id: room.id } })).toBe(0);
    // The account may be in other rooms; it is not this room's to erase.
    expect(await prisma.user.count({ where: { id: student.userId } })).toBe(1);
  });

  it('requires the room name typed exactly', async () => {
    const archived = await archiveRoom(educator, room);
    await expectApiError(deleteRoom(admin, archived, 'wrong', testIp), 'confirmation_required');
  });
});

describe('cloneRoom', () => {
  it('copies the deck configuration and settings, not the state', async () => {
    const student = await stockedStudent();
    await draw(student);
    await draw(student);

    const clone = await cloneRoom(educator, room, 'Enterprise 7B (2027)', testIp);

    expect(clone.drawCostTokens).toBe(room.drawCostTokens);
    expect(clone.tradeRatio).toBe(room.tradeRatio);

    const sourceDeck = await prisma.roomCard.findMany({ where: { roomId: room.id } });
    const cloneDeck = await prisma.roomCard.findMany({ where: { roomId: clone.id } });

    expect(cloneDeck).toHaveLength(sourceDeck.length);
    // A fresh room starts full: copying `copiesRemaining` would import last
    // term's hoarding.
    expect(cloneDeck.every((row) => row.copiesRemaining === row.copiesTotal)).toBe(true);
    expect(sourceDeck[0]!.copiesRemaining).toBe(3);
  });

  it('brings no students, tokens or history', async () => {
    const student = await stockedStudent();
    await draw(student);

    const clone = await cloneRoom(educator, room, 'Enterprise 7B (2027)', testIp);

    expect(await prisma.enrollment.count({ where: { roomId: clone.id } })).toBe(0);
    expect(await prisma.inventoryItem.count({ where: { roomId: clone.id } })).toBe(0);
    expect(await prisma.draw.count({ where: { roomId: clone.id } })).toBe(0);
  });

  it('makes the cloner the owner', async () => {
    const clone = await cloneRoom(educator, room, 'Enterprise 7B (2027)', testIp);
    const membership = await prisma.roomEducator.findUniqueOrThrow({
      where: { roomId_userId: { roomId: clone.id, userId: educator.id } },
    });
    expect(membership.role).toBe('owner');
  });

  it('can clone an archived room, which is the actual use case', async () => {
    const archived = await archiveRoom(educator, room);
    const clone = await cloneRoom(educator, archived, 'Next year', testIp);
    expect(clone.status).toBe('active');
  });
});

describe('retention sweep', () => {
  it('reports archived rooms past the window rather than deleting them', async () => {
    const archived = await archiveRoom(educator, room);
    await prisma.room.update({
      where: { id: archived.id },
      data: { archivedAt: new Date(Date.now() - 600 * 24 * 60 * 60 * 1000) },
    });

    const expired = await findExpiredRooms(548);
    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({ name: 'Enterprise 7B' });

    // Reported only: a job that silently erases a term of work is not something
    // to run unattended.
    expect(await prisma.room.count({ where: { id: room.id } })).toBe(1);
  });

  it('ignores rooms inside the window', async () => {
    await archiveRoom(educator, room);
    expect(await findExpiredRooms(548)).toHaveLength(0);
  });

  it('sweeps long-expired sessions', async () => {
    const student = await stockedStudent();
    await prisma.session.create({
      data: {
        userId: student.userId,
        tokenHash: randomUUID(),
        expiresAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      },
    });
    await prisma.session.create({
      data: { userId: student.userId, tokenHash: randomUUID(), expiresAt: new Date(Date.now() + 60_000) },
    });

    expect(await pruneExpiredSessions()).toBe(1);
    expect(await prisma.session.count()).toBe(1);
  });
});
