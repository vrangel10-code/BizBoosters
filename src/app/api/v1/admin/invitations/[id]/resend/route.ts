import { requireAdmin } from '@/server/auth/guard';
import { resendInvitation } from '@/server/services/invitations';
import { clientIp, handle, json } from '@/server/http';

export const dynamic = 'force-dynamic';

export const POST = handle(
  async (request: Request, context: { params: Promise<{ id: string }> }) => {
    const { user } = await requireAdmin();
    const { id } = await context.params;

    await resendInvitation(user, id, clientIp(request));
    return json({ ok: true });
  },
);
