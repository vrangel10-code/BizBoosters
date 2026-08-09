'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiRequestError } from '@/components/api';
import PasswordField from '@/components/password-field';

/**
 * Reached automatically at first login. The gate itself is enforced server-side
 * in requireAuth() — this page is the friendly face of it, not the mechanism.
 */
export default function ChangePasswordPage() {
  const router = useRouter();
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
      // No current_password: this page is only reachable behind the forced
      // first-change gate, and signing in already proved the temporary one.
      await api('/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ new_password: newPassword }),
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
        You are signed in with the password your teacher gave you. Choose your own to carry on —
        you will not need the old one again.
      </p>

      <form className="panel" onSubmit={onSubmit}>
        {error ? (
          <p className="alert error" role="alert">
            {error}
          </p>
        ) : null}

        <PasswordField
          id="next"
          label="New password"
          autoComplete="new-password"
          value={newPassword}
          onChange={setNewPassword}
          hint="At least 8 characters. Pick something you will remember."
          autoFocus
        />

        <PasswordField
          id="confirm"
          label="New password again"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={setConfirmPassword}
        />

        <button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save new password'}
        </button>
      </form>
    </main>
  );
}
