import { acceptInvitationSchema } from '@/lib/validation';
import { acceptInvitation } from '@/server/services/invitations';
import { setSessionCookie } from '@/server/auth/session';
import { clientIp, created, handle, parseBody } from '@/server/http';

export const dynamic = 'force-dynamic';

export const POST = handle(
  async (request: Request, context: { params: Promise<{ token: string }> }) => {
    const { token } = await context.params;
    const body = await parseBody(request, acceptInvitationSchema);

    const { user, sessionToken, expiresAt } = await acceptInvitation({
      token,
      displayName: body.display_name,
      password: body.password,
      ip: clientIp(request),
      userAgent: request.headers.get('user-agent'),
    });

    await setSessionCookie(sessionToken, expiresAt);

    return created({
      user: {
        id: user.id,
        role: user.role,
        display_name: user.displayName,
        email: user.email,
      },
    });
  },
);
