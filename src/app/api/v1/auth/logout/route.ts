import { requireAuth } from '@/server/auth/guard';
import { clearSessionCookie, revokeSession } from '@/server/auth/session';
import { recordAudit } from '@/server/services/audit';
import { clientIp, handle, json } from '@/server/http';

export const dynamic = 'force-dynamic';

export const POST = handle(async (request: Request) => {
  // Reachable mid password-change: signing out must always work.
  const { sessionId, user } = await requireAuth({ allowPasswordChangePending: true });

  await revokeSession(sessionId);
  await clearSessionCookie();
  await recordAudit({
    action: 'auth.logged_out',
    actorUserId: user.id,
    targetUserId: user.id,
    ip: clientIp(request),
  });

  return json({ ok: true });
});
