import type { Prisma } from '@prisma/client';
import { prisma } from '../db';

/**
 * Account-level actions taken on a user: invitations, password resets,
 * deactivations. Distinct from the room activity log (phase 1), which is game
 * history students can see — this is account history they cannot.
 *
 * Auditing protects the educator as much as the student: it is the record of
 * who reset whose password and when.
 */
export type AuditAction =
  | 'admin.invitation_created'
  | 'admin.invitation_revoked'
  | 'admin.invitation_resent'
  | 'admin.invitation_accepted'
  | 'admin.educator_deactivated'
  | 'admin.educator_reactivated'
  | 'auth.login_succeeded'
  | 'auth.login_failed'
  | 'auth.account_locked'
  | 'auth.password_changed'
  | 'auth.logged_out'
  | 'student.created'
  | 'student.password_reset'
  | 'student.deleted'
  | 'student.sessions_revoked'
  | 'room.deleted'
  | 'room.cloned'
  | 'data.exported';

export interface AuditEntry {
  action: AuditAction;
  actorUserId?: string | null;
  targetUserId?: string | null;
  payload?: Prisma.InputJsonValue;
  ip?: string | null;
}

export async function recordAudit(
  entry: AuditEntry,
  tx: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<void> {
  await tx.auditLog.create({
    data: {
      action: entry.action,
      actorUserId: entry.actorUserId ?? null,
      targetUserId: entry.targetUserId ?? null,
      payload: entry.payload ?? {},
      ip: entry.ip ?? null,
    },
  });
}
