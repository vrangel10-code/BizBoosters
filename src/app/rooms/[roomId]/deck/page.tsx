import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { readSessionCookie, resolveSession } from '@/server/auth/session';
import { requireRoomEducator } from '@/server/auth/room-guard';
import { getDeck, getDeckOdds } from '@/server/services/decks';
import { listCards } from '@/server/services/cards';
import { ApiError } from '@/server/errors';
import DeckBuilder from '@/components/deck-builder';
import OddsPanel from '@/components/odds-panel';

export const dynamic = 'force-dynamic';

export default async function DeckPage({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;
  const session = await resolveSession(await readSessionCookie());

  if (!session) redirect('/login');
  if (session.user.mustChangePassword) redirect('/change-password');
  if (session.user.role === 'student') redirect(`/rooms/${roomId}/cards`);

  const context = await requireRoomEducator(session.user, roomId, { allowArchived: true }).catch(
    (error: unknown) => {
      if (error instanceof ApiError && error.code === 'not_found') notFound();
      throw error;
    },
  );

  const [deck, odds, catalog] = await Promise.all([
    getDeck(roomId),
    getDeckOdds(context.room),
    listCards(context.room.schoolId),
  ]);

  return (
    <main className="shell wide">
      <div className="page-head">
        <div>
          <h1>{context.room.name} — deck</h1>
          <p className="lede">
            Set how many copies of each card exist. The number in the deck follows automatically.
          </p>
        </div>
        <Link href={`/rooms/${roomId}`}>← Room</Link>
      </div>

      <OddsPanel odds={odds} audience="educator" />

      <div style={{ marginTop: '1.5rem' }}>
        <DeckBuilder
          roomId={roomId}
          roomName={context.room.name}
          catalog={catalog}
          deck={deck}
        />
      </div>
    </main>
  );
}
