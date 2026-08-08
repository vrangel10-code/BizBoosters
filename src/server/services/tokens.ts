import { randomUUID } from 'node:crypto';
import type { Prisma, TokenReason, User } from '@prisma/client';
import { prisma } from '../db';
import { apiError } from '../errors';
import { recordActivity, recordActivityMany } from './activity';

/** How long an award stays one-click reversible. */
const UNDO_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface AwardResult {
  batchId: string;
  awarded: { enrollmentId: string; studentName: string; balance: number }[];
}

interface LedgerWrite {
  enrollmentId: string;
  delta: number;
  reason: TokenReason;
  note?: string | null;
  actorUserId?: string | null;
  batchId?: string | null;
  reversesId?: string | null;
}

/**
 * Applies one ledger movement inside an existing transaction: locks the
 * enrolment row, moves the cached balance, and appends the immutable row.
 *
 * The lock is what makes concurrent movements safe — two educators awarding the
 * same student at once must not both read balance 20 and both write 60. It is
 * also the shape phase 3's draw will reuse.
 */
async function applyLedgerWrite(
  tx: Prisma.TransactionClient,
  write: LedgerWrite,
): Promise<{ balanceAfter: number; transactionId: string }> {
  const [locked] = await tx.$queryRaw<{ token_balance: number; status: string }[]>`
    SELECT token_balance, status FROM enrollments WHERE id = ${write.enrollmentId}::uuid FOR UPDATE
  `;

  if (!locked) throw apiError('not_found', 'Not found.');
  if (locked.status !== 'active') {
    throw apiError('not_found', 'That student is no longer in this room.');
  }

  const balanceAfter = locked.token_balance + write.delta;

  if (balanceAfter < 0) {
    // Clamping to zero would destroy the audit trail: the ledger would no
    // longer sum to the balance. Refuse and tell the educator what happened.
    throw apiError(
      'insufficient_tokens',
      'That would take the student below zero. They have already spent some of these tokens.',
      { balance: locked.token_balance, requested_delta: write.delta },
    );
  }

  await tx.enrollment.update({
    where: { id: write.enrollmentId },
    data: { tokenBalance: balanceAfter },
  });

  const row = await tx.tokenTransaction.create({
    data: {
      enrollmentId: write.enrollmentId,
      delta: write.delta,
      balanceAfter,
      reason: write.reason,
      note: write.note?.trim() || null,
      actorUserId: write.actorUserId ?? null,
      batchId: write.batchId ?? null,
      reversesId: write.reversesId ?? null,
    },
  });

  return { balanceAfter, transactionId: row.id };
}

export interface AwardTokensInput {
  actor: User;
  roomId: string;
  enrollmentIds: string[];
  amount: number;
  note?: string | null;
}

/**
 * A bulk award writes one ledger row AND one activity event per student — never
 * one shared row of either. Each student's history has to stand alone, and the
 * student history view filters by enrolment, so a single room-level event would
 * be invisible to the people it is about.
 *
 * They share a `batchId` so the educator's room log can collapse 30 rows into
 * one line. Grouping is presentation; the records stay separate.
 */
export async function awardTokens({
  actor,
  roomId,
  enrollmentIds,
  amount,
  note,
}: AwardTokensInput): Promise<AwardResult> {
  if (amount <= 0) {
    throw apiError('validation_failed', 'An award must be a positive number of tokens.');
  }
  if (enrollmentIds.length === 0) {
    throw apiError('validation_failed', 'Select at least one student.');
  }

  const enrollments = await prisma.enrollment.findMany({
    where: { id: { in: enrollmentIds }, roomId, status: 'active' },
    include: { student: { select: { displayName: true } } },
  });

  if (enrollments.length !== enrollmentIds.length) {
    throw apiError('not_found', 'One or more of those students is not in this room.');
  }

  const batchId = randomUUID();

  return prisma.$transaction(async (tx) => {
    const awarded: AwardResult['awarded'] = [];

    // Deterministic order so two concurrent bulk awards over overlapping
    // students take the row locks in the same sequence and cannot deadlock.
    const ordered = [...enrollments].sort((a, b) => a.id.localeCompare(b.id));

    for (const enrollment of ordered) {
      const { balanceAfter } = await applyLedgerWrite(tx, {
        enrollmentId: enrollment.id,
        delta: amount,
        reason: 'educator_award',
        note,
        actorUserId: actor.id,
        batchId,
      });

      awarded.push({
        enrollmentId: enrollment.id,
        studentName: enrollment.student.displayName,
        balance: balanceAfter,
      });
    }

    await recordActivityMany(
      ordered.map((enrollment) => ({
        roomId,
        type: 'tokens.awarded' as const,
        actorUserId: actor.id,
        subjectEnrollmentId: enrollment.id,
        payload: {
          amount,
          note: note?.trim() || null,
          batch_id: batchId,
          batch_size: ordered.length,
        },
      })),
      tx,
    );

    return { batchId, awarded };
  });
}

