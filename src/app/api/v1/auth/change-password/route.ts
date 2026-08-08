import { changePasswordSchema } from '@/lib/validation';
import { requireAuth } from '@/server/auth/guard';
import { changePassword } from '@/server/services/auth-service';
import { clientIp, handle, json, parseBody } from '@/server/http';

export const dynamic = 'force-dynamic';

/**
 * The only mutating route reachable while `must_change_password` is set — see
 * requireAuth(). Everything else 403s until this succeeds.
 */
export const POST = handle(async (request: Request) => {
  const { user, sessionId } = await requireAuth({ allowPasswordChangePending: true });
  const body = await parseBody(request, changePasswordSchema);

  await changePassword({
    user,
    currentPassword: body.current_password,
    newPassword: body.new_password,
    currentSessionId: sessionId,
    ip: clientIp(request),
  });

  return json({ ok: true });
});
