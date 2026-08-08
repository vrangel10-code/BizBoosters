import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { readSessionCookie, resolveSession } from '@/server/auth/session';
import { requireRoomEnrollment } from '@/server/auth/room-guard';
import { getDeckOdds } from '@/server/services/decks';
import { ApiError } from '@/server/errors';
import DrawMachine from '@/components/draw-machine';

export const dynamic = 'force-dynamic';

export default async function DrawPage({ params }: { params: Promise<{ roomId: string }> }) {
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

  return (
    <main className="shell">
      <div className="page-head">
        <div>
          <h1>Open a lootbox</h1>
          <p className="lede">{context.room.name}</p>
        </div>
        <nav className="page-nav">
          <Link href={`/rooms/${roomId}/inventory`}>Your cards</Link>
          <Link href={`/rooms/${roomId}/history`}>← Back</Link>
        </nav>
      </div>

      <DrawMachine
        roomId={roomId}
        drawCost={context.room.drawCostTokens}
        initialBalance={context.enrollment.tokenBalance}
        initialOdds={odds}
      />
    </main>
  );
}
