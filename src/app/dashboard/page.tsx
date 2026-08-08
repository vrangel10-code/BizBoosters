import { redirect } from 'next/navigation';
import Link from 'next/link';
import { readSessionCookie, resolveSession } from '@/server/auth/session';
import { listRoomsForEducator } from '@/server/services/rooms';
import SignOutButton from '@/components/sign-out-button';
import CreateRoomForm from '@/components/create-room-form';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const session = await resolveSession(await readSessionCookie());

  if (!session) redirect('/login');
  if (session.user.mustChangePassword) redirect('/change-password');
  if (session.user.role === 'student') redirect('/home');

  const rooms = await listRoomsForEducator(session.user);

  return (
    <main className="shell wide">
      <div className="page-head">
        <div>
          <h1>Your rooms</h1>
          <p className="lede">Signed in as {session.user.displayName}.</p>
        </div>
        <nav className="page-nav">
          <Link href="/cards">Card catalog</Link>
          <SignOutButton />
        </nav>
      </div>

      {rooms.length === 0 ? (
        <div className="panel">
          <p className="hint" style={{ margin: 0 }}>
            No rooms yet. Create one below, then add your students.
          </p>
        </div>
      ) : (
        <div className="panel">
          <table>
            <thead>
              <tr>
                <th>Room</th>
                <th>Students</th>
                <th>Draw cost</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rooms.map((room) => (
                <tr key={room.id}>
                  <td>
                    {room.name}
                    {room.status === 'archived' ? <span className="tag">archived</span> : null}
                  </td>
                  <td>{room.student_count}</td>
                  <td>{room.draw_cost_tokens} tokens</td>
                  <td style={{ textAlign: 'right' }}>
                    <Link href={`/rooms/${room.id}`}>Open</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ marginTop: '1.5rem' }}>
        <CreateRoomForm />
      </div>
    </main>
  );
}
