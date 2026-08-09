'use client';

import { useState } from 'react';

/**
 * The BizBoosters logo and wordmark.
 *
 * The image is loaded from `/logo.png` — drop the real artwork in `public/` and
 * it appears everywhere this component is used. Until then, and if the file is
 * ever missing or fails to load, the chest below stands in rather than leaving
 * a broken-image icon on the sign-in page.
 *
 * A plain `<img>` rather than `next/image`: the fallback needs an `onError`,
 * the asset is small and fixed-size, and there is nothing here for the image
 * optimiser to improve.
 */
export default function Brand({
  size = 'md',
  showName = true,
}: {
  size?: 'md' | 'lg';
  showName?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const pixels = size === 'lg' ? 96 : 56;

  return (
    <div className={`brand brand-${size}`}>
      {failed ? (
        <svg
          className="brand-mark"
          viewBox="0 0 64 56"
          width={pixels}
          height={pixels}
          role="img"
          aria-label="BizBoosters"
          focusable="false"
        >
          <path
            d="M8 24C8 14 18 7 32 7s24 7 24 17v3H8v-3Z"
            fill="var(--lootbox-lid)"
            stroke="var(--lootbox-edge)"
            strokeWidth="2.5"
            strokeLinejoin="round"
          />
          <rect
            x="8"
            y="27"
            width="48"
            height="22"
            rx="3"
            fill="var(--lootbox-body)"
            stroke="var(--lootbox-edge)"
            strokeWidth="2.5"
          />
          <rect x="27" y="19" width="10" height="18" rx="2" fill="var(--lootbox-edge)" />
          <circle cx="32" cy="30" r="3.4" fill="var(--lootbox-lid)" />
        </svg>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          className="brand-mark"
          src="/logo.png"
          alt="BizBoosters"
          width={pixels}
          height={pixels}
          onError={() => setFailed(true)}
        />
      )}

      {showName ? <span className="brand-name">BizBoosters</span> : null}
    </div>
  );
}
