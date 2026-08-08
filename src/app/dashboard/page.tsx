import { redirect } from 'next/navigation';
import { readSessionCookie, resolveSession } from '@/server/auth/session';
import { listStudents } from '@/server/services/students';
import SignOutButton from '@/components/sign-out-button';

export const dynamic = 'force-dynamic';

/**
 * Phase 0 placeholder: enough to prove the educator can sign in and manage
 * student credentials. Rooms, tokens and decks land in phases 1–2.
 */
export default async function DashboardPage() {
  const session = await resolveSession(await readSessionCookie());

  if (!session) redirect('/login');
  if (session.user.mustChangePassword) redirect('/change-password');
  if (session.user.role === 'student') redirect('/home');

  const students = session.user.schoolId ? await listStudents(session.user.schoolId) : [];

  return (
    <main className="shell wide">
      <h1>Welcome, {session.user.displayName}</h1>
      <p className="lede">
        Signed in as {session.user.role.replace('_', ' ')}. Rooms and card decks arrive in the next
        phase.
      </p>

      <div className="panel">
        <h2 style={{ fontSize: '1.125rem', marginTop: 0 }}>Students ({students.length})</h2>
        {students.length === 0 ? (
          <p className="hint" style={{ margin: 0 }}>
            No students yet. Create them via <code>POST /api/v1/students</code>; the roster UI
            arrives with rooms in phase 1.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Login ID</th>
                <th>First login</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {students.map((student) => (
                <tr key={student.id}>
                  <td>{student.displayName}</td>
                  <td>
                    <code>{student.loginId}</code>
                  </td>
                  <td>{student.mustChangePassword ? 'Password not yet set' : 'Done'}</td>
                  <td>{student.lastLoginAt ? student.lastLoginAt.toUTCString() : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div style={{ marginTop: '1.5rem' }}>
        <SignOutButton />
      </div>
    </main>
  );
}
