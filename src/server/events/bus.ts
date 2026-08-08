import { EventEmitter } from 'node:events';

/**
 * In-process pub/sub behind the SSE stream.
 *
 * Deliberately simple, and deliberately not the source of truth. Notifications
 * are database rows; this only makes them *arrive quickly*. Two consequences
 * follow, and both are by design:
 *
 *  - On more than one instance, a push only reaches clients connected to the
 *    instance that emitted it. The client's polling fallback covers the rest
 *    within one interval, so the worst case is a slower badge, never a lost
 *    notification.
 *  - Replacing this with Postgres LISTEN/NOTIFY is a swap behind `publish` and
 *    `subscribe` with no caller changes. Worth doing when a second instance
 *    appears, not before.
 */
export type ServerEvent =
  | { kind: 'notification'; userId: string; data: Record<string, unknown> }
  | { kind: 'room.pool_changed'; roomId: string; data: Record<string, unknown> }
  | { kind: 'tokens.changed'; userId: string; roomId: string; data: Record<string, unknown> };

const emitter = new EventEmitter();
// A classroom's worth of open streams plus the app's own listeners.
emitter.setMaxListeners(200);

const CHANNEL = 'server-event';

export function publish(event: ServerEvent): void {
  emitter.emit(CHANNEL, event);
}

export function subscribe(listener: (event: ServerEvent) => void): () => void {
  emitter.on(CHANNEL, listener);
  return () => emitter.off(CHANNEL, listener);
}

/**
 * Publishes only after the surrounding transaction has committed. Emitting
 * inside a transaction would announce a draw that might still roll back — a
 * ghost card in everyone's UI.
 */
export function publishAfterCommit(events: ServerEvent[]): void {
  queueMicrotask(() => {
    for (const event of events) publish(event);
  });
}
