'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/components/api';

interface RecentUse {
  item_id: string;
  card_name: string;
  rarity: string;
  student_name: string;
  used_at: string;
  note: string | null;
  acknowledged: boolean;
}

/**
 * The educator's "perks I still owe" list.
 *
 * The tick-box gates nothing — the card is already spent and already back in
 * the deck. It exists because reading a notification and actually honouring a
 * perk are different events, and six of these during one lesson is easy to
 * lose track of.
 */
export default function RecentUses({ roomId, uses }: { roomId: string; uses: RecentUse[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [hideDone, setHideDone] = useState(true);

  const acknowledge = async (itemId: string) => {
    setBusy(itemId);
    try {
      await api(`/inventory/${itemId}/acknowledge`, {
        method: 'POST',
        body: JSON.stringify({ room_id: roomId }),
      });
      router.refresh();
    } finally {
      setBusy(null);
    }
  };

  const outstanding = uses.filter((use) => !use.acknowledged);
  const shown = hideDone ? outstanding : uses;

  return (
    <div className="panel" style={{ marginTop: '1.5rem' }}>
      <div className="page-head" style={{ marginBottom: '1rem' }}>
        <h2 className="panel-title" style={{ margin: 0 }}>
          Cards used{outstanding.length > 0 ? ` — ${outstanding.length} to honour` : ''}
        </h2>
        {uses.length > outstanding.length ? (
          <button className="link" onClick={() => setHideDone(!hideDone)}>
            {hideDone ? 'Show done' : 'Hide done'}
          </button>
        ) : null}
      </div>

      {shown.length === 0 ? (
        <p className="hint" style={{ margin: 0 }}>
          {uses.length === 0 ? 'No cards have been used yet.' : 'All caught up.'}
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Student</th>
              <th>Card</th>
              <th>When</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.map((use) => (
              <tr key={use.item_id} className={use.acknowledged ? 'done' : ''}>
                <td>{use.student_name}</td>
                <td>
                  {use.card_name}
                  {use.note ? <span className="hint"> — {use.note}</span> : null}
                </td>
                <td>
                  {new Date(use.used_at).toLocaleString(undefined, {
                    dateStyle: 'short',
                    timeStyle: 'short',
                  })}
                </td>
                <td style={{ textAlign: 'right' }}>
                  {use.acknowledged ? (
                    <span className="tag">done</span>
                  ) : (
                    <button
                      className="link"
                      disabled={busy === use.item_id}
                      onClick={() => acknowledge(use.item_id)}
                    >
                      Mark honoured
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
