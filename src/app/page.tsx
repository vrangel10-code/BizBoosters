import { redirect } from 'next/navigation';
import { readSessionCookie, resolveSession } from '@/server/auth/session';

export const dynamic = 'force-dynamic';

/** Single entry point: routes each role to where it belongs. */
export default async function IndexPage() {
  const session = await resolveSession(await readSessionCookie());

  if (!session) redirect('/login');
  if (session.user.mustChangePassword) redirect('/change-password');
  redirect(session.user.role === 'student' ? '/home' : '/dashboard');
}
