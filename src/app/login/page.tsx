'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiRequestError } from '@/components/api';
import PasswordField from '@/components/password-field';

interface LoginResponse {
  user: { role: string };
  must_change_password: boolean;
}

export default function LoginPage() {
  const router = useRouter();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const result = await api<LoginResponse>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ identifier, password }),
      });

      if (result.must_change_password) {
        router.push('/change-password');
      } else {
        router.push(result.user.role === 'student' ? '/home' : '/dashboard');
      }
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError ? caught.message : 'Could not sign in. Try again.',
      );
      setBusy(false);
    }
  }

  return (
    <main className="shell">
      <h1>Sign in to BizBoosters</h1>
      <p className="lede">Students use their login ID. Teachers use their email address.</p>

      <form className="panel" onSubmit={onSubmit}>
        {error ? (
          <p className="alert error" role="alert">
            {error}
          </p>
        ) : null}

        <label htmlFor="identifier">Login ID or email</label>
        <input
          id="identifier"
          name="identifier"
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          required
          value={identifier}
          onChange={(event) => setIdentifier(event.target.value)}
        />

        <PasswordField
          id="password"
          label="Password"
          autoComplete="current-password"
          value={password}
          onChange={setPassword}
        />

        <button type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
