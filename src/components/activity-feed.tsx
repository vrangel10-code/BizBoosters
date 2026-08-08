interface ActivityRow {
  id: string;
  type: string;
  createdAt: string;
  actorName: string | null;
  subjectName: string | null;
  payload: Record<string, unknown>;
}

const num = (value: unknown): number | null => (typeof value === 'number' ? value : null);
const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** One sentence per event, in the room's own vocabulary. */
function describe(row: ActivityRow): string {
  const who = row.subjectName ?? 'a student';
  const amount = num(row.payload.amount);
  const delta = num(row.payload.delta);
  const note = str(row.payload.note);

  switch (row.type) {
    case 'tokens.awarded':
      return `${who} received ${amount ?? '?'} tokens${note ? ` — ${note}` : ''}`;
    case 'tokens.adjusted':
      return `${who}'s tokens adjusted by ${delta ?? '?'}${note ? ` — ${note}` : ''}`;
    case 'tokens.undone':
      return `An award to ${who} was undone (${delta ?? '?'} tokens)`;
    case 'enrollment.added':
      return `${who} joined the room`;
    case 'enrollment.removed':
      return `${who} was removed from the room`;
    case 'room.created':
      return 'Room created';
    case 'room.settings_changed':
      return 'Room settings changed';
    case 'room.archived':
      return 'Room archived';
    default:
      return row.type;
  }
}

/**
 * A bulk award writes one row per student, which would otherwise bury the log
 * under 30 near-identical lines. Rows sharing a batch id collapse into one.
 */
function collapse(rows: ActivityRow[]): { row: ActivityRow; count: number }[] {
  const out: { row: ActivityRow; count: number }[] = [];
  const seenBatches = new Map<string, number>();

  for (const row of rows) {
    const batchId = str(row.payload.batch_id);
    if (!batchId) {
      out.push({ row, count: 1 });
      continue;
    }
    const index = seenBatches.get(batchId);
    if (index === undefined) {
      seenBatches.set(batchId, out.length);
      out.push({ row, count: 1 });
    } else {
      out[index]!.count += 1;
    }
  }
  return out;
}

export default function ActivityFeed({ rows }: { rows: ActivityRow[] }) {
  const collapsed = collapse(rows);

  return (
    <div className="panel">
      <h2 className="panel-title">Room activity</h2>
      {collapsed.length === 0 ? (
        <p className="hint" style={{ margin: 0 }}>
          Nothing has happened in this room yet.
        </p>
      ) : (
        <ul className="feed">
          {collapsed.map(({ row, count }) => {
            const amount = num(row.payload.amount);
            const note = str(row.payload.note);
            return (
              <li key={row.id}>
                <span className="feed-when">
                  {new Date(row.createdAt).toLocaleString(undefined, {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })}
                </span>
                <span>
                  {count > 1 && row.type === 'tokens.awarded'
                    ? `Awarded ${amount ?? '?'} tokens to ${count} students${note ? ` — ${note}` : ''}`
                    : describe(row)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
