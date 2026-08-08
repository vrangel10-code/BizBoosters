'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/components/api';
import { useLiveUpdates } from '@/components/live-updates';

interface NotificationRow {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  read_at: string | null;
  created_at: string;
}

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

function describe(row: NotificationRow): string {
  const student = str(row.payload.student_name) ?? 'A student';
  const cardName = str(row.payload.card_name) ?? 'a card';

  switch (row.type) {
    case 'card.used':
      return `${student} used ${cardName}`;
    case 'card.drawn':
      return `${student} drew ${cardName}`;
    case 'card.traded':
      return `${student} traded up to ${cardName}`;
    case 'card.returned':
      return `${student} returned ${cardName} to the deck`;
    case 'pool.low':
      return `The deck is running low (${String(row.payload.in_deck ?? '?')} left)`;
    case 'pool.empty':
      return `The deck is empty — ${String(row.payload.held ?? '?')} cards are held by students`;
    default:
      return row.type;
  }
}

/** The educator's live badge. Rows come from the API; SSE only makes them fast. */
export default function NotificationBell({ initialUnread }: { initialUnread: number }) {
  const router = useRouter();
  const [unread, setUnread] = useState(initialUnread);
  const [rows, setRows] = useState<NotificationRow[]>([]);
  const [open, setOpen] = useState(false);

  const refresh = useCallback(async () => {
    const result = await api<{ data: NotificationRow[]; unread: number }>('/notifications?limit=25');
    setRows(result.data);
    setUnread(result.unread);
    // A use or a draw changes the room too, so bring the page with it.
    router.refresh();
  }, [router]);

  useLiveUpdates({ onNotification: refresh });

  // Fetched from the click rather than from an effect on `open`: an effect here
  // would setState during the same commit that opened the panel.
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) void refresh();
  };

  const markAllRead = async () => {
    await api('/notifications/read', { method: 'POST', body: JSON.stringify({ all: true }) });
    await refresh();
  };

  return (
    <div className="bell-wrap">
      <button
        className="secondary bell"
        aria-label={`Notifications${unread > 0 ? `, ${unread} unread` : ''}`}
        aria-expanded={open}
        onClick={toggle}
      >
        Activity
        {unread > 0 ? <span className="bell-badge">{unread > 99 ? '99+' : unread}</span> : null}
      </button>

      {open ? (
        <div className="bell-panel" role="dialog" aria-label="Recent activity">
          <div className="bell-head">
            <strong>Recent activity</strong>
            {unread > 0 ? (
              <button className="link" onClick={markAllRead}>
                Mark all read
              </button>
            ) : null}
          </div>
          {rows.length === 0 ? (
            <p className="hint" style={{ margin: 0 }}>
              Nothing yet.
            </p>
          ) : (
            <ul className="bell-list">
              {rows.map((row) => (
                <li key={row.id} className={row.read_at ? '' : 'unread'}>
                  <span>{describe(row)}</span>
                  <time>
                    {new Date(row.created_at).toLocaleTimeString(undefined, {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </time>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
