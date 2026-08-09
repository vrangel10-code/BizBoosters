import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { readSessionCookie, resolveSession } from '@/server/auth/session';
import { requireRoomEducator } from '@/server/auth/room-guard';
import { listRoster } from '@/server/services/roster';
import { listActivity } from '@/server/services/activity';
import { ApiError } from '@/server/errors';
import RoomManager from '@/components/room-manager';
import RoomSettings from '@/components/room-settings';
import ActivityFeed from '@/components/activity-feed';
import NotificationBell from '@/components/notification-bell';
import RecentUses from '@/components/recent-uses';
import { listRecentUses, heldByStudent } from '@/server/services/card-actions';
import { getDeckOdds } from '@/server/services/decks';
import { unreadCount } from '@/server/services/notifications';

export const dynamic = 'force-dynamic';

export default async function RoomPage({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;
  const session = await resolveSession(await readSessionCookie());

  if (!session) redirect('/login');
  if (session.user.mustChangePassword) redirect('/change-password');
  // Students have their own view of a room; never fall through to this one.
  if (session.user.role === 'student') redirect(`/rooms/${roomId}/history`);

  const context = await requireRoomEducator(session.user, roomId, { allowArchived: true }).catch(
    (error: unknown) => {
      if (error instanceof ApiError && error.code === 'not_found') notFound();
      throw error;
    },
  );

  const [roster, activity, uses, odds, held, unread] = await Promise.all([
    listRoster(roomId),
    listActivity({ roomId, limit: 40 }),
    listRecentUses(roomId, { limit: 25 }),
    getDeckOdds(context.room),
    heldByStudent(roomId),
    unreadCount(session.user.id),
  ]);

  return (
    <main className="shell wide">
      <div className="page-head">
        <div>
          <h1>{context.room.name}</h1>
          <p className="lede">
            {roster.length} student{roster.length === 1 ? '' : 's'} · {context.room.drawCostTokens}{' '}
            tokens per draw
          </p>
        </div>
        <nav className="page-nav">
          <NotificationBell initialUnread={unread} />
          <Link href={`/rooms/${roomId}/activity`}>Activity log</Link>
          <Link href={`/rooms/${roomId}/deck`}>Deck</Link>
          <Link href="/cards">Card catalog</Link>
          <Link href="/dashboard">← All rooms</Link>
        </nav>
      </div>

      <p className="hint" style={{ marginTop: '-0.5rem' }}>
        <a href={`/api/v1/rooms/${roomId}/roster/export`} download>
          Download student summary (CSV)
        </a>
      </p>

      <div className="panel deck-summary">
        <div>
          <strong>{odds.in_deck}</strong> in the deck
        </div>
        <div>
          <strong>{odds.held}</strong> held by students
        </div>
        <div>
          <strong>{odds.total}</strong> copies in total
        </div>
      </div>

      {odds.is_empty && odds.total > 0 ? (
        <p className="alert error" role="alert">
          The deck is empty — every copy is in a student&apos;s hand. It refills as cards get used.
          {held.length > 0
            ? ` Holding most: ${held
                .slice(0, 3)
                .map((row) => `${row.student_name} (${row.held})`)
                .join(', ')}.`
            : ''}
        </p>
      ) : null}

      <RecentUses roomId={roomId} uses={uses} />

      <div style={{ marginTop: '1.5rem' }}>
        <RoomManager roomId={roomId} roster={roster} />

        <RoomSettings
          room={{
            id: context.room.id,
            name: context.room.name,
            status: context.room.status,
            draw_cost_tokens: context.room.drawCostTokens,
            trades_enabled: context.room.tradesEnabled,
            trade_ratio: context.room.tradeRatio,
            students_see_odds: context.room.studentsSeeOdds,
            low_stock_threshold: context.room.lowStockThreshold,
            version: context.room.version,
          }}
        />
      </div>

      <div style={{ marginTop: '1.5rem' }}>
        <ActivityFeed
          rows={activity.rows.map((row) => ({
            id: row.id,
            type: row.type,
            createdAt: row.createdAt.toISOString(),
            actorName: row.actorName,
            subjectName: row.subjectName,
            payload: row.payload as Record<string, unknown>,
          }))}
        />
      </div>
    </main>
  );
}
