import { requireAuth } from '@/server/auth/guard';
import { listNotifications } from '@/server/services/notifications';
import { handle, json } from '@/server/http';

export const dynamic = 'force-dynamic';

/** Also the polling fallback when the SSE stream is unavailable. */
export const GET = handle(async (request: Request) => {
  const { user } = await requireAuth();
  const url = new URL(request.url);

  const result = await listNotifications(user.id, {
    unreadOnly: url.searchParams.get('unread') === 'true',
    limit: Number(url.searchParams.get('limit') ?? 50),
  });

  return json({ data: result.data, unread: result.unread });
});
