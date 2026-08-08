'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiRequestError } from '@/components/api';
import type { DeckEntryView } from '@/components/deck-grid';

interface CatalogCard {
  id: string;
  name: string;
  rarity: string;
  image_url: string | null;
}

const RARITY_LABEL: Record<string, string> = {
  C: 'Common',
  U: 'Uncommon',
  R: 'Rare',
  L: 'Legendary',
};

/** The prototype's per-rarity copy counts: 10 / 5 / 2 / 1. */
const PROTOTYPE_COPIES: Record<string, number> = { C: 10, U: 5, R: 2, L: 1 };

export default function DeckBuilder({
  roomId,
  roomName,
  catalog,
  deck,
}: {
  roomId: string;
  roomName: string;
  catalog: CatalogCard[];
  deck: DeckEntryView[];
}) {
  const router = useRouter();

  const heldByCard = useMemo(
    () => new Map(deck.map((entry) => [entry.card_id, entry.held])),
    [deck],
  );

  const [totals, setTotals] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const card of catalog) {
      const entry = deck.find((row) => row.card_id === card.id);
      initial[card.id] = String(entry?.copies_total ?? 0);
    }
    return initial;
  });

  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmText, setConfirmText] = useState('');

  const grouped = useMemo(
    () =>
      ['C', 'U', 'R', 'L']
        .map((rarity) => ({ rarity, cards: catalog.filter((card) => card.rarity === rarity) }))
        .filter((group) => group.cards.length > 0),
    [catalog],
  );

  const plannedTotal = Object.values(totals).reduce(
    (sum, value) => sum + (Number(value) || 0),
    0,
  );

  const save = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const entries = catalog
        .map((card) => ({ card_id: card.id, copies_total: Number(totals[card.id] ?? 0) }))
        .filter((entry) => Number.isInteger(entry.copies_total) && entry.copies_total >= 0);

      if (entries.every((entry) => entry.copies_total === 0)) {
        throw new ApiRequestError('validation_failed', 'Give at least one card some copies.');
      }

      const result = await api<{ capped: { card_id: string; requested: number; applied: number }[] }>(
        `/rooms/${roomId}/deck`,
        { method: 'PUT', body: JSON.stringify({ entries }) },
      );

      if (result.capped.length > 0) {
        // Surfaced rather than silently obeyed: the educator asked for a total
        // below what students already hold.
        const names = result.capped
          .map((row) => {
            const card = catalog.find((c) => c.id === row.card_id);
            return `${card?.name ?? 'a card'} (kept at ${row.applied})`;
          })
          .join(', ');
        setMessage(
          `Deck saved. Some totals were raised to match copies students already hold: ${names}.`,
        );
      } else {
        setMessage('Deck saved.');
      }
      router.refresh();
    } catch (caught) {
      setError(caught instanceof ApiRequestError ? caught.message : 'Could not save the deck.');
    } finally {
      setBusy(false);
    }
  };

  const applyPrototypeCounts = () => {
    const next: Record<string, string> = {};
    for (const card of catalog) next[card.id] = String(PROTOTYPE_COPIES[card.rarity] ?? 1);
    setTotals(next);
  };

  const reset = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await api<{ copies_returned: number }>(`/rooms/${roomId}/deck/reset`, {
        method: 'POST',
        body: JSON.stringify({ confirm: confirmText }),
      });
      setMessage(
        `Deck reset. ${result.copies_returned} held card${
          result.copies_returned === 1 ? '' : 's'
        } returned to the deck.`,
      );
      setConfirmText('');
      router.refresh();
    } catch (caught) {
      setError(caught instanceof ApiRequestError ? caught.message : 'Could not reset the deck.');
    } finally {
      setBusy(false);
    }
  };

  if (catalog.length === 0) {
    return (
      <div className="panel">
        <h2 className="panel-title">Build the deck</h2>
        <p className="hint" style={{ margin: 0 }}>
          Your school has no cards yet. Add some in the <a href="/cards">card catalog</a> first.
        </p>
      </div>
    );
  }

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

      <div className="panel">
        <h2 className="panel-title">Copies of each card</h2>
        <p className="hint">
          You set the <strong>total</strong> number of copies that exist. How many are in the deck
          right now follows from that minus whatever students are holding.
        </p>

        <button className="secondary" style={{ width: 'auto' }} onClick={applyPrototypeCounts}>
          Use the standard spread (10 / 5 / 2 / 1)
        </button>

        {grouped.map((group) => (
          <section key={group.rarity} className="deck-group">
            <h3 className={`deck-group-head rarity-${group.rarity}`}>
              {RARITY_LABEL[group.rarity]}
            </h3>
            {group.cards.map((card) => {
              const held = heldByCard.get(card.id) ?? 0;
              return (
                <div key={card.id} className="deck-builder-row">
                  <div className={`bb-card card-${card.rarity}`}>
                    {card.image_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={card.image_url} alt="" loading="lazy" />
                    ) : (
                      <span className="bb-card-initial" aria-hidden="true">
                        {card.name.slice(0, 1)}
                      </span>
                    )}
                  </div>
                  <label htmlFor={`copies-${card.id}`}>{card.name}</label>
                  <input
                    id={`copies-${card.id}`}
                    inputMode="numeric"
                    value={totals[card.id] ?? '0'}
                    onChange={(event) =>
                      setTotals({ ...totals, [card.id]: event.target.value.replace(/[^0-9]/g, '') })
                    }
                  />
                  <span className="deck-builder-held">
                    {held > 0 ? `${held} held` : '—'}
                  </span>
                </div>
              );
            })}
          </section>
        ))}

        <div style={{ marginTop: '1.5rem' }}>
          <p className="hint">{plannedTotal} copies in total.</p>
          <button disabled={busy} onClick={save}>
            {busy ? 'Saving…' : 'Save deck'}
          </button>
        </div>
      </div>

      <div className="panel danger-zone" style={{ marginTop: '1.5rem' }}>
        <h2 className="panel-title">Reset the deck</h2>
        <p className="hint">
          Refills every card and <strong>clears every student&apos;s collection</strong>. This is
          the end-of-semester action and it cannot be undone. Token balances are not affected.
        </p>
        <label htmlFor="confirm">
          Type <code>{roomName}</code> to confirm
        </label>
        <input
          id="confirm"
          value={confirmText}
          onChange={(event) => setConfirmText(event.target.value)}
        />
        <button className="danger" disabled={busy || confirmText !== roomName} onClick={reset}>
          Reset deck and clear all collections
        </button>
      </div>
    </>
  );
}
