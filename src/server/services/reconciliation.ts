import { prisma } from '../db';

/**
 * The nightly integrity checks.
 *
 * Both of these assert an invariant the services are supposed to maintain
 * inside their transactions. A row returned here is not something to repair
 * automatically — it means a transaction boundary is wrong, and silently
 * patching the number would hide the bug that produced it. Alert, investigate,
 * fix the code.
 */

export interface CopyDrift {
  roomId: string;
  roomName: string;
  cardId: string;
  cardName: string;
  copiesTotal: number;
  inDeck: number;
  heldByStudents: number;
}

/**
 * Card copies are conserved: every copy is either in the deck or in exactly one
 * student's hand. No third bucket, because a used copy returns to the deck
 * immediately.
 *
 *     copies_total = copies_remaining + count(inventory_items WHERE state='owned')
 *
 * This is the single most important check in the system. Drift means the deck
 * is inflating or leaking, and by the end of term it is unrecoverable.
 */
export async function findCopyDrift(): Promise<CopyDrift[]> {
  const rows = await prisma.$queryRaw<
    {
      room_id: string;
      room_name: string;
      card_id: string;
      card_name: string;
      copies_total: number;
      in_deck: number;
      held: number;
    }[]
  >`
    SELECT rc.room_id,
           r.name  AS room_name,
           rc.card_id,
           c.name  AS card_name,
           rc.copies_total,
           rc.copies_remaining AS in_deck,
           COALESCE(held.n, 0)::int AS held
      FROM room_cards rc
      JOIN rooms r ON r.id = rc.room_id
      JOIN cards c ON c.id = rc.card_id
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS n
          FROM inventory_items i
         WHERE i.room_id = rc.room_id
           AND i.card_id = rc.card_id
           AND i.state = 'owned'
      ) held ON true
     WHERE rc.copies_remaining + COALESCE(held.n, 0) <> rc.copies_total
  `;

  return rows.map((row) => ({
    roomId: row.room_id,
    roomName: row.room_name,
    cardId: row.card_id,
    cardName: row.card_name,
    copiesTotal: row.copies_total,
    inDeck: row.in_deck,
    heldByStudents: row.held,
  }));
}

export interface BalanceDrift {
  enrollmentId: string;
  roomName: string;
  studentName: string;
  cached: number;
  ledger: number;
}

/** `enrollments.token_balance` must equal `SUM(token_transactions.delta)`. */
export async function findBalanceDrift(): Promise<BalanceDrift[]> {
  const rows = await prisma.$queryRaw<
    {
      enrollment_id: string;
      room_name: string;
      student_name: string;
      cached: number;
      ledger: number;
    }[]
  >`
    SELECT e.id AS enrollment_id,
           r.name AS room_name,
           u.display_name AS student_name,
           e.token_balance AS cached,
           COALESCE(SUM(t.delta), 0)::int AS ledger
      FROM enrollments e
      JOIN rooms r ON r.id = e.room_id
      JOIN users u ON u.id = e.student_id
      LEFT JOIN token_transactions t ON t.enrollment_id = e.id
     GROUP BY e.id, r.name, u.display_name, e.token_balance
    HAVING e.token_balance <> COALESCE(SUM(t.delta), 0)
  `;

  return rows.map((row) => ({
    enrollmentId: row.enrollment_id,
    roomName: row.room_name,
    studentName: row.student_name,
    cached: row.cached,
    ledger: row.ledger,
  }));
}

export interface ReconciliationReport {
  checkedAt: string;
  copyDrift: CopyDrift[];
  balanceDrift: BalanceDrift[];
  healthy: boolean;
}

export async function runReconciliation(): Promise<ReconciliationReport> {
  const [copyDrift, balanceDrift] = await Promise.all([findCopyDrift(), findBalanceDrift()]);

  const report: ReconciliationReport = {
    checkedAt: new Date().toISOString(),
    copyDrift,
    balanceDrift,
    healthy: copyDrift.length === 0 && balanceDrift.length === 0,
  };

  if (!report.healthy) {
    // Loud on purpose. This is the canary for a transaction-boundary bug, and
    // it wants finding the same night rather than at the end of term.
    console.error('[reconciliation] INTEGRITY DRIFT DETECTED', JSON.stringify(report, null, 2));
  }

  return report;
}
