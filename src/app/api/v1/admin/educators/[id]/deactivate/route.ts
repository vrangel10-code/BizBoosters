import { requireAdmin } from '@/server/auth/guard';
import { prisma } from '@/server/db';
import { apiError } from '@/server/errors';
import { revokeAllSessionsForUser } from '@/server/auth/session';
import { recordAudit } from '@/server/services/audit';
import { clientIp, handle, json } from '@/server/http';

export const dynamic = 'force-dynamic';

/**
 * Deactivation blocks login and kills live sessions but keeps the account, its
 * rooms and its history. Educator records are referenced by activity events, so
 * deleting one would tear holes in the audit trail.
 */
export const POST = handle(
  async (request: Request, context: { params: Promise<{ id: string }> }) => {
    const { user } = await requireAdmin();
    const { id } = await context.params;

    if (id === user.id) {
      throw apiError('validation_failed', 'You cannot deactivate your own account.');
    }

    const target = await prisma.user.findUnique({ where: { id } });
    if (!target || target.schoolId !== user.schoolId || target.role === 'student') {
      throw apiError('not_found', 'Not found.');
    }

    await prisma.user.update({ where: { id }, data: { isActive: false } });
    const revoked = await revokeAllSessionsForUser(id);

    await recordAudit({
      action: 'admin.educator_deactivated',
      actorUserId: user.id,
      targetUserId: id,
      payload: { revoked_sessions: revoked },
      ip: clientIp(request),
    });

    return json({ ok: true });
  },
);
