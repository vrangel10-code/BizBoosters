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
 * A stream that dies sooner than this was cut by the platform, not by the
 * network. Serverless hosts kill a function at their execution limit — tens of
 * seconds — while a healthy stream is meant to last the whole lesson.
 */
const HEALTHY_STREAM_MS = 60_000;

/** How often to poll once the stream has been given up on. */
const POLL_MS = 30_000;

/**
 * Remembered per tab, so a student clicking between pages does not re-learn the
 * same lesson on every navigation. sessionStorage rather than localStorage: if
 * the app moves to a host that supports streaming, closing the tab is enough to
 * try again.
 */
const GIVE_UP_KEY = 'bb:sse-unsupported';

const streamingDisabled = (): boolean =>
  process.env.NEXT_PUBLIC_LIVE_UPDATES === 'off' ||
  (typeof sessionStorage !== 'undefined' && sessionStorage.getItem(GIVE_UP_KEY) === '1');

/**
 * Subscribes to the SSE stream, falling back to polling.
 *
 * The stream is an optimisation: notifications are database rows, so the worst
 * case is a slower badge, never a lost one.
 *
 * **Why the lifetime check exists.** This used to reset the failure counter on
 * the stream's `ready` frame, and give up after two failures. On a serverless
 * host that is an infinite loop that costs real money: the connection succeeds,
 * `ready` arrives, the counter resets, the platform kills the function at its
 * execution limit, the client reconnects two seconds later, and around it goes.
 * The fallback was never reached because nothing ever *failed* — each attempt
 * worked briefly and was then guillotined, and every cycle billed a full
 * function lifetime per open tab.
 *
 * So a connection only counts as healthy once it has survived a minute. Two
 * short-lived ones and this stops trying for the rest of the tab's session,
 * which on a serverless host means two cycles rather than an unbounded number.
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
    let shortLived = 0;
    let openedAt = 0;
    let closed = false;

    const startPolling = () => {
      if (poll) return;
      setConnected(false);
      poll = setInterval(() => callbacks.current.onNotification?.(), POLL_MS);
    };

    const giveUpOnStreaming = () => {
      try {
        sessionStorage.setItem(GIVE_UP_KEY, '1');
      } catch {
        // Private browsing can refuse storage; polling still starts.
      }
      startPolling();
    };

    const connect = () => {
      if (closed) return;
      openedAt = Date.now();
      source = new EventSource('/api/v1/stream');

      source.addEventListener('ready', () => setConnected(true));

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

        // The distinction that matters: a stream that lasted counts as working,
        // one that was cut short counts against us. Without this, a host that
        // kills every connection after ten seconds looks like continuous
        // success and the client reconnects forever.
        if (Date.now() - openedAt < HEALTHY_STREAM_MS) {
          shortLived += 1;
        } else {
          shortLived = 0;
        }

        if (shortLived >= 2) {
          giveUpOnStreaming();
          return;
        }
        retry = setTimeout(connect, 2_000);
      };
    };

    if (streamingDisabled()) startPolling();
    else connect();

    return () => {
      closed = true;
      source?.close();
      if (poll) clearInterval(poll);
      if (retry) clearTimeout(retry);
    };
  }, [roomId]);

  return { connected };
}
