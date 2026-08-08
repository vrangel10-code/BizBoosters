import { z } from 'zod';
import { requireAuth } from '@/server/auth/guard';
import { markRead, unreadCount } from '@/server/services/notifications';
import { handle, json, parseBody } from '@/server/http';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  ids: z.array(z.string().uuid()).max(500).optional(),
  all: z.boolean().optional(),
});

export const POST = handle(async (request: Request) => {
  const { user } = await requireAuth();
  const body = await parseBody(request, bodySchema);

  const marked = await markRead(user.id, { ids: body.ids, all: body.all });
  return json({ marked, unread: await unreadCount(user.id) });
});
