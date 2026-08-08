import { redirect } from 'next/navigation';
import Link from 'next/link';
import { readSessionCookie, resolveSession } from '@/server/auth/session';
import { listCards } from '@/server/services/cards';
import CardCatalog from '@/components/card-catalog';

export const dynamic = 'force-dynamic';

export default async function CardsPage() {
  const session = await resolveSession(await readSessionCookie());

  if (!session) redirect('/login');
  if (session.user.mustChangePassword) redirect('/change-password');
  if (session.user.role === 'student') redirect('/home');
  if (!session.user.schoolId) redirect('/dashboard');

  const cards = await listCards(session.user.schoolId);

  return (
    <main className="shell wide">
      <div className="page-head">
        <div>
          <h1>Card catalog</h1>
          <p className="lede">
            Cards belong to your school and can be used in any room&apos;s deck.
          </p>
        </div>
        <Link href="/dashboard">← Rooms</Link>
      </div>

      <CardCatalog cards={cards} />
    </main>
  );
}
