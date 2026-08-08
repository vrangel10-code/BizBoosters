import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { readSessionCookie, resolveSession } from '@/server/auth/session';
import { requireRoomEducator } from '@/server/auth/room-guard';
import { listRoster } from '@/server/services/roster';
import { listActivity } from '@/server/services/activity';
import { ApiError } from '@/server/errors';
import RoomManager from '@/components/room-manager';
import ActivityFeed from '@/components/activity-feed';

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

  const [roster, activity] = await Promise.all([
    listRoster(roomId),
    listActivity({ roomId, limit: 40 }),
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
          <Link href={`/rooms/${roomId}/deck`}>Deck</Link>
          <Link href="/cards">Card catalog</Link>
          <Link href="/dashboard">← All rooms</Link>
        </nav>
      </div>

      <RoomManager roomId={roomId} roster={roster} />

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
