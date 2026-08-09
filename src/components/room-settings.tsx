'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiRequestError } from '@/components/api';

export interface RoomSettingsView {
  id: string;
  name: string;
  status: string;
  draw_cost_tokens: number;
  trades_enabled: boolean;
  trade_ratio: number;
  students_see_odds: boolean;
  low_stock_threshold: number;
  version: number;
}

/**
 * The room's economy, editable.
 *
 * These numbers were previously fixed at whatever a room was created with,
 * which is wrong for the thing they control: draw cost and trade ratio are the
 * dials a teacher turns when a class is earning too fast or hoarding, and that
 * is a judgement made mid-term, not at setup.
 *
 * `expected_version` goes with the save. Two educators can share a room, and
 * without it the second save silently overwrites the first — the server rejects
 * a stale version instead, and the page reloads with what is actually stored.
 */
export default function RoomSettings({ room }: { room: RoomSettingsView }) {
  const router = useRouter();
  const [name, setName] = useState(room.name);
  const [drawCost, setDrawCost] = useState(String(room.draw_cost_tokens));
  const [tradeRatio, setTradeRatio] = useState(String(room.trade_ratio));
  const [lowStock, setLowStock] = useState(String(room.low_stock_threshold));
  const [tradesEnabled, setTradesEnabled] = useState(room.trades_enabled);
  const [seeOdds, setSeeOdds] = useState(room.students_see_odds);

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

  const save = () =>
    run(async () => {
      const numbers = {
        draw_cost_tokens: Number(drawCost),
        trade_ratio: Number(tradeRatio),
        low_stock_threshold: Number(lowStock),
      };
      for (const [field, value] of Object.entries(numbers)) {
        if (!Number.isInteger(value) || value < 0) {
          throw new ApiRequestError(
            'validation_failed',
            `${field.replace(/_/g, ' ')} must be a whole number.`,
          );
        }
      }

      await api(`/rooms/${room.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: name.trim(),
          ...numbers,
          trades_enabled: tradesEnabled,
          students_see_odds: seeOdds,
          expected_version: room.version,
        }),
      });
      setMessage('Settings saved.');
    });

  const archive = () => {
    if (
      !window.confirm(
        `Archive "${room.name}"?\n\nStudents can still read their history, but nobody can draw, ` +
          `trade or be awarded tokens. You can delete it afterwards if you want it gone for good.`,
      )
    ) {
      return;
    }
    return run(async () => {
      await api(`/rooms/${room.id}/archive`, { method: 'POST' });
      setMessage('Room archived.');
    });
  };

  /**
   * Deletion is gated on archiving first and on typing the room's name. Both
   * are deliberate friction: this destroys a term of student history, and there
   * is no undo behind it.
   */
  const destroy = () => {
    const typed = window.prompt(
      `This permanently deletes "${room.name}" and every draw, card and token record in it. ` +
        `There is no undo.\n\nType the room's name to confirm:`,
    );
    if (typed === null) return;
    return run(async () => {
      await api(`/rooms/${room.id}/delete`, {
        method: 'POST',
        body: JSON.stringify({ confirm: typed }),
      });
      router.push('/dashboard');
    });
  };

  return (
    <div className="panel" style={{ marginTop: '1.5rem' }}>
      <h2 className="panel-title">Room settings</h2>

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

      <label htmlFor="room-name">Room name</label>
      <input id="room-name" value={name} onChange={(event) => setName(event.target.value)} />

      <div className="settings-grid">
        <div>
          <label htmlFor="draw-cost">Tokens per draw</label>
          <input
            id="draw-cost"
            inputMode="numeric"
            value={drawCost}
            onChange={(event) => setDrawCost(event.target.value)}
          />
          <p className="hint">What one lootbox costs.</p>
        </div>

        <div>
          <label htmlFor="trade-ratio">Cards per trade-up</label>
          <input
            id="trade-ratio"
            inputMode="numeric"
            value={tradeRatio}
            onChange={(event) => setTradeRatio(event.target.value)}
          />
          <p className="hint">How many of one rarity buy one of the next.</p>
        </div>

        <div>
          <label htmlFor="low-stock">Low-stock alert</label>
          <input
            id="low-stock"
            inputMode="numeric"
            value={lowStock}
            onChange={(event) => setLowStock(event.target.value)}
          />
          <p className="hint">Tell me when the deck drops to this many cards.</p>
        </div>
      </div>

      <label className="checkbox">
        <input
          type="checkbox"
          checked={tradesEnabled}
          onChange={(event) => setTradesEnabled(event.target.checked)}
        />
        Let students trade cards up
      </label>

      <label className="checkbox">
        <input
          type="checkbox"
          checked={seeOdds}
          onChange={(event) => setSeeOdds(event.target.checked)}
        />
        Show students the live odds
      </label>

      <button disabled={busy} onClick={save}>
        {busy ? 'Saving…' : 'Save settings'}
      </button>

      <hr className="rule" />

      <h3 className="panel-subtitle">Ending this room</h3>
      <p className="hint">
        Archiving stops play but keeps everything readable. Deleting removes the room and its
        history for good — archive first, and only delete when you are certain.
      </p>
      <div className="card-actions">
        {room.status === 'archived' ? (
          <span className="tag">already archived</span>
        ) : (
          <button className="secondary" disabled={busy} onClick={archive}>
            Archive room
          </button>
        )}
        <button className="danger" disabled={busy} onClick={destroy}>
          Delete room
        </button>
      </div>
    </div>
  );
}
