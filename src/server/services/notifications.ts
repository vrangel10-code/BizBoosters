import type { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { apiError } from '../errors';

/**
 * Notifications are rows first, transport second.
 *
 * Every one is written inside the transaction that caused it, so a rolled-back
 * action can never leave a phantom notification and a dropped SSE connection
 * can never lose a real one. Pushing is best-effort on top; the client
 * reconciles from this table on reconnect.
 */
export type NotificationType =
  | 'card.drawn'
  | 'card.traded'
  | 'card.used'
  | 'card.returned'
  | 'tokens.awarded'
  | 'tokens.adjusted'
  | 'pool.low'
  | 'pool.empty';

export interface NotificationInput {
  recipientUserId: string;
  roomId?: string | null;
  activityEventId?: string | null;
  type: NotificationType;
  payload?: Prisma.InputJsonValue;
}

export async function createNotifications(
  entries: NotificationInput[],
  tx: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<void> {
  if (entries.length === 0) return;
  await tx.notification.createMany({
    data: entries.map((entry) => ({
      recipientUserId: entry.recipientUserId,
      roomId: entry.roomId ?? null,
      activityEventId: entry.activityEventId ?? null,
      type: entry.type,
      payload: (entry.payload ?? {}) as Prisma.InputJsonValue,
    })),
  });
}

/** The educators to notify about something happening in a room. */
export async function roomEducatorIds(
  roomId: string,
  tx: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<string[]> {
  const rows = await tx.roomEducator.findMany({
    where: { roomId },
    select: { userId: true },
  });
  return rows.map((row) => row.userId);
}

export interface NotificationView {
  id: string;
  type: string;
  room_id: string | null;
  payload: Prisma.JsonValue;
  read_at: string | null;
  created_at: string;
}

export async function listNotifications(
  userId: string,
  options: { unreadOnly?: boolean; limit?: number } = {},
): Promise<{ data: NotificationView[]; unread: number }> {
  const [rows, unread] = await Promise.all([
    prisma.notification.findMany({
      where: { recipientUserId: userId, ...(options.unreadOnly ? { readAt: null } : {}) },
      orderBy: { createdAt: 'desc' },
      take: Math.min(options.limit ?? 50, 200),
    }),
    prisma.notification.count({ where: { recipientUserId: userId, readAt: null } }),
  ]);

  return {
    data: rows.map((row) => ({
      id: row.id,
      type: row.type,
      room_id: row.roomId,
      payload: row.payload,
      read_at: row.readAt?.toISOString() ?? null,
      created_at: row.createdAt.toISOString(),
    })),
    unread,
  };
}

export async function markRead(
  userId: string,
  options: { ids?: string[]; all?: boolean },
): Promise<number> {
  if (!options.all && (!options.ids || options.ids.length === 0)) {
    throw apiError('validation_failed', 'Pass ids or all: true.');
  }

  const { count } = await prisma.notification.updateMany({
    // Scoped to the recipient, so passing another user's ids marks nothing.
    where: {
      recipientUserId: userId,
      readAt: null,
      ...(options.all ? {} : { id: { in: options.ids } }),
    },
    data: { readAt: new Date() },
  });

  return count;
}

export async function unreadCount(userId: string): Promise<number> {
  return prisma.notification.count({ where: { recipientUserId: userId, readAt: null } });
}
