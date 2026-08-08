'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiRequestError } from '@/components/api';

interface RosterRow {
  enrollment_id: string;
  display_name: string;
  login_id: string | null;
  token_balance: number;
  must_change_password: boolean;
  locked: boolean;
}

interface Credentials {
  login_id: string;
  default_password: string;
  display_name?: string;
}

export default function RoomManager({
  roomId,
  roster,
}: {
  roomId: string;
  roster: RosterRow[];
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [amount, setAmount] = useState('20');
  const [note, setNote] = useState('');
  const [newName, setNewName] = useState('');
  const [csv, setCsv] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * Credentials come back from the server exactly once and are never readable
   * again, so they are held here until the educator dismisses them rather than
   * disappearing on the next refresh.
   */
  const [issued, setIssued] = useState<Credentials[]>([]);

  const allSelected = roster.length > 0 && selected.size === roster.length;

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await action();
      router.refresh();
    } catch (caught) {
      setError(caught instanceof ApiRequestError ? caught.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  const award = () =>
    run(async () => {
      const parsed = Number(amount);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new ApiRequestError('validation_failed', 'Enter a whole number of tokens above zero.');
      }
      const result = await api<{ awarded: unknown[] }>(`/rooms/${roomId}/tokens/award`, {
        method: 'POST',
        body: JSON.stringify({
          enrollment_ids: [...selected],
          amount: parsed,
          note: note.trim() || undefined,
        }),
      });
      setMessage(
        `Awarded ${parsed} tokens to ${result.awarded.length} student${
          result.awarded.length === 1 ? '' : 's'
        }.`,
      );
      setSelected(new Set());
      setNote('');
    });

  const addStudent = () =>
    run(async () => {
      const result = await api<{ credentials: Credentials; student: { display_name: string } }>(
        `/rooms/${roomId}/students`,
        { method: 'POST', body: JSON.stringify({ display_name: newName }) },
      );
      setIssued([{ ...result.credentials, display_name: result.student.display_name }]);
      setNewName('');
    });

  const importCsv = () =>
    run(async () => {
      const result = await api<{
        created: Credentials[];
        skipped: { row: number; name: string; reason: string }[];
      }>(`/rooms/${roomId}/students/import`, {
        method: 'POST',
        body: JSON.stringify({ csv }),
      });
      setIssued(result.created);
      setCsv('');
      if (result.skipped.length > 0) {
        setError(
          `${result.skipped.length} row(s) skipped: ${result.skipped
            .map((row) => `line ${row.row} (${row.name}) — ${row.reason}`)
            .join('; ')}`,
        );
      }
    });

  const resetPassword = (enrollmentId: string) =>
    run(async () => {
      const result = await api<{ credentials: Credentials }>(
        `/rooms/${roomId}/students/${enrollmentId}/reset-password`,
        { method: 'POST' },
      );
      setIssued([result.credentials]);
    });

  return (
    <>
      {error ? (
        <p className="alert error" role="alert">
          {error}
        </p>
      ) : null}
      {message ? (
        <p className="alert ok" role="status">
          {message}
        </p>
      ) : null}

      {issued.length > 0 ? (
        <div className="panel credentials">
          <h2 className="panel-title">Sign-in details — shown once</h2>
          <p className="hint">
            Print or copy these now. They cannot be shown again; a lost password needs a reset.
          </p>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Login ID</th>
                <th>Password</th>
              </tr>
            </thead>
            <tbody>
              {issued.map((row) => (
                <tr key={row.login_id}>
                  <td>{row.display_name ?? '—'}</td>
                  <td>
                    <code>{row.login_id}</code>
                  </td>
                  <td>
                    <code>{row.default_password}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button className="secondary" style={{ marginTop: '1rem' }} onClick={() => setIssued([])}>
            I have saved these
          </button>
        </div>
      ) : null}

      <div className="panel">
        <h2 className="panel-title">Students</h2>

        {roster.length === 0 ? (
          <p className="hint">No students yet. Add one below or paste a class list.</p>
        ) : (
          <>
            <table>
              <thead>
                <tr>
                  <th style={{ width: '2.5rem' }}>
                    <input
                      type="checkbox"
                      aria-label="Select all students"
                      checked={allSelected}
                      onChange={() =>
                        setSelected(
                          allSelected ? new Set() : new Set(roster.map((r) => r.enrollment_id)),
                        )
                      }
                    />
                  </th>
                  <th>Name</th>
                  <th>Login ID</th>
                  <th>Tokens</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {roster.map((student) => (
                  <tr key={student.enrollment_id}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Select ${student.display_name}`}
                        checked={selected.has(student.enrollment_id)}
                        onChange={() => toggle(student.enrollment_id)}
                      />
                    </td>
                    <td>
                      {student.display_name}
                      {student.must_change_password ? (
                        <span className="tag">password not set</span>
                      ) : null}
                      {student.locked ? <span className="tag danger">locked</span> : null}
                    </td>
                    <td>
                      <code>{student.login_id}</code>
                    </td>
                    <td>{student.token_balance}</td>
                    <td style={{ textAlign: 'right' }}>
                      <button
                        className="link"
                        disabled={busy}
                        onClick={() => resetPassword(student.enrollment_id)}
                      >
                        Reset password
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="award-bar">
              <div>
                <label htmlFor="amount">Tokens</label>
                <input
                  id="amount"
                  inputMode="numeric"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                />
              </div>
              <div style={{ flex: 1 }}>
                <label htmlFor="note">Reason (optional, but students see it)</label>
                <input
                  id="note"
                  placeholder="Great pitch in week 4"
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                />
              </div>
              <button disabled={busy || selected.size === 0} onClick={award}>
                Award to {selected.size} selected
              </button>
            </div>
          </>
        )}
      </div>

      <div className="panel" style={{ marginTop: '1.5rem' }}>
        <h2 className="panel-title">Add students</h2>

        <label htmlFor="new-name">One student</label>
        <div className="inline-form">
          <input
            id="new-name"
            placeholder="Aisha Tan"
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
          />
          <button disabled={busy || !newName.trim()} onClick={addStudent}>
            Add
          </button>
        </div>

        <label htmlFor="csv" style={{ marginTop: '1.25rem' }}>
          Or paste a class list
        </label>
        <textarea
          id="csv"
          rows={5}
          placeholder={'Aisha Tan\nBen Cole\nChi Nwosu'}
          value={csv}
          onChange={(event) => setCsv(event.target.value)}
        />
        <p className="hint">
          One name per line. Add a comma and a school ID to set login IDs yourself:{' '}
          <code>Aisha Tan,s1234567a</code>
        </p>
        <button disabled={busy || !csv.trim()} onClick={importCsv}>
          Import class list
        </button>
      </div>
    </>
  );
}
