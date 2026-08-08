import type { Room, User } from '@prisma/client';
import { prisma } from '../db';
import { apiError } from '../errors';
import { recordAudit } from './audit';
import { revokeAllSessionsForUser } from '../auth/session';

/**
 * Data retention and erasure.
 *
 * The users here are children, so "delete" has to mean delete — not a hidden
 * flag. These functions really remove rows, and each one says precisely what it
 * destroys so nobody discovers the scope afterwards.
 */

export interface DeletionPreview {
  studentName: string;
  rooms: number;
  tokenTransactions: number;
  inventoryItems: number;
  draws: number;
  activityEvents: number;
}

/** What erasing this student would destroy. Shown before anything happens. */
export async function previewStudentDeletion(
  actor: User,
  studentId: string,
): Promise<DeletionPreview> {
  const student = await prisma.user.findUnique({ where: { id: studentId } });
  if (!student || student.role !== 'student' || student.schoolId !== actor.schoolId) {
    throw apiError('not_found', 'Not found.');
  }

  const enrollmentIds = (
    await prisma.enrollment.findMany({ where: { studentId }, select: { id: true } })
  ).map((row) => row.id);

  const [tokenTransactions, inventoryItems, draws, activityEvents] = await Promise.all([
    prisma.tokenTransaction.count({ where: { enrollmentId: { in: enrollmentIds } } }),
    prisma.inventoryItem.count({ where: { enrollmentId: { in: enrollmentIds } } }),
    prisma.draw.count({ where: { enrollmentId: { in: enrollmentIds } } }),
    prisma.activityEvent.count({ where: { subjectEnrollmentId: { in: enrollmentIds } } }),
  ]);

  return {
    studentName: student.displayName,
    rooms: enrollmentIds.length,
    tokenTransactions,
    inventoryItems,
    draws,
    activityEvents,
  };
}

/**
 * Erases a student and everything about them.
 *
 * Held cards are returned to their rooms' decks first — otherwise deleting a
 * student would quietly destroy copies and leave every affected deck short for
 * the rest of term. Erasure must not corrupt the rooms the student leaves
 * behind.
 */
