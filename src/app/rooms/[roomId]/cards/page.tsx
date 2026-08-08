import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { readSessionCookie, resolveSession } from '@/server/auth/session';
import { requireRoomEnrollment } from '@/server/auth/room-guard';
import { getDeck, getDeckOdds } from '@/server/services/decks';
import { ApiError } from '@/server/errors';
import LiveOddsPanel from '@/components/live-odds-panel';
import DeckGrid from '@/components/deck-grid';

export const dynamic = 'force-dynamic';

/** The student's view of the shared deck: the same odds their teacher sees. */
export default async function StudentDeckPage({
  params,
}: {
  params: Promise<{ roomId: string }>;
}) {
  const { roomId } = await params;
  const session = await resolveSession(await readSessionCookie());

  if (!session) redirect('/login');
  if (session.user.mustChangePassword) redirect('/change-password');
  if (session.user.role !== 'student') redirect(`/rooms/${roomId}/deck`);

  const context = await requireRoomEnrollment(session.user, roomId).catch((error: unknown) => {
    if (error instanceof ApiError) notFound();
    throw error;
  });

  const odds = await getDeckOdds(context.room);
  const deck = context.room.studentsSeeOdds ? await getDeck(roomId) : [];

  return (
    <main className="shell wide">
      <div className="page-head">
        <div>
          <h1>{context.room.name} — cards</h1>
          <p className="lede">
            Everyone in this room draws from the same deck, so these chances are shared.
          </p>
        </div>
        <Link href={`/rooms/${roomId}/history`}>← Your tokens</Link>
      </div>

      <LiveOddsPanel roomId={roomId} initialOdds={odds} audience="student" />

      {context.room.studentsSeeOdds ? (
        <div style={{ marginTop: '1.5rem' }}>
          <DeckGrid deck={deck} />
        </div>
      ) : null}
    </main>
  );
}
