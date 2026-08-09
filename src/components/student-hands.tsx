'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiRequestError } from '@/components/api';

export interface HeldStack {
  card_id: string;
  card_name: string;
  rarity: string;
  count: number;
  item_ids: string[];
}

export interface StudentHandView {
  enrollment_id: string;
  student_name: string;
  login_id: string | null;
  token_balance: number;
  held: number;
  stacks: HeldStack[];
}

export interface DeckOption {
  card_id: string;
  name: string;
  rarity: string;
  in_deck: number;
}

const RARITY_LABEL: Record<string, string> = {
  C: 'Common',
  U: 'Uncommon',
  R: 'Rare',
  L: 'Legendary',
};

/**
 * Who is holding what, and the two edits that go with it.
 *
 * The deck summary answers "how many cards are in hands"; this answers *which*
 * — the question actually asked when a Legendary has not been seen for a week,
 * or when a student says they were given the wrong card.
 *
 * Both edits move a copy rather than creating or destroying one. Taking a card
 * back puts it in the deck; handing one over takes it out, and fails when none
 * is free. That is what keeps total = in deck + held true, and it is why there
 * is no "add a card" that mints from nothing.
 */
export default function StudentHands({
  roomId,
  hands,
  deck,
}: {
  roomId: string;
  hands: StudentHandView[];
  deck: DeckOption[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

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

  const takeBack = (student: StudentHandView, stack: HeldStack) => {
    const itemId = stack.item_ids[0];
    if (!itemId) return;
    if (
      !window.confirm(
        `Take ${stack.card_name} back from ${student.student_name}?\n\n` +
          `The copy goes straight back into the deck for everyone.`,
      )
    ) {
      return;
    }
    return run(async () => {
      await api(`/rooms/${roomId}/hands/${itemId}`, { method: 'DELETE' });
      setMessage(`${stack.card_name} is back in the deck.`);
    });
  };

  const give = (student: StudentHandView, cardId: string) => {
    if (!cardId) return;
    return run(async () => {
      const result = await api<{ card: { name: string } }>(`/rooms/${roomId}/hands`, {
        method: 'POST',
        body: JSON.stringify({ enrollment_id: student.enrollment_id, card_id: cardId }),
      });
      setMessage(`${student.student_name} now holds ${result.card.name}.`);
    });
  };

  const available = deck.filter((option) => option.in_deck > 0);

  return (
    <div className="panel" style={{ marginTop: '1.5rem' }}>
      <h2 className="panel-title">Who holds what</h2>
      <p className="hint">
        Every card currently in a student&apos;s hand. Taking one back returns the copy to the
        deck; handing one over takes it out, so the room&apos;s totals never change.
      </p>

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

      {hands.length === 0 ? (
        <p className="hint" style={{ margin: 0 }}>
          Nobody is in this room yet.
        </p>
      ) : (
        <ul className="hand-list">
          {hands.map((student) => {
            const expanded = open === student.enrollment_id;
            return (
              <li key={student.enrollment_id} className="hand">
                <button
                  className="hand-head"
                  aria-expanded={expanded}
                  onClick={() => setOpen(expanded ? null : student.enrollment_id)}
                >
                  <span className="hand-name">{student.student_name}</span>
                  <span className="hand-meta">
                    {student.held} card{student.held === 1 ? '' : 's'} · {student.token_balance}{' '}
                    tokens
                  </span>
                  <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
                </button>

                {expanded ? (
                  <div className="hand-body">
                    {student.stacks.length === 0 ? (
                      <p className="hint" style={{ margin: '0 0 0.75rem' }}>
                        Holding nothing right now.
                      </p>
                    ) : (
                      <table>
                        <thead>
                          <tr>
                            <th>Card</th>
                            <th>Rarity</th>
                            <th>Copies</th>
                            <th />
                          </tr>
                        </thead>
                        <tbody>
                          {student.stacks.map((stack) => (
                            <tr key={stack.card_id}>
                              <td>{stack.card_name}</td>
                              <td>{RARITY_LABEL[stack.rarity] ?? stack.rarity}</td>
                              <td>{stack.count}</td>
                              <td style={{ textAlign: 'right' }}>
                                <button
                                  className="link danger"
                                  disabled={busy}
                                  onClick={() => takeBack(student, stack)}
                                >
                                  Take back
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}

                    <label htmlFor={`give-${student.enrollment_id}`}>Give a card from the deck</label>
                    <select
                      id={`give-${student.enrollment_id}`}
                      disabled={busy || available.length === 0}
                      defaultValue=""
                      onChange={(event) => {
                        const cardId = event.target.value;
                        event.target.value = '';
                        void give(student, cardId);
                      }}
                    >
                      <option value="" disabled>
                        {available.length === 0 ? 'The deck is empty' : 'Choose a card…'}
                      </option>
                      {available.map((option) => (
                        <option key={option.card_id} value={option.card_id}>
                          {option.name} ({RARITY_LABEL[option.rarity] ?? option.rarity}) —{' '}
                          {option.in_deck} left
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
