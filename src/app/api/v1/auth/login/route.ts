import { loginSchema } from '@/lib/validation';
import { login } from '@/server/services/auth-service';
import { setSessionCookie } from '@/server/auth/session';
import { clientIp, handle, json, parseBody } from '@/server/http';

export const dynamic = 'force-dynamic';

export const POST = handle(async (request: Request) => {
  const body = await parseBody(request, loginSchema);

  const { user, token, expiresAt } = await login({
    identifier: body.identifier,
    password: body.password,
    ip: clientIp(request),
    userAgent: request.headers.get('user-agent'),
  });

  await setSessionCookie(token, expiresAt);

  return json({
    user: {
      id: user.id,
      role: user.role,
      display_name: user.displayName,
      email: user.email,
      login_id: user.loginId,
    },
    must_change_password: user.mustChangePassword,
  });
});
