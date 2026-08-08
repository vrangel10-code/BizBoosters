'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import OddsPanel, { type OddsView } from '@/components/odds-panel';
import { useLiveUpdates } from '@/components/live-updates';

/**
 * The odds panel, kept live.
 *
 * With a circulating deck this moves in both directions: a draw takes a copy
 * out, and someone *using* a card puts one back. Watching your own chances
 * improve because a classmate spent their Legendary is the best feedback moment
 * in the game, so it is worth the stream.
 */
export default function LiveOddsPanel({
  roomId,
  initialOdds,
  audience,
}: {
  roomId: string;
  initialOdds: OddsView;
  audience: 'educator' | 'student';
}) {
  const router = useRouter();
  const [odds, setOdds] = useState(initialOdds);
  const [pulse, setPulse] = useState<'up' | 'down' | null>(null);

  useLiveUpdates({
    roomId,
    onPoolChanged: (next) => {
      setOdds((current) => {
        // Direction matters: a number quietly changing reads as noise, while
        // "cards came back" is the thing worth noticing.
        setPulse(next.in_deck > current.in_deck ? 'up' : next.in_deck < current.in_deck ? 'down' : null);
        return { ...current, ...next } as OddsView;
      });
      setTimeout(() => setPulse(null), 1200);
      router.refresh();
    },
  });

  return (
    <div className={pulse ? `pool-pulse pool-pulse-${pulse}` : undefined}>
      <OddsPanel odds={odds} audience={audience} />
    </div>
  );
}
