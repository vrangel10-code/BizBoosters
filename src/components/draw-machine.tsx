'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiRequestError } from '@/components/api';
import { type OddsView } from '@/components/odds-panel';
import LiveOddsPanel from '@/components/live-odds-panel';

interface DrawResponse {
  draw: { id: string; replayed: boolean };
  card: {
    id: string;
    name: string;
    rarity: 'C' | 'U' | 'R' | 'L';
    effect_text: string | null;
    image_url: string | null;
  };
  token_balance: number;
  token_cost: number;
  odds: OddsView;
}

const RARITY_LABEL: Record<string, string> = {
  C: 'Common',
  U: 'Uncommon',
  R: 'Rare',
  L: 'Legendary',
};

/** The prototype's shake-then-reveal beat. */
const SHAKE_MS = 1200;

/**
 * The reduced-motion preference is external state that can change while the
 * page is open, so it is subscribed to rather than copied into state inside an
 * effect. getServerSnapshot returns false: the server cannot know, and assuming
 * motion is fine because nothing animates until the student presses the button.
 */
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function subscribeToReducedMotion(onChange: () => void): () => void {
  const query = window.matchMedia(REDUCED_MOTION_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

export default function DrawMachine({
  roomId,
  drawCost,
  initialBalance,
  initialOdds,
}: {
  roomId: string;
  drawCost: number;
  initialBalance: number;
  initialOdds: OddsView;
}) {
  const router = useRouter();
  const [balance, setBalance] = useState(initialBalance);
  const [odds, setOdds] = useState(initialOdds);
  const [phase, setPhase] = useState<'idle' | 'opening' | 'revealed'>('idle');
  const [result, setResult] = useState<DrawResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reducedMotion = useSyncExternalStore(
    subscribeToReducedMotion,
    () => window.matchMedia(REDUCED_MOTION_QUERY).matches,
    () => false,
  );

  // Leaving a reveal timer running after unmount would set state on a gone
  // component and, worse, drop the card the student already paid for.
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const canAfford = balance >= drawCost;
  const deckEmpty = odds.is_empty;

  const open = useCallback(async () => {
    if (phase !== 'idle') return;
    setError(null);
    setPhase('opening');

    // One key per button press, reused if the request has to be retried, so a
    // dropped response can never charge twice.
    const idempotencyKey = crypto.randomUUID();

    try {
      const response = await api<DrawResponse>(`/rooms/${roomId}/draws`, {
        method: 'POST',
        headers: { 'idempotency-key': idempotencyKey },
        body: JSON.stringify({}),
      });

      // The result is decided server-side before the animation plays. The
      // animation is theatre over a settled outcome — never the other way
      // round, or a failed draw would open the chest and then apologise.
      const reveal = () => {
        setResult(response);
        setBalance(response.token_balance);
        setOdds(response.odds);
        setPhase('revealed');
        router.refresh();
      };

      if (reducedMotion) reveal();
      else timer.current = setTimeout(reveal, SHAKE_MS);
    } catch (caught) {
      setPhase('idle');
      setError(
        caught instanceof ApiRequestError
          ? caught.code === 'pool_empty'
            ? 'There are no cards left in the deck right now. They come back when people use them.'
            : caught.message
          : 'Could not open the lootbox. Try again.',
      );
    }
  }, [phase, roomId, reducedMotion, router]);

  const close = () => {
    setPhase('idle');
    setResult(null);
  };

  return (
    <>
      <div className="panel draw-stage">
        {error ? (
          <p className="alert error" role="alert">
            {error}
          </p>
        ) : null}

        {phase === 'revealed' && result ? (
          <div className="reveal" role="status" aria-live="polite">
            <p className={`reveal-rarity rarity-${result.card.rarity}`}>
              {RARITY_LABEL[result.card.rarity]}
            </p>
            <div
              className={`bb-card card-${result.card.rarity} reveal-card ${
                result.card.rarity === 'L' ? 'legendary-glow' : ''
              }`}
            >
              {result.card.image_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={result.card.image_url} alt="" />
              ) : (
                <span className="bb-card-initial" aria-hidden="true">
                  {result.card.name.slice(0, 1)}
                </span>
              )}
            </div>
            <p className="reveal-name">{result.card.name}</p>
            {result.card.effect_text ? (
              <p className="hint reveal-effect">{result.card.effect_text}</p>
            ) : null}
            <button className="secondary" onClick={close}>
              Close
            </button>
          </div>
        ) : (
          <div className="chest-area">
            <div
              className={`chest ${phase === 'opening' && !reducedMotion ? 'shaking' : ''}`}
              aria-hidden="true"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="150" height="150">
                <path
                  d="M3 10C3 8.9 3.9 8 5 8h14c1.1 0 2 .9 2 2v10c0 1.1-.9 2-2 2H5c-1.1 0-2-.9-2-2V10Z"
                  fill="#A0522D"
                />
                <path d="M3 10c0-3.3 2.7-6 6-6h6c3.3 0 6 2.7 6 6H3Z" fill="#8B4513" />
                <rect x="2" y="9" width="20" height="2" fill="#FFD700" />
                <path d="M11 9h2v4a1 1 0 1 1-2 0V9Z" fill="#FFD700" />
                <rect x="6" y="4.5" width="2" height="17.5" fill="#2d3748" opacity="0.6" />
                <rect x="16" y="4.5" width="2" height="17.5" fill="#2d3748" opacity="0.6" />
              </svg>
            </div>

            <p className="draw-balance">
              <strong>{balance}</strong> tokens · {drawCost} per draw
            </p>

            <button onClick={open} disabled={phase !== 'idle' || !canAfford || deckEmpty}>
              {phase === 'opening'
                ? 'Opening…'
                : deckEmpty
                  ? 'The deck is empty'
                  : canAfford
                    ? 'Open lootbox'
                    : `${drawCost - balance} more tokens needed`}
            </button>

            <p className="hint" style={{ marginBottom: 0 }}>
              {deckEmpty
                ? 'Cards come back to the deck when people use them.'
                : canAfford
                  ? `You can open ${Math.floor(balance / drawCost)} right now.`
                  : 'Earn tokens from your teacher to open a lootbox.'}
            </p>
          </div>
        )}
      </div>

      <div style={{ marginTop: '1.5rem' }}>
        <LiveOddsPanel roomId={roomId} initialOdds={odds} audience="student" />
      </div>
    </>
  );
}
