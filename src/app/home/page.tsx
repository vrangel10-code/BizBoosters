import { redirect } from 'next/navigation';
import { readSessionCookie, resolveSession } from '@/server/auth/session';
import SignOutButton from '@/components/sign-out-button';

export const dynamic = 'force-dynamic';

/** Phase 0 placeholder. Rooms, tokens, inventory and the draw arrive next. */
export default async function StudentHomePage() {
  const session = await resolveSession(await readSessionCookie());

  if (!session) redirect('/login');
  if (session.user.mustChangePassword) redirect('/change-password');
  if (session.user.role !== 'student') redirect('/dashboard');

  return (
    <main className="shell">
      <h1>Hi, {session.user.displayName}</h1>
      <p className="lede">
        Your password is set. Your teacher has not added you to a room yet — once they do, your
        tokens and cards will show up here.
      </p>
      <div className="panel">
        <p style={{ margin: 0 }}>
          Login ID <code>{session.user.loginId}</code>
        </p>
      </div>
      <div style={{ marginTop: '1.5rem' }}>
        <SignOutButton />
      </div>
    </main>
  );
}
