import { prisma } from '../db';
import { listActivity } from './activity';

/**
 * RFC 4180 quoting. Excel is the destination for most of these, and a student
 * name containing a comma or a reason containing a newline must not shift every
 * subsequent column.
 *
 * The leading apostrophe on formula-leading characters is deliberate: a note of
 * `=cmd|...` is a spreadsheet injection, and these files are opened by teachers
 * on school machines.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\n\r]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  // BOM so Excel opens UTF-8 names correctly rather than mojibake.
  const lines = [headers.map(csvCell).join(','), ...rows.map((row) => row.map(csvCell).join(','))];
  return `﻿${lines.join('\r\n')}\r\n`;
}

const describeEvent = (type: string, payload: Record<string, unknown>): string => {
  const amount = payload.amount;
  const card = payload.card_name;
  switch (type) {
    case 'tokens.awarded':
      return `Awarded ${String(amount ?? '?')} tokens`;
    case 'tokens.adjusted':
      return `Adjusted by ${String(payload.delta ?? '?')} tokens`;
    case 'tokens.undone':
      return `Award undone (${String(payload.delta ?? '?')} tokens)`;
    case 'card.drawn':
      return `Drew ${String(card ?? 'a card')}`;
    case 'card.used':
      return `Used ${String(card ?? 'a card')}`;
    case 'card.returned':
      return `Returned ${String(card ?? 'a card')} to the deck`;
    case 'card.traded':
      return `Traded up to ${String(card ?? 'a card')}`;
    case 'enrollment.added':
      return 'Joined the room';
    case 'enrollment.removed':
      return 'Removed from the room';
    case 'pool.reset':
      return 'Deck reset';
    case 'pool.updated':
      return 'Deck changed';
    case 'pool.low':
      return `Deck low (${String(payload.in_deck ?? '?')} left)`;
    case 'pool.empty':
      return 'Deck empty';
    default:
      return type;
  }
};

export interface ActivityExportFilter {
  roomId: string;
  enrollmentId?: string;
  type?: string;
  from?: Date;
  to?: Date;
}

export async function exportActivityCsv(filter: ActivityExportFilter): Promise<string> {
  const { rows } = await listActivity({ ...filter, limit: 5000 });

  return toCsv(
    ['When (UTC)', 'Type', 'Student', 'Description', 'By', 'Note'],
    rows.map((row) => {
      const payload = (row.payload ?? {}) as Record<string, unknown>;
      return [
        row.createdAt.toISOString(),
        row.type,
        row.subjectName ?? '',
        describeEvent(row.type, payload),
        row.actorName ?? '',
        typeof payload.note === 'string' ? payload.note : '',
      ];
    }),
  );
}

/** The end-of-term summary a teacher wants for their own records. */
export async function exportRosterCsv(roomId: string): Promise<string> {
  const enrollments = await prisma.enrollment.findMany({
    where: { roomId, status: 'active' },
    orderBy: { student: { displayName: 'asc' } },
    include: {
      student: { select: { displayName: true, loginId: true, lastLoginAt: true } },
      _count: { select: { inventory: true } },
    },
  });

  const held = await prisma.inventoryItem.groupBy({
    by: ['enrollmentId'],
    where: { roomId, state: 'owned' },
    _count: true,
  });
  const used = await prisma.inventoryItem.groupBy({
    by: ['enrollmentId'],
    where: { roomId, state: 'used' },
    _count: true,
  });
  const earned = await prisma.tokenTransaction.groupBy({
    by: ['enrollmentId'],
    where: { enrollment: { roomId }, delta: { gt: 0 } },
    _sum: { delta: true },
  });

  const heldBy = new Map(held.map((row) => [row.enrollmentId, row._count]));
  const usedBy = new Map(used.map((row) => [row.enrollmentId, row._count]));
  const earnedBy = new Map(earned.map((row) => [row.enrollmentId, row._sum.delta ?? 0]));

  return toCsv(
    ['Student', 'Login ID', 'Tokens now', 'Tokens earned', 'Cards held', 'Cards used', 'Last seen'],
    enrollments.map((enrollment) => [
      enrollment.student.displayName,
      enrollment.student.loginId ?? '',
      enrollment.tokenBalance,
      earnedBy.get(enrollment.id) ?? 0,
      heldBy.get(enrollment.id) ?? 0,
      usedBy.get(enrollment.id) ?? 0,
      enrollment.student.lastLoginAt?.toISOString() ?? '',
    ]),
  );
}

/**
 * Everything held about one student, for a subject-access request or a parent
 * asking what the school stores.
 *
 * Deliberately complete and deliberately boring: if it is in the database about
 * this student, it is in here. A partial export is worse than none, because it
 * implies completeness it does not have.
 */
export async function exportStudentData(studentId: string) {
  const student = await prisma.user.findUniqueOrThrow({
    where: { id: studentId },
    select: {
      id: true,
      displayName: true,
      loginId: true,
      createdAt: true,
      lastLoginAt: true,
      schoolId: true,
    },
  });

  const enrollments = await prisma.enrollment.findMany({
    where: { studentId },
    include: {
      room: { select: { name: true } },
      transactions: { orderBy: { createdAt: 'asc' } },
      inventory: { include: { card: { select: { name: true, rarity: true } } } },
      activity: { orderBy: { createdAt: 'asc' } },
      draws: { include: { card: { select: { name: true, rarity: true } } } },
    },
  });

  return {
    exported_at: new Date().toISOString(),
    student: {
      display_name: student.displayName,
      login_id: student.loginId,
      created_at: student.createdAt.toISOString(),
      last_login_at: student.lastLoginAt?.toISOString() ?? null,
      // No password material, no session tokens: only hashes exist, and they
      // are not the student's data in any useful sense.
    },
    rooms: enrollments.map((enrollment) => ({
      room: enrollment.room.name,
      status: enrollment.status,
      joined_at: enrollment.joinedAt.toISOString(),
      token_balance: enrollment.tokenBalance,
      token_history: enrollment.transactions.map((row) => ({
        at: row.createdAt.toISOString(),
        change: row.delta,
        balance_after: row.balanceAfter,
        reason: row.reason,
        note: row.note,
      })),
      cards: enrollment.inventory.map((item) => ({
        card: item.card.name,
        rarity: item.card.rarity,
        state: item.state,
        acquired_at: item.acquiredAt.toISOString(),
        used_at: item.usedAt?.toISOString() ?? null,
        note: item.studentNote,
      })),
      draws: enrollment.draws.map((draw) => ({
        at: draw.createdAt.toISOString(),
        card: draw.card.name,
        rarity: draw.card.rarity,
        token_cost: draw.tokenCost,
      })),
      activity: enrollment.activity.map((event) => ({
        at: event.createdAt.toISOString(),
        type: event.type,
        detail: event.payload,
      })),
    })),
  };
}
