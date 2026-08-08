import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { readSessionCookie, resolveSession } from '@/server/auth/session';
import { requireRoomEnrollment } from '@/server/auth/room-guard';
import { listInventory } from '@/server/services/draws';
import { ApiError } from '@/server/errors';
import InventoryActions from '@/components/inventory-actions';

export const dynamic = 'force-dynamic';

export default async function InventoryPage({
  params,
}: {
  params: Promise<{ roomId: string }>;
}) {
  const { roomId } = await params;
  const session = await resolveSession(await readSessionCookie());

  if (!session) redirect('/login');
  if (session.user.mustChangePassword) redirect('/change-password');
  if (session.user.role !== 'student') redirect(`/rooms/${roomId}`);

  const context = await requireRoomEnrollment(session.user, roomId).catch((error: unknown) => {
    if (error instanceof ApiError) notFound();
    throw error;
  });

  const stacks = await listInventory(context.enrollment.id);
  const totalCards = stacks.reduce((sum, stack) => sum + stack.count, 0);

  return (
    <main className="shell wide">
      <div className="page-head">
        <div>
          <h1>Your cards</h1>
          <p className="lede">
            {totalCards === 0
              ? 'You have not collected any cards yet.'
              : `${totalCards} card${totalCards === 1 ? '' : 's'} in ${context.room.name}.`}
          </p>
        </div>
        <nav className="page-nav">
          <Link href={`/rooms/${roomId}/draw`}>Open a lootbox</Link>
          <Link href={`/rooms/${roomId}/history`}>← Back</Link>
        </nav>
      </div>

      <div className="panel">
        {stacks.length === 0 ? (
          <p className="hint" style={{ margin: 0 }}>
            Spend {context.room.drawCostTokens} tokens on a lootbox to start collecting. You have{' '}
            {context.enrollment.tokenBalance}.
          </p>
        ) : (
          <InventoryActions
            roomId={roomId}
            stacks={stacks}
            tradesEnabled={context.room.tradesEnabled}
            tradeRatio={context.room.tradeRatio}
          />
        )}
      </div>

      <p className="hint" style={{ marginTop: '1rem' }}>
        When you use a card it goes straight back into the deck, so everyone else&apos;s chances go
        up. Your teacher is told which card you used.
      </p>
    </main>
  );
}
