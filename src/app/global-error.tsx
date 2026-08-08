'use client';

/**
 * Last-resort boundary: replaces the whole document, so it cannot rely on the
 * app's stylesheet being loaded and carries its own styles inline.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: 'ui-sans-serif, system-ui, sans-serif',
          background: '#0f172a',
          color: '#e2e8f0',
          margin: 0,
          padding: '3rem 1.25rem',
        }}
      >
        <main style={{ maxWidth: '30rem', margin: '0 auto' }}>
          <h1 style={{ fontSize: '1.5rem' }}>BizBoosters is having a problem</h1>
          <p>Please reload the page. If it keeps happening, tell your teacher.</p>
          <button
            onClick={reset}
            style={{
              padding: '0.75rem 1.25rem',
              background: '#8b5cf6',
              color: '#fff',
              border: 0,
              borderRadius: '0.5rem',
              fontSize: '1rem',
              cursor: 'pointer',
            }}
          >
            Reload
          </button>
          {error.digest ? (
            <p style={{ color: '#94a3b8', fontSize: '0.8125rem' }}>Code: {error.digest}</p>
          ) : null}
        </main>
      </body>
    </html>
  );
}
