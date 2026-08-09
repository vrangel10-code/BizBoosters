/**
 * One sentence per activity event, in one place.
 *
 * There were three renderers: the educator's log, the room feed, and the
 * student's "Room updates", which printed the raw event type with the dots
 * swapped for spaces — so a student saw "card drawn" and never learned *which*
 * card. Every event already carries `card_name` in its payload; only the
 * student's view was not reading it.
 *
 * Keeping the vocabulary here means a new event type is worded once. Anything
 * unrecognised still degrades to a readable form rather than a raw identifier.
 */
export interface ActivityRowLike {
  type: string;
  /**
   * Prisma types a Json column as JsonValue, which includes null and scalars,
   * so this accepts anything and the readers below narrow. That keeps callers
   * from having to cast a database row before it can be described.
   */
  payload: unknown;
}

const fields = (payload: unknown): Record<string, unknown> =>
  payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};

const num = (value: unknown): number | null => (typeof value === 'number' ? value : null);
const str = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value : null;

/** "card.drawn" → "card drawn", for an event this file has not been taught. */
const humanize = (type: string): string => type.replace(/[._]/g, ' ');

/** For the student's own feed, where the sentence has no name in front of it. */
export const sentenceCase = (text: string): string =>
  text.charAt(0).toUpperCase() + text.slice(1);

/**
 * The predicate only — no subject. Callers put "Aisha" or "You" in front, which
 * is why nothing here starts with a capital letter or names a person.
 */
export function describeActivity(row: ActivityRowLike): string {
  const payload = fields(row.payload);
  const card = str(payload.card_name);
  const note = str(payload.note);
  const suffix = note ? ` — ${note}` : '';

  switch (row.type) {
    case 'tokens.awarded':
      return `received ${num(payload.amount) ?? '?'} tokens${suffix}`;
    case 'tokens.adjusted': {
      const delta = num(payload.delta);
      if (delta === null) return `had their tokens adjusted${suffix}`;
      return delta >= 0
        ? `was given ${delta} tokens${suffix}`
        : `had ${Math.abs(delta)} tokens taken${suffix}`;
    }
    case 'tokens.undone':
      return `had an award undone (${num(payload.delta) ?? '?'} tokens)`;

    case 'card.drawn':
      return `drew ${card ?? 'a card'}`;
    case 'card.used':
      return `used ${card ?? 'a card'}${suffix}`;
    case 'card.returned':
      return `returned ${card ?? 'a card'} to the deck`;
    case 'card.traded': {
      const gave = Array.isArray(payload.gave_up)
        ? payload.gave_up.filter((value): value is string => typeof value === 'string')
        : [];
      const got = `traded up to ${card ?? 'a card'}`;
      return gave.length > 0 ? `${got}, giving up ${gave.join(', ')}` : got;
    }

    case 'enrollment.added':
      return 'joined the room';
    case 'enrollment.removed':
      return 'was removed from the room';

    case 'pool.reset':
      return 'deck was reset';
    case 'pool.updated':
      return 'deck was changed';
    case 'pool.low':
      return `deck ran low (${num(payload.in_deck) ?? '?'} left)`;
    case 'pool.empty':
      return 'deck ran empty';

    case 'room.created':
      return 'room was created';
    case 'room.archived':
      return 'room was archived';
    case 'room.settings_changed':
      return 'room settings changed';

    default:
      return humanize(row.type);
  }
}

/**
 * How a ledger row is labelled when it has no note of its own.
 *
 * `draw_spend` used to fall through to "Adjusted", which is both wrong and
 * confusing next to a real educator adjustment — a student who spent tokens on
 * a lootbox has not been adjusted by anyone.
 */
export function describeTokenReason(reason: string, cardName?: string | null): string {
  switch (reason) {
    case 'educator_award':
      return 'Awarded';
    case 'educator_adjustment':
      return 'Adjusted';
    case 'draw_spend':
      return cardName ? `Card — ${cardName}` : 'Card';
    case 'draw_refund':
      return 'Refunded';
    case 'system_correction':
      return 'Correction';
    default:
      return humanize(reason);
  }
}