export interface AdjustTokensInput {
  actor: User;
  roomId: string;
  enrollmentId: string;
  /** Exactly one of these. */
  delta?: number;
  targetBalance?: number;
  note: string;
}

/**
 * The educator-facing "edit tokens" action. It never writes the balance
 * directly: it computes a compensating movement and appends it, so the ledger
 * still sums to the balance and the reason survives.
 */
export async function adjustTokens({
  actor,
  roomId,
  enrollmentId,
  delta,
  targetBalance,
  note,
}: AdjustTokensInput): Promise<{ balance: number; delta: number }> {
  if ((delta === undefined) === (targetBalance === undefined)) {
    throw apiError('validation_failed', 'Provide either a delta or a target balance, not both.');
  }
  if (!note?.trim()) {
    // Mandatory: an adjustment without a reason is unanswerable three weeks
    // later, which is the whole point of having a ledger.
    throw apiError('validation_failed', 'A reason is required when adjusting tokens.');
  }

  const enrollment = await prisma.enrollment.findFirst({
    where: { id: enrollmentId, roomId, status: 'active' },
    include: { student: { select: { displayName: true } } },
  });
  if (!enrollment) throw apiError('not_found', 'Not found.');

  const effectiveDelta =
    delta !== undefined ? delta : (targetBalance ?? 0) - enrollment.tokenBalance;

  if (effectiveDelta === 0) {
    throw apiError('validation_failed', 'That would not change the balance.');
  }

  return prisma.$transaction(async (tx) => {
    const { balanceAfter } = await applyLedgerWrite(tx, {
      enrollmentId,
      delta: effectiveDelta,
      reason: 'educator_adjustment',
      note,
      actorUserId: actor.id,
    });

    await recordActivity(
      {
        roomId,
        type: 'tokens.adjusted',
        actorUserId: actor.id,
        subjectEnrollmentId: enrollmentId,
        payload: { delta: effectiveDelta, note: note.trim(), balance_after: balanceAfter },
      },
      tx,
    );

    return { balance: balanceAfter, delta: effectiveDelta };
  });
}

/**
 * One-click reversal of a specific award or adjustment. Writes the inverse row
 * linked to the original rather than deleting anything — the mistake and its
 * correction both stay visible.
 */
export async function undoTokenTransaction(
  actor: User,
  transactionId: string,
  roomId: string,
): Promise<{ balance: number }> {
  const original = await prisma.tokenTransaction.findUnique({
    where: { id: transactionId },
    include: { enrollment: { include: { student: { select: { displayName: true } } } }, reversedBy: true },
  });

  if (!original || original.enrollment.roomId !== roomId) {
    throw apiError('not_found', 'Not found.');
  }
  if (original.reason !== 'educator_award' && original.reason !== 'educator_adjustment') {
    throw apiError(
      'validation_failed',
      'Only educator awards and adjustments can be undone. Spending is reversed by the game.',
    );
  }
  if (original.reversedBy) {
    throw apiError('already_undone', 'That entry has already been undone.');
  }
  if (original.reversesId) {
    throw apiError('already_undone', 'That entry is itself an undo and cannot be undone.');
  }
  if (Date.now() - original.createdAt.getTime() > UNDO_WINDOW_MS) {
    throw apiError('undo_window_expired', 'That entry is too old to undo. Use an adjustment.', {
      undo_window_hours: UNDO_WINDOW_MS / 3_600_000,
    });
  }

  return prisma.$transaction(async (tx) => {
    const { balanceAfter } = await applyLedgerWrite(tx, {
      enrollmentId: original.enrollmentId,
      delta: -original.delta,
      reason: original.reason,
      note: `Undo: ${original.note ?? 'no reason given'}`,
      actorUserId: actor.id,
      reversesId: original.id,
    });

    await recordActivity(
      {
        roomId,
        type: 'tokens.undone',
        actorUserId: actor.id,
        subjectEnrollmentId: original.enrollmentId,
        payload: {
          reversed_transaction_id: original.id,
          delta: -original.delta,
          original_note: original.note,
        },
      },
      tx,
    );

    return { balance: balanceAfter };
  });
}

// Reconciliation lives in ./reconciliation.ts — one implementation, used by the
// nightly job and the tests alike.

export async function listTokenTransactions(enrollmentId: string, limit = 100) {
  return prisma.tokenTransaction.findMany({
    where: { enrollmentId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: {
      actor: { select: { displayName: true } },
      reversedBy: { select: { id: true } },
    },
  });
}