export async function deleteStudent(
  actor: User,
  studentId: string,
  confirmation: string,
  ip: string,
): Promise<DeletionPreview> {
  const preview = await previewStudentDeletion(actor, studentId);

  if (confirmation.trim() !== preview.studentName) {
    throw apiError('confirmation_required', 'Type the student’s name exactly to confirm.', {
      expected: preview.studentName,
    });
  }

  await prisma.$transaction(async (tx) => {
    const enrollments = await tx.enrollment.findMany({
      where: { studentId },
      select: { id: true, roomId: true },
    });

    for (const enrollment of enrollments) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${enrollment.roomId}, 0))`;

      const held = await tx.inventoryItem.findMany({
        where: { enrollmentId: enrollment.id, state: 'owned' },
        select: { cardId: true },
      });

      for (const item of held) {
        await tx.$executeRaw`
          UPDATE room_cards
             SET copies_remaining = copies_remaining + 1
           WHERE room_id = ${enrollment.roomId}::uuid AND card_id = ${item.cardId}::uuid
             AND copies_remaining < copies_total
        `;
      }
    }

    // Cascades take the enrolments, ledger, inventory, draws and activity.
    await tx.user.delete({ where: { id: studentId } });
  });

  await recordAudit({
    action: 'student.deleted',
    actorUserId: actor.id,
    payload: { ...preview, student_id: studentId },
    ip,
  });

  return preview;
}

export interface ArchivedRoomSummary {
  roomId: string;
  name: string;
  archivedAt: string | null;
  students: number;
  ageInDays: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Archived rooms older than the retention window. Reported rather than deleted:
 * a scheduled job that silently erases a term's work is not something to run
 * unattended, so a human confirms.
 */
export async function findExpiredRooms(retentionDays = 548): Promise<ArchivedRoomSummary[]> {
  const cutoff = new Date(Date.now() - retentionDays * DAY_MS);

  const rooms = await prisma.room.findMany({
    where: { status: 'archived', archivedAt: { lt: cutoff } },
    include: { _count: { select: { enrollments: true } } },
  });

  return rooms.map((room) => ({
    roomId: room.id,
    name: room.name,
    archivedAt: room.archivedAt?.toISOString() ?? null,
    students: room._count.enrollments,
    ageInDays: room.archivedAt
      ? Math.floor((Date.now() - room.archivedAt.getTime()) / DAY_MS)
      : 0,
  }));
}

/**
 * Deletes an archived room and its game history. Student *accounts* survive —
 * they may be in other rooms, and an account is not a room's data to erase.
 */
export async function deleteRoom(
  actor: User,
  room: Room,
  confirmation: string,
  ip: string,
): Promise<void> {
  if (room.status !== 'archived') {
    throw apiError('validation_failed', 'Archive the room before deleting it.');
  }
  if (confirmation.trim() !== room.name) {
    throw apiError('confirmation_required', 'Type the room name exactly to confirm.', {
      expected: room.name,
    });
  }

  const counts = await prisma.enrollment.count({ where: { roomId: room.id } });
  await prisma.room.delete({ where: { id: room.id } });

  await recordAudit({
    action: 'room.deleted',
    actorUserId: actor.id,
    payload: { room_id: room.id, name: room.name, enrollments: counts },
    ip,
  });
}

/**
 * Copies a room's deck configuration into a new room. Next term's setup is
 * otherwise a manual re-entry of twenty copy counts, which is exactly the kind
 * of chore that stops a teacher using the tool a second year.
 */
export async function cloneRoom(
  actor: User,
  source: Room,
  name: string,
  ip: string,
): Promise<Room> {
  const trimmed = name.trim();
  if (!trimmed) throw apiError('validation_failed', 'A room name is required.');

  const created = await prisma.$transaction(async (tx) => {
    const room = await tx.room.create({
      data: {
        schoolId: source.schoolId,
        name: trimmed,
        createdBy: actor.id,
        drawCostTokens: source.drawCostTokens,
        tradesEnabled: source.tradesEnabled,
        tradeRatio: source.tradeRatio,
        studentsSeeOdds: source.studentsSeeOdds,
        lowStockThreshold: source.lowStockThreshold,
        educators: { create: { userId: actor.id, role: 'owner' } },
      },
    });

    const rarities = await tx.roomRarity.findMany({ where: { roomId: source.id } });
    if (rarities.length > 0) {
      await tx.roomRarity.createMany({
        data: rarities.map((rarity) => ({
          roomId: room.id,
          code: rarity.code,
          label: rarity.label,
          colorHex: rarity.colorHex,
          sortOrder: rarity.sortOrder,
        })),
      });
    }

    const deck = await tx.roomCard.findMany({ where: { roomId: source.id } });
    if (deck.length > 0) {
      await tx.roomCard.createMany({
        data: deck.map((entry) => ({
          roomId: room.id,
          cardId: entry.cardId,
          // A fresh room starts with every copy in the deck. Copying
          // `copiesRemaining` would import the old room's hoarding.
          copiesTotal: entry.copiesTotal,
          copiesRemaining: entry.copiesTotal,
        })),
      });
    }

    await tx.activityEvent.create({
      data: {
        roomId: room.id,
        type: 'room.created',
        actorUserId: actor.id,
        payload: { name: room.name, cloned_from: source.name, cards: deck.length },
      },
    });

    return room;
  });

  await recordAudit({
    action: 'room.cloned',
    actorUserId: actor.id,
    payload: { source_room_id: source.id, new_room_id: created.id },
    ip,
  });

  return created;
}

/** Sessions and stale rate-limit windows are debris; sweep them nightly. */
export async function pruneExpiredSessions(): Promise<number> {
  const { count } = await prisma.session.deleteMany({
    where: {
      OR: [
        { expiresAt: { lt: new Date(Date.now() - 7 * DAY_MS) } },
        { revokedAt: { lt: new Date(Date.now() - 7 * DAY_MS) } },
      ],
    },
  });
  return count;
}

/** Revokes every session for a student — "sign them out of everything". */
export async function signOutStudentEverywhere(
  actor: User,
  studentId: string,
  ip: string,
): Promise<number> {
  const student = await prisma.user.findUnique({ where: { id: studentId } });
  if (!student || student.role !== 'student' || student.schoolId !== actor.schoolId) {
    throw apiError('not_found', 'Not found.');
  }

  const revoked = await revokeAllSessionsForUser(studentId);
  await recordAudit({
    action: 'student.sessions_revoked',
    actorUserId: actor.id,
    targetUserId: studentId,
    payload: { revoked },
    ip,
  });
  return revoked;
}
