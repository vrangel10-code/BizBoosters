import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { readSessionCookie, resolveSession } from '@/server/auth/session';
import { requireRoomEnrollment } from '@/server/auth/room-guard';
import { listInventory } from '@/server/services/draws';
import { ApiError } from '@/server/errors';

export const dynamic = 'force-dynamic';

const RARITY_LABEL: Record<string, string> = {
  C: 'Common',
  U: 'Uncommon',
  R: 'Rare',
  L: 'Legendary',
};

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
          <ul className="deck-grid">
            {stacks.map((stack) => (
              <li key={stack.card_id} className="deck-card">
                <div className={`bb-card card-${stack.rarity}`}>
                  {stack.image_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={stack.image_url} alt="" loading="lazy" />
                  ) : (
                    <span className="bb-card-initial" aria-hidden="true">
                      {stack.name.slice(0, 1)}
                    </span>
                  )}
                  {stack.count > 1 ? <span className="deck-badge">×{stack.count}</span> : null}
                </div>
                <p className="deck-card-name">{stack.name}</p>
                <p className="deck-card-meta">{RARITY_LABEL[stack.rarity]}</p>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="hint" style={{ marginTop: '1rem' }}>
        Using a card comes in the next update. When you use one it goes back into the deck for
        everyone.
      </p>
    </main>
  );
}
