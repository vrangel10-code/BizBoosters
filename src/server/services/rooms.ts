import type { Room, User } from '@prisma/client';
import { prisma } from '../db';
import { apiError } from '../errors';
import { recordActivity } from './activity';

export interface CreateRoomInput {
  actor: User;
  schoolId: string;
  name: string;
  drawCostTokens?: number;
}

export async function createRoom({
  actor,
  schoolId,
  name,
  drawCostTokens,
}: CreateRoomInput): Promise<Room> {
  const trimmed = name.trim();
  if (!trimmed) throw apiError('validation_failed', 'A room name is required.');

  return prisma.$transaction(async (tx) => {
    const room = await tx.room.create({
      data: {
        schoolId,
        name: trimmed,
        createdBy: actor.id,
        ...(drawCostTokens !== undefined ? { drawCostTokens } : {}),
        // The creator is the owner; co-teachers are added as assistants. A
        // single owner_id column would have needed replacing within a term.
        educators: { create: { userId: actor.id, role: 'owner' } },
      },
    });

    await recordActivity(
      {
        roomId: room.id,
        type: 'room.created',
        actorUserId: actor.id,
        payload: { name: room.name, draw_cost_tokens: room.drawCostTokens },
      },
      tx,
    );

    return room;
  });
}

/** Rooms this educator teaches. School admins see every room in the school. */
export async function listRoomsForEducator(user: User) {
  const rooms = await prisma.room.findMany({
    where:
      user.role === 'school_admin' || user.role === 'super_admin'
        ? { schoolId: user.schoolId ?? undefined }
        : { educators: { some: { userId: user.id } } },
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    include: {
      _count: { select: { enrollments: { where: { status: 'active' } } } },
    },
  });

  return rooms.map((room) => ({
    id: room.id,
    name: room.name,
    status: room.status,
    draw_cost_tokens: room.drawCostTokens,
    student_count: room._count.enrollments,
    created_at: room.createdAt.toISOString(),
  }));
}

/** Rooms this student is enrolled in, each with its own independent balance. */
export async function listRoomsForStudent(user: User) {
  const enrollments = await prisma.enrollment.findMany({
    where: { studentId: user.id, status: 'active', room: { status: { not: 'archived' } } },
    orderBy: { joinedAt: 'asc' },
    include: { room: true },
  });

  return enrollments.map((enrollment) => ({
    room_id: enrollment.room.id,
    enrollment_id: enrollment.id,
    name: enrollment.room.name,
    token_balance: enrollment.tokenBalance,
    draw_cost_tokens: enrollment.room.drawCostTokens,
    /** Surfaced so the UI can show "2 more tokens for a draw" rather than maths. */
    draws_affordable: Math.floor(enrollment.tokenBalance / enrollment.room.drawCostTokens),
  }));
}

export interface UpdateRoomInput {
  actor: User;
  room: Room;
  expectedVersion?: number;
  name?: string;
  drawCostTokens?: number;
  tradesEnabled?: boolean;
  tradeRatio?: number;
  studentsSeeOdds?: boolean;
  lowStockThreshold?: number;
}

export async function updateRoom(input: UpdateRoomInput): Promise<Room> {
  const { actor, room, expectedVersion, ...fields } = input;

  if (expectedVersion !== undefined && expectedVersion !== room.version) {
    throw apiError('version_conflict', 'Someone else changed this room. Reload and try again.', {
      current_version: room.version,
    });
  }

  const changes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) changes[key] = value;
  }
  if (Object.keys(changes).length === 0) {
    throw apiError('validation_failed', 'Nothing to change.');
  }
  if (typeof changes.name === 'string') {
    changes.name = changes.name.trim();
    if (!changes.name) throw apiError('validation_failed', 'A room name is required.');
  }

  return prisma.$transaction(async (tx) => {
    // The version predicate is the actual guard; the check above is only there
    // to give a clean error before doing any work.
    const claimed = await tx.room.updateMany({
      where: { id: room.id, version: room.version },
      data: { ...changes, version: { increment: 1 } },
    });
    if (claimed.count === 0) {
      throw apiError('version_conflict', 'Someone else changed this room. Reload and try again.');
    }

    await recordActivity(
      {
        roomId: room.id,
        type: 'room.settings_changed',
        actorUserId: actor.id,
        payload: { changed: Object.keys(changes) },
      },
      tx,
    );

    return tx.room.findUniqueOrThrow({ where: { id: room.id } });
  });
}

export async function archiveRoom(actor: User, room: Room): Promise<Room> {
  if (room.status === 'archived') {
    throw apiError('room_archived', 'That room is already archived.');
  }

  return prisma.$transaction(async (tx) => {
    const archived = await tx.room.update({
      where: { id: room.id },
      data: { status: 'archived', archivedAt: new Date(), version: { increment: 1 } },
    });

    await recordActivity(
      { roomId: room.id, type: 'room.archived', actorUserId: actor.id, payload: {} },
      tx,
    );

    return archived;
  });
}

/** Co-teachers and cover staff. A room is rarely one person's for a whole term. */
export async function addRoomEducator(
  actor: User,
  roomId: string,
  educatorId: string,
): Promise<void> {
  const educator = await prisma.user.findUnique({ where: { id: educatorId } });
  if (
    !educator ||
    educator.schoolId !== actor.schoolId ||
    educator.role === 'student' ||
    !educator.isActive
  ) {
    throw apiError('not_found', 'Not found.');
  }

  await prisma.roomEducator.upsert({
    where: { roomId_userId: { roomId, userId: educatorId } },
    create: { roomId, userId: educatorId, role: 'assistant' },
    update: {},
  });
}
