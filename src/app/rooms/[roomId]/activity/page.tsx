import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { readSessionCookie, resolveSession } from '@/server/auth/session';
import { requireRoomEducator } from '@/server/auth/room-guard';
import { listActivity } from '@/server/services/activity';
import { listRoster } from '@/server/services/roster';
import { ApiError } from '@/server/errors';
import ActivityLog from '@/components/activity-log';

export const dynamic = 'force-dynamic';

interface SearchParams {
  enrollment_id?: string;
  type?: string;
  from?: string;
  to?: string;
}

export default async function ActivityPage({
  params,
  searchParams,
}: {
  params: Promise<{ roomId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { roomId } = await params;
  const filters = await searchParams;
  const session = await resolveSession(await readSessionCookie());

  if (!session) redirect('/login');
  if (session.user.mustChangePassword) redirect('/change-password');
  if (session.user.role === 'student') redirect(`/rooms/${roomId}/history`);

  const context = await requireRoomEducator(session.user, roomId, { allowArchived: true }).catch(
    (error: unknown) => {
      if (error instanceof ApiError && error.code === 'not_found') notFound();
      throw error;
    },
  );

  const [{ rows }, roster] = await Promise.all([
    listActivity({
      roomId,
      ...(filters.enrollment_id ? { subjectEnrollmentId: filters.enrollment_id } : {}),
      ...(filters.type ? { type: filters.type } : {}),
      ...(filters.from ? { from: new Date(filters.from) } : {}),
      ...(filters.to ? { to: new Date(`${filters.to}T23:59:59.999Z`) } : {}),
      limit: 200,
    }),
    listRoster(roomId),
  ]);

  return (
    <main className="shell wide">
      <div className="page-head">
        <div>
          <h1>{context.room.name} — activity</h1>
          <p className="lede">Everything that has happened in this room.</p>
        </div>
        <nav className="page-nav">
          <Link href={`/rooms/${roomId}`}>← Room</Link>
        </nav>
      </div>

      <ActivityLog
        roomId={roomId}
        rows={rows.map((row) => ({
          id: row.id,
          type: row.type,
          createdAt: row.createdAt.toISOString(),
          actorName: row.actorName,
          subjectName: row.subjectName,
          payload: row.payload as Record<string, unknown>,
        }))}
        roster={roster.map((row) => ({
          enrollment_id: row.enrollment_id,
          display_name: row.display_name,
        }))}
        filters={filters}
      />
    </main>
  );
}
