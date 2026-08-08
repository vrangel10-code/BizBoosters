'use client';

import { useEffect, useRef, useState } from 'react';

export interface LiveOdds {
  in_deck: number;
  held: number;
  total: number;
  rarities?: { code: string; in_deck: number; chance: number }[];
}

interface UseLiveUpdatesOptions {
  roomId?: string;
  onPoolChanged?: (odds: LiveOdds) => void;
  onNotification?: () => void;
}

/**
 * Subscribes to the SSE stream, falling back to polling.
 *
 * The stream is an optimisation: notifications are database rows, so the worst
 * case here is a slower badge, never a lost one. Two failed reconnects and the
 * client stops retrying and polls instead — which also covers the case where
 * the app runs as more than one instance and a push lands on the other one.
 */
export function useLiveUpdates({ roomId, onPoolChanged, onNotification }: UseLiveUpdatesOptions) {
  const [connected, setConnected] = useState(false);

  // Held in a ref so a re-render with new closures does not tear down and
  // re-open the stream on every keystroke elsewhere on the page. Synced in an
  // effect rather than during render: writing a ref while rendering is a
  // side-effect, and it misbehaves when React renders twice.
  const callbacks = useRef({ onPoolChanged, onNotification });
  useEffect(() => {
    callbacks.current = { onPoolChanged, onNotification };
  }, [onPoolChanged, onNotification]);

  useEffect(() => {
    let source: EventSource | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;
    let closed = false;

    const startPolling = () => {
      if (poll) return;
      poll = setInterval(() => callbacks.current.onNotification?.(), 20_000);
    };

    const connect = () => {
      if (closed) return;
      source = new EventSource('/api/v1/stream');

      source.addEventListener('ready', () => {
        failures = 0;
        setConnected(true);
      });

      source.addEventListener('notification', () => callbacks.current.onNotification?.());

      source.addEventListener('room.pool_changed', (event) => {
        try {
          const parsed = JSON.parse((event as MessageEvent<string>).data) as {
            room_id: string;
            odds?: LiveOdds;
          };
          if (roomId && parsed.room_id !== roomId) return;
          if (parsed.odds) callbacks.current.onPoolChanged?.(parsed.odds);
        } catch {
          // A malformed frame is not worth tearing the stream down for.
        }
      });

      source.onerror = () => {
        setConnected(false);
        source?.close();
        failures += 1;
        if (failures >= 2) {
          startPolling();
          return;
        }
        retry = setTimeout(connect, 2_000);
      };
    };

    connect();

    return () => {
      closed = true;
      source?.close();
      if (poll) clearInterval(poll);
      if (retry) clearTimeout(retry);
    };
  }, [roomId]);

  return { connected };
}
