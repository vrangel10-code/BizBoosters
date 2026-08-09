import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import LootboxLink from '@/components/lootbox-link';
import { readSessionCookie, resolveSession } from '@/server/auth/session';
import { requireRoomEnrollment } from '@/server/auth/room-guard';
import { listActivity } from '@/server/services/activity';
import { listTokenTransactions } from '@/server/services/tokens';
import { ApiError } from '@/server/errors';

export const dynamic = 'force-dynamic';

export default async function StudentRoomPage({
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

  // Filtered to this student's own enrolment on the server. There is no query
  // parameter through which another student's history could be requested.
  const [activity, ledger] = await Promise.all([
    listActivity({
      roomId,
      subjectEnrollmentId: context.enrollment.id,
      includeRoomWide: true,
      limit: 50,
    }),
    listTokenTransactions(context.enrollment.id, 50),
  ]);

  const affordable = Math.floor(context.enrollment.tokenBalance / context.room.drawCostTokens);

  return (
    <main className="shell wide">
      <div className="page-head">
        <div>
          <h1>{context.room.name}</h1>
          <p className="lede">Your tokens and history in this room.</p>
        </div>
        <nav className="page-nav">
          <Link href={`/rooms/${roomId}/inventory`}>Inventory</Link>
          <Link href={`/rooms/${roomId}/cards`}>Deck List</Link>
          <Link href="/home">← All rooms</Link>
        </nav>
      </div>

      <div className="panel balance-panel">
        <p className="balance">{context.enrollment.tokenBalance}</p>
        <p className="hint" style={{ margin: 0 }}>
          tokens ·{' '}
          {affordable > 0
            ? `enough for ${affordable} card draw${affordable === 1 ? '' : 's'}`
            : `${context.room.drawCostTokens - context.enrollment.tokenBalance} more tokens for your first draw`}
        </p>
        <LootboxLink
          href={`/rooms/${roomId}/draw`}
          affordable={affordable}
          shortfall={context.room.drawCostTokens - context.enrollment.tokenBalance}
        />
      </div>

      <div className="panel" style={{ marginTop: '1.5rem' }}>
        <h2 className="panel-title">Your tokens</h2>
        {ledger.length === 0 ? (
          <p className="hint" style={{ margin: 0 }}>
            You have not earned any tokens yet.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Change</th>
                <th>Reason</th>
                <th>Balance</th>
              </tr>
            </thead>
            <tbody>
              {ledger.map((entry) => (
                <tr key={entry.id}>
                  <td>{entry.createdAt.toLocaleDateString(undefined, { dateStyle: 'medium' })}</td>
                  <td className={entry.delta > 0 ? 'up' : 'down'}>
                    {entry.delta > 0 ? '+' : ''}
                    {entry.delta}
                  </td>
                  <td>
                    {entry.note ?? (entry.reason === 'educator_award' ? 'Awarded' : 'Adjusted')}
                    {entry.reversedBy ? <span className="tag">undone</span> : null}
                  </td>
                  <td>{entry.balanceAfter}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel" style={{ marginTop: '1.5rem' }}>
        <h2 className="panel-title">Room updates</h2>
        <ul className="feed">
          {activity.rows.map((row) => (
            <li key={row.id}>
              <span className="feed-when">
                {row.createdAt.toLocaleDateString(undefined, { dateStyle: 'medium' })}
              </span>
              <span>{row.type.replace(/[._]/g, ' ')}</span>
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}
