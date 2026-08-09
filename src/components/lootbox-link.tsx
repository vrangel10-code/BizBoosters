import Link from 'next/link';

/**
 * The way into the draw screen, as a chest rather than a line of text.
 *
 * This is the one thing on a student's room page they are actually there to
 * do, and it was a text link among other text links. The chest is drawn inline
 * as SVG rather than shipped as an image so it scales, inherits the rarity
 * palette, and costs no extra request — which matters on a school Chromebook
 * over a shared connection.
 *
 * It dims and says why when they cannot afford a draw, instead of leading them
 * to a screen that refuses them.
 */
export default function LootboxLink({
  href,
  affordable,
  shortfall,
}: {
  href: string;
  affordable: number;
  shortfall: number;
}) {
  const canDraw = affordable > 0;

  const body = (
    <>
      <svg
        className="lootbox-art"
        viewBox="0 0 64 56"
        role="img"
        aria-label="A treasure chest"
        focusable="false"
      >
        {/* Lid */}
        <path
          d="M8 24C8 14 18 7 32 7s24 7 24 17v3H8v-3Z"
          fill="var(--lootbox-lid)"
          stroke="var(--lootbox-edge)"
          strokeWidth="2.5"
          strokeLinejoin="round"
        />
        {/* Base */}
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
        {/* Band and lock */}
        <rect x="27" y="19" width="10" height="18" rx="2" fill="var(--lootbox-edge)" />
        <circle cx="32" cy="30" r="3.4" fill="var(--lootbox-lid)" />
        {/* Sparkles, only when a draw is affordable */}
        {canDraw ? (
          <g className="lootbox-sparks" fill="var(--lootbox-spark)">
            <path d="M14 12l1.4 3.6L19 17l-3.6 1.4L14 22l-1.4-3.6L9 17l3.6-1.4L14 12Z" />
            <path d="M50 6l1 2.6L53.6 10 51 11l-1 2.6L49 11l-2.6-1L49 8.6 50 6Z" />
          </g>
        ) : null}
      </svg>

      <span className="lootbox-text">
        <strong>{canDraw ? 'Open a lootbox' : 'Not enough tokens yet'}</strong>
        <span className="hint">
          {canDraw
            ? `You can afford ${affordable} draw${affordable === 1 ? '' : 's'}`
            : `${shortfall} more token${shortfall === 1 ? '' : 's'} to go`}
        </span>
      </span>
    </>
  );

  return canDraw ? (
    <Link href={href} className="lootbox">
      {body}
    </Link>
  ) : (
    <span className="lootbox is-locked" aria-disabled="true">
      {body}
    </span>
  );
}
