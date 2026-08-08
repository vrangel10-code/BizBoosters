'use client';

import { useRouter, useSearchParams } from 'next/navigation';

interface Row {
  id: string;
  type: string;
  createdAt: string;
  actorName: string | null;
  subjectName: string | null;
  payload: Record<string, unknown>;
}

const TYPES = [
  { value: '', label: 'Everything' },
  { value: 'tokens.awarded', label: 'Tokens awarded' },
  { value: 'tokens.adjusted', label: 'Tokens adjusted' },
  { value: 'card.drawn', label: 'Cards drawn' },
  { value: 'card.used', label: 'Cards used' },
  { value: 'card.traded', label: 'Trades' },
  { value: 'card.returned', label: 'Cards returned' },
  { value: 'enrollment.added', label: 'Students added' },
  { value: 'pool.reset', label: 'Deck resets' },
];

const num = (value: unknown) => (typeof value === 'number' ? value : null);
const str = (value: unknown) => (typeof value === 'string' ? value : null);

function describe(row: Row): string {
  const card = str(row.payload.card_name);
  const note = str(row.payload.note);
  switch (row.type) {
    case 'tokens.awarded':
      return `received ${num(row.payload.amount) ?? '?'} tokens${note ? ` — ${note}` : ''}`;
    case 'tokens.adjusted':
      return `tokens adjusted by ${num(row.payload.delta) ?? '?'}${note ? ` — ${note}` : ''}`;
    case 'tokens.undone':
      return `award undone (${num(row.payload.delta) ?? '?'} tokens)`;
    case 'card.drawn':
      return `drew ${card ?? 'a card'}`;
    case 'card.used':
      return `used ${card ?? 'a card'}${note ? ` — ${note}` : ''}`;
    case 'card.returned':
      return `returned ${card ?? 'a card'} to the deck`;
    case 'card.traded':
      return `traded up to ${card ?? 'a card'}`;
    case 'enrollment.added':
      return 'joined the room';
    case 'enrollment.removed':
      return 'was removed from the room';
    case 'pool.reset':
      return 'deck was reset';
    case 'pool.updated':
      return 'deck was changed';
    case 'pool.low':
      return `deck ran low (${num(row.payload.in_deck) ?? '?'} left)`;
    case 'pool.empty':
      return 'deck ran empty';
    case 'room.created':
      return 'room was created';
    case 'room.archived':
      return 'room was archived';
    case 'room.settings_changed':
      return 'room settings changed';
    default:
      return row.type;
  }
}

/**
 * A bulk award writes one row per student, so 30 near-identical lines would
 * bury everything else. Rows sharing a batch collapse into one.
 */
function collapse(rows: Row[]): { row: Row; count: number }[] {
  const out: { row: Row; count: number }[] = [];
  const seen = new Map<string, number>();

  for (const row of rows) {
    const batchId = str(row.payload.batch_id);
    if (!batchId) {
      out.push({ row, count: 1 });
      continue;
    }
    const index = seen.get(batchId);
    if (index === undefined) {
      seen.set(batchId, out.length);
      out.push({ row, count: 1 });
    } else {
      out[index]!.count += 1;
    }
  }
  return out;
}

export default function ActivityLog({
  roomId,
  rows,
  roster,
  filters,
}: {
  roomId: string;
  rows: Row[];
  roster: { enrollment_id: string; display_name: string }[];
  filters: { enrollment_id?: string; type?: string; from?: string; to?: string };
}) {
  const router = useRouter();
  const params = useSearchParams();

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    router.push(`/rooms/${roomId}/activity?${next.toString()}`);
  };

  const exportHref = `/api/v1/rooms/${roomId}/activity/export?${new URLSearchParams(
    Object.entries(filters).filter(([, value]) => Boolean(value)) as [string, string][],
  ).toString()}`;

  const collapsed = collapse(rows);
  const active = Object.values(filters).some(Boolean);

  return (
    <>
      <div className="panel filter-bar">
        <div>
          <label htmlFor="f-student">Student</label>
          <select
            id="f-student"
            value={filters.enrollment_id ?? ''}
            onChange={(event) => setFilter('enrollment_id', event.target.value)}
          >
            <option value="">Everyone</option>
            {roster.map((row) => (
              <option key={row.enrollment_id} value={row.enrollment_id}>
                {row.display_name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="f-type">Activity</label>
          <select
            id="f-type"
            value={filters.type ?? ''}
            onChange={(event) => setFilter('type', event.target.value)}
          >
            {TYPES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="f-from">From</label>
          <input
            id="f-from"
            type="date"
            value={filters.from ?? ''}
            onChange={(event) => setFilter('from', event.target.value)}
          />
        </div>

        <div>
          <label htmlFor="f-to">To</label>
          <input
            id="f-to"
            type="date"
            value={filters.to ?? ''}
            onChange={(event) => setFilter('to', event.target.value)}
          />
        </div>

        <div className="filter-actions">
          {active ? (
            <button className="secondary" onClick={() => router.push(`/rooms/${roomId}/activity`)}>
              Clear
            </button>
          ) : null}
          <a className="button-link" href={exportHref} download>
            Download CSV
          </a>
        </div>
      </div>

      <div className="panel" style={{ marginTop: '1.5rem' }}>
        {collapsed.length === 0 ? (
          <p className="hint" style={{ margin: 0 }}>
            {active
              ? 'Nothing matches those filters. Try widening them.'
              : 'Nothing has happened in this room yet.'}
          </p>
        ) : (
          <table>
            <caption className="visually-hidden">Room activity</caption>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Who</th>
                <th scope="col">What</th>
              </tr>
            </thead>
            <tbody>
              {collapsed.map(({ row, count }) => (
                <tr key={row.id}>
                  <td className="nowrap">
                    <time dateTime={row.createdAt}>
                      {new Date(row.createdAt).toLocaleString(undefined, {
                        dateStyle: 'short',
                        timeStyle: 'short',
                      })}
                    </time>
                  </td>
                  <td>
                    {count > 1 ? `${count} students` : (row.subjectName ?? row.actorName ?? '—')}
                  </td>
                  <td>{describe(row)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
