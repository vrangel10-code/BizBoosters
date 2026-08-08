'use client';

import { useRouter } from 'next/navigation';
import { api } from '@/components/api';

export default function SignOutButton() {
  const router = useRouter();

  return (
    <button
      className="secondary"
      onClick={async () => {
        await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
        router.push('/login');
        router.refresh();
      }}
    >
      Sign out
    </button>
  );
}
