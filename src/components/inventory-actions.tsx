'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiRequestError } from '@/components/api';

export interface InventoryStackView {
  card_id: string;
  name: string;
  rarity: string;
  effect_text: string | null;
  image_url: string | null;
  count: number;
  item_ids: string[];
}

const RARITY_LABEL: Record<string, string> = {
  C: 'Common',
  U: 'Uncommon',
  R: 'Rare',
  L: 'Legendary',
};

const NEXT_RARITY: Record<string, string | undefined> = { C: 'U', U: 'R', R: 'L' };

export default function InventoryActions({
  roomId,
  stacks,
  tradesEnabled,
  tradeRatio,
}: {
  roomId: string;
  stacks: InventoryStackView[];
  tradesEnabled: boolean;
  tradeRatio: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

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

  const spendCard = (stack: InventoryStackView) =>
    run(async () => {
      const itemId = stack.item_ids[0];
      if (!itemId) return;
      await api(`/inventory/${itemId}/use`, { method: 'POST', body: JSON.stringify({}) });
      setMessage(
        `You used ${stack.name}. Your teacher has been told, and the card is back in the deck for everyone.`,
      );
      setSelected(new Set());
    });

  const toggle = (itemId: string) => {
    const next = new Set(selected);
    if (next.has(itemId)) next.delete(itemId);
    else next.add(itemId);
    setSelected(next);
  };

  // Trades need all three cards at the same rarity; the button explains itself
  // rather than silently refusing.
  const selectedItems = [...selected];
  const rarityOf = new Map<string, string>();
  for (const stack of stacks) for (const id of stack.item_ids) rarityOf.set(id, stack.rarity);
  const selectedRarities = new Set(selectedItems.map((id) => rarityOf.get(id)));
  const tradeRarity = selectedRarities.size === 1 ? [...selectedRarities][0] : undefined;
  const canTrade =
    tradesEnabled &&
    selectedItems.length === tradeRatio &&
    tradeRarity !== undefined &&
    NEXT_RARITY[tradeRarity] !== undefined;

  const trade = () =>
    run(async () => {
      const result = await api<{ card: { name: string; rarity: string } }>(
        `/rooms/${roomId}/trades`,
        {
          method: 'POST',
          headers: { 'idempotency-key': crypto.randomUUID() },
          body: JSON.stringify({ item_ids: selectedItems }),
        },
      );
      setMessage(`You traded up and got ${result.card.name}.`);
      setSelected(new Set());
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

      <ul className="deck-grid">
        {stacks.map((stack) => (
          <li key={stack.card_id} className="deck-card">
            <div className={`bb-card card-${stack.rarity}`}>
              {stack.image_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={stack.image_url} alt="" loading="lazy" />
              ) : (
                <span className="bb-card-initial" aria-hidden="true">
                  {stack.name.slice(0, 1)}
                </span>
              )}
              {stack.count > 1 ? <span className="deck-badge">×{stack.count}</span> : null}
            </div>
            <p className="deck-card-name">{stack.name}</p>
            <p className="deck-card-meta">{RARITY_LABEL[stack.rarity]}</p>
            {stack.effect_text ? <p className="deck-card-meta">{stack.effect_text}</p> : null}

            {/*
              Use is the only way out of a hand, by design. "Return" existed as
              a symmetric counterpart and turned out to be a trap: it hands a
              card back for nothing, and a student who taps it expecting an undo
              has simply lost the card. The two legitimate exits — spending it,
              or trading three up — are both here, and both give something back.
            */}
            <div className="card-actions">
              <button className="link" disabled={busy} onClick={() => spendCard(stack)}>
                Use
              </button>
            </div>

            {tradesEnabled && NEXT_RARITY[stack.rarity] ? (
              <div className="trade-picks">
                {stack.item_ids.map((itemId, index) => (
                  <label key={itemId} className="trade-pick">
                    <input
                      type="checkbox"
                      checked={selected.has(itemId)}
                      onChange={() => toggle(itemId)}
                      aria-label={`Select copy ${index + 1} of ${stack.name} for trading`}
                    />
                  </label>
                ))}
              </div>
            ) : null}
          </li>
        ))}
      </ul>

      {tradesEnabled ? (
        <div className="trade-bar">
          <p className="hint" style={{ margin: 0 }}>
            Tick {tradeRatio} cards of the same rarity to trade them in for one of the next rarity
            up. The cards you give up go back into the deck.
          </p>
          <button disabled={busy || !canTrade} onClick={trade}>
            {selectedItems.length === 0
              ? `Trade ${tradeRatio} cards up`
              : canTrade && tradeRarity
                ? `Trade ${tradeRatio} ${RARITY_LABEL[tradeRarity]} → 1 ${RARITY_LABEL[NEXT_RARITY[tradeRarity]!]}`
                : selectedRarities.size > 1
                  ? 'Pick cards of one rarity'
                  : `Pick ${tradeRatio - selectedItems.length} more`}
          </button>
        </div>
      ) : null}
    </>
  );
}
