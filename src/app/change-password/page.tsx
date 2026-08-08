'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiRequestError } from '@/components/api';

/**
 * Reached automatically at first login. The gate itself is enforced server-side
 * in requireAuth() — this page is the friendly face of it, not the mechanism.
 */
export default function ChangePasswordPage() {
  const router = useRouter();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    if (newPassword !== confirmPassword) {
      setError('The two new passwords do not match.');
      return;
    }

    setBusy(true);
    try {
      await api('/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
      });
      router.push('/');
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError ? caught.message : 'Could not change your password.',
      );
      setBusy(false);
    }
  }

  return (
    <main className="shell">
      <h1>Choose your own password</h1>
      <p className="lede">
        You are signed in with a password your teacher gave you. Pick your own before you carry on.
      </p>

      <form className="panel" onSubmit={onSubmit}>
        {error ? (
          <p className="alert error" role="alert">
            {error}
          </p>
        ) : null}

        <label htmlFor="current">Password your teacher gave you</label>
        <input
          id="current"
          type="password"
          autoComplete="current-password"
          required
          value={currentPassword}
          onChange={(event) => setCurrentPassword(event.target.value)}
        />

        <label htmlFor="next">New password</label>
        <input
          id="next"
          type="password"
          autoComplete="new-password"
          required
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
        />
        <p className="hint">At least 8 characters. Pick something you will remember.</p>

        <label htmlFor="confirm">New password again</label>
        <input
          id="confirm"
          type="password"
          autoComplete="new-password"
          required
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
        />

        <button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save new password'}
        </button>
      </form>
    </main>
  );
}
