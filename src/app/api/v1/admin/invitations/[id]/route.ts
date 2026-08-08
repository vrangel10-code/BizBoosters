import { requireAdmin } from '@/server/auth/guard';
import { revokeInvitation } from '@/server/services/invitations';
import { clientIp, handle, json } from '@/server/http';

export const dynamic = 'force-dynamic';

export const DELETE = handle(
  async (request: Request, context: { params: Promise<{ id: string }> }) => {
    const { user } = await requireAdmin();
    const { id } = await context.params;

    await revokeInvitation(user, id, clientIp(request));
    return json({ ok: true });
  },
);
