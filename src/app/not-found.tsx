import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="shell">
      <h1>Not found</h1>
      <div className="panel">
        <p style={{ marginTop: 0 }}>
          That page does not exist, or you do not have access to it.
        </p>
        <p className="hint" style={{ marginBottom: 0 }}>
          If a teacher sent you a link, check it was copied in full.
        </p>
      </div>
      <p style={{ marginTop: '1.5rem' }}>
        <Link href="/">Back to your rooms</Link>
      </p>
    </main>
  );
}
