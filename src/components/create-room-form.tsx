'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiRequestError } from '@/components/api';

export default function CreateRoomForm() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      await api('/rooms', { method: 'POST', body: JSON.stringify({ name }) });
      setName('');
      router.refresh();
    } catch (caught) {
      setError(caught instanceof ApiRequestError ? caught.message : 'Could not create the room.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel" onSubmit={onSubmit}>
      <h2 className="panel-title">New room</h2>
      {error ? (
        <p className="alert error" role="alert">
          {error}
        </p>
      ) : null}

      <label htmlFor="room-name">Room name</label>
      <input
        id="room-name"
        required
        placeholder="Enterprise 7B"
        value={name}
        onChange={(event) => setName(event.target.value)}
      />

      <button type="submit" disabled={busy}>
        {busy ? 'Creating…' : 'Create room'}
      </button>
    </form>
  );
}
