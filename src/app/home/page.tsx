import { redirect } from 'next/navigation';
import Link from 'next/link';
import { readSessionCookie, resolveSession } from '@/server/auth/session';
import { listRoomsForStudent } from '@/server/services/rooms';
import SignOutButton from '@/components/sign-out-button';
import Brand from '@/components/brand';

export const dynamic = 'force-dynamic';

export default async function StudentHomePage() {
  const session = await resolveSession(await readSessionCookie());

  if (!session) redirect('/login');
  if (session.user.mustChangePassword) redirect('/change-password');
  if (session.user.role !== 'student') redirect('/dashboard');

  const rooms = await listRoomsForStudent(session.user);

  return (
    <main className="shell wide">
      <div className="page-head">
        <div>
          <Brand />
          <h1>Hi, {session.user.displayName}</h1>
          <p className="lede">
            {rooms.length === 0
              ? 'Your teacher has not added you to a room yet.'
              : `You are in ${rooms.length} room${rooms.length === 1 ? '' : 's'}.`}
          </p>
        </div>
        <SignOutButton />
      </div>

      {rooms.length === 0 ? (
        <div className="panel">
          <p className="hint" style={{ margin: 0 }}>
            Once your teacher adds you to a room, your tokens and cards will show up here. Your
            login ID is <code>{session.user.loginId}</code>.
          </p>
        </div>
      ) : (
        <div className="room-grid">
          {rooms.map((room) => (
            <Link key={room.room_id} href={`/rooms/${room.room_id}/history`} className="room-card">
              <h2>{room.name}</h2>
              <p className="balance">{room.token_balance}</p>
              <p className="hint" style={{ margin: 0 }}>
                tokens ·{' '}
                {room.draws_affordable > 0
                  ? `enough for ${room.draws_affordable} draw${room.draws_affordable === 1 ? '' : 's'}`
                  : `${room.draw_cost_tokens - room.token_balance} more for a draw`}
              </p>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
