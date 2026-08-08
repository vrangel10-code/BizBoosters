import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'BizBoosters',
  description: 'Classroom token economy and trading-card game',
  // Student pages are behind a login and contain children's names; they have
  // no business in a search index.
  robots: { index: false, follow: false },
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  // Never disable zoom: pinch-zoom is how a low-vision student reads a card.
  maximumScale: 5,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {/* Keyboard users otherwise tab through every nav link on each page. */}
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <div id="main">{children}</div>
      </body>
    </html>
  );
}
