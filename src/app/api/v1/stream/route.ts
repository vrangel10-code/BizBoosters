import { requireAuth } from '@/server/auth/guard';
import { subscribe, type ServerEvent } from '@/server/events/bus';
import { prisma } from '@/server/db';

export const dynamic = 'force-dynamic';

/**
 * Server-sent events, scoped to the session.
 *
 * Server→client only, so SSE rather than WebSockets: one endpoint, no upgrade
 * handshake, and it survives proxies that mangle everything else.
 *
 * This is an optimisation, not a guarantee. Notifications are database rows;
 * this only makes them arrive quickly. Clients still poll as a fallback, so a
 * dropped stream or a second app instance costs latency, never data.
 */
export async function GET(): Promise<Response> {
  /**
   * The off switch, for hosts that bill function time.
   *
   * A serverless platform kills this function at its execution limit, so a
   * stream it can never sustain still costs a full function lifetime per
   * attempt. With LIVE_UPDATES=off the route declines immediately and clients
   * poll instead — cheap, and the only thing lost is instant updates.
   *
   * 204 rather than 404 on purpose: this is "not offered here", not "no such
   * endpoint", and EventSource treats any non-stream response as an error and
   * falls back exactly as intended.
   */
  if (process.env.LIVE_UPDATES === 'off') {
    return new Response(null, { status: 204 });
  }

  const { user } = await requireAuth({ allowPasswordChangePending: true });

  const rooms = await prisma.enrollment.findMany({
    where:
      user.role === 'student'
        ? { studentId: user.id, status: 'active' }
        : { room: { educators: { some: { userId: user.id } } } },
    select: { roomId: true },
    distinct: ['roomId'],
  });
  const roomIds = new Set(rooms.map((row) => row.roomId));

  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: (() => void) | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown, id?: string) => {
        try {
          const payload =
            (id ? `id: ${id}\n` : '') + `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
          controller.enqueue(encoder.encode(payload));
        } catch {
          // Client vanished mid-write; the cancel handler cleans up.
        }
      };

      send('ready', { at: new Date().toISOString() });

      unsubscribe = subscribe((event: ServerEvent) => {
        if (event.kind === 'notification' && event.userId === user.id) {
          send('notification', event.data);
        } else if (event.kind === 'room.pool_changed' && roomIds.has(event.roomId)) {
          send('room.pool_changed', { room_id: event.roomId, ...event.data });
        } else if (event.kind === 'tokens.changed' && event.userId === user.id) {
          send('tokens.changed', { room_id: event.roomId, ...event.data });
        }
      });

      // Proxies close idle connections; 25s keeps well inside the usual 30-60s.
      heartbeat = setInterval(() => send('heartbeat', { t: Date.now() }), 25_000);
    },
    cancel() {
      unsubscribe?.();
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Nginx buffers text/event-stream by default, which delays every push.
      'x-accel-buffering': 'no',
    },
  });
}
