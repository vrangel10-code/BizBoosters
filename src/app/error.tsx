'use client';

import { useEffect } from 'react';

/**
 * Route-level error boundary. Deliberately says nothing about the cause: the
 * audience is a twelve-year-old on a school Chromebook, and a stack trace helps
 * nobody. The digest is shown only so a teacher can quote it in a support
 * message.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[route-error]', error.digest ?? '', error.message);
  }, [error]);

  return (
    <main className="shell">
      <h1>Something went wrong</h1>
      <div className="panel">
        <p style={{ marginTop: 0 }}>
          That did not work. Nothing you were doing has been lost — try again.
        </p>
        <button onClick={reset}>Try again</button>
        {error.digest ? (
          <p className="hint" style={{ marginBottom: 0, marginTop: '1rem' }}>
            If it keeps happening, tell your teacher this code: <code>{error.digest}</code>
          </p>
        ) : null}
      </div>
    </main>
  );
}
