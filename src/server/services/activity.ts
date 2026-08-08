import type { Prisma } from '@prisma/client';
import { prisma } from '../db';

/**
 * The room's shared history. One vocabulary drives the educator's room log, the
 * student's own history and (from phase 4) notifications — see
 * docs/MECHANICS.md §7.
 */
export type ActivityType =
  | 'tokens.awarded'
  | 'tokens.adjusted'
  | 'tokens.undone'
  | 'enrollment.added'
  | 'enrollment.removed'
  | 'room.created'
  | 'room.settings_changed'
  | 'room.archived';

export interface ActivityInput {
  roomId: string;
  type: ActivityType;
  actorUserId?: string | null;
  /** Null for room-wide events that are not about one student. */
  subjectEnrollmentId?: string | null;
  payload?: Prisma.InputJsonValue;
}

export async function recordActivity(
  entry: ActivityInput,
  tx: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<void> {
  await tx.activityEvent.create({
    data: {
      roomId: entry.roomId,
      type: entry.type,
      actorUserId: entry.actorUserId ?? null,
      subjectEnrollmentId: entry.subjectEnrollmentId ?? null,
      payload: entry.payload ?? {},
    },
  });
}

export async function recordActivityMany(
  entries: ActivityInput[],
  tx: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<void> {
  if (entries.length === 0) return;
  await tx.activityEvent.createMany({
    data: entries.map((entry) => ({
      roomId: entry.roomId,
      type: entry.type,
      actorUserId: entry.actorUserId ?? null,
      subjectEnrollmentId: entry.subjectEnrollmentId ?? null,
      payload: (entry.payload ?? {}) as Prisma.InputJsonValue,
    })),
  });
}

export interface ActivityFilter {
  roomId: string;
  /** Set for the student view; the server never accepts it from a student. */
  subjectEnrollmentId?: string;
  /** Student view: also include room-wide events, which have no subject. */
  includeRoomWide?: boolean;
  type?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  cursor?: string;
}

export interface ActivityRow {
  id: string;
  type: string;
  createdAt: Date;
  actorName: string | null;
  subjectName: string | null;
  subjectEnrollmentId: string | null;
  payload: Prisma.JsonValue;
}

export async function listActivity(filter: ActivityFilter): Promise<{
  rows: ActivityRow[];
  nextCursor: string | null;
}> {
  const limit = Math.min(filter.limit ?? 50, 200);

  const subjectClause: Prisma.ActivityEventWhereInput | undefined = filter.subjectEnrollmentId
    ? filter.includeRoomWide
      ? {
          OR: [
            { subjectEnrollmentId: filter.subjectEnrollmentId },
            { subjectEnrollmentId: null },
          ],
        }
      : { subjectEnrollmentId: filter.subjectEnrollmentId }
    : undefined;

  const rows = await prisma.activityEvent.findMany({
    where: {
      roomId: filter.roomId,
      ...(filter.type ? { type: filter.type } : {}),
      ...(filter.from || filter.to
        ? { createdAt: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) } }
        : {}),
      ...(subjectClause ?? {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(filter.cursor ? { cursor: { id: filter.cursor }, skip: 1 } : {}),
    include: {
      actor: { select: { displayName: true } },
      subject: { select: { id: true, student: { select: { displayName: true } } } },
    },
  });

  const page = rows.slice(0, limit);

  return {
    rows: page.map((row) => ({
      id: row.id,
      type: row.type,
      createdAt: row.createdAt,
      actorName: row.actor?.displayName ?? null,
      subjectName: row.subject?.student.displayName ?? null,
      subjectEnrollmentId: row.subjectEnrollmentId,
      payload: row.payload,
    })),
    nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
  };
}
