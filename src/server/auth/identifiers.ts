import { randomInt } from 'node:crypto';

/**
 * Emails and student login IDs are stored lowercase and compared lowercase.
 * Every read and write funnels through here; a CHECK constraint in the
 * migration rejects non-lowercase values so a missed call fails loudly instead
 * of quietly creating a case-duplicate account.
 */
export const normalizeIdentifier = (value: string): string => value.trim().toLowerCase();

export const looksLikeEmail = (value: string): boolean => value.includes('@');

/** Short, unambiguous words for generated login IDs and default passwords. */
const WORDS = [
  'apex', 'amber', 'anchor', 'arrow', 'aspen', 'atlas', 'basil', 'beacon',
  'birch', 'bison', 'bloom', 'bolt', 'brave', 'brick', 'bridge', 'bronze',
  'cedar', 'chart', 'cliff', 'cobalt', 'comet', 'copper', 'coral', 'crane',
  'crest', 'delta', 'denim', 'draft', 'dune', 'eagle', 'ember', 'falcon',
  'fern', 'flint', 'forge', 'fox', 'garnet', 'glade', 'granite', 'harbor',
  'hawk', 'hazel', 'heron', 'indigo', 'iris', 'ivory', 'jade', 'jasper',
  'kite', 'lantern', 'ledger', 'lemon', 'lily', 'lotus', 'lumen', 'lynx',
  'maple', 'marble', 'meadow', 'mint', 'mosaic', 'nickel', 'nimbus', 'oak',
  'ocean', 'olive', 'onyx', 'opal', 'orbit', 'otter', 'palm', 'pearl',
  'pepper', 'pilot', 'pine', 'piper', 'plum', 'prism', 'quarry', 'quartz',
  'quill', 'raven', 'reef', 'ridge', 'river', 'rocket', 'rowan', 'ruby',
  'saffron', 'sage', 'sandy', 'sable', 'scout', 'shale', 'signal', 'silver',
  'slate', 'spark', 'spruce', 'stellar', 'stone', 'summit', 'sunset', 'swift',
  'talon', 'tandem', 'teak', 'tempo', 'thistle', 'tidal', 'timber', 'topaz',
  'trail', 'tulip', 'umber', 'valley', 'velvet', 'vertex', 'violet', 'walnut',
  'willow', 'wren', 'zephyr', 'zinc',
] as const;

const pickWord = (): string => WORDS[randomInt(WORDS.length)]!;

const slugify = (value: string): string =>
  value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 14)
    .replace(/-+$/g, '');

/**
 * `aisha-tan-4821`, falling back to `apex-4821` when a name slugifies to
 * nothing (non-Latin scripts, punctuation-only names). Callers retry on
 * collision — uniqueness is the database's job, not this function's.
 */
export function generateLoginId(displayName: string): string {
  const base = slugify(displayName) || pickWord();
  return `${base}-${randomInt(1000, 10_000)}`;
}

/**
 * The starting password every student account is created with.
 *
 * It used to be random per student (`maple-otter-473`). A shared, known value
 * is weaker, and the trade is deliberate: a teacher handing out thirty distinct
 * one-time passwords spends the first ten minutes of a lesson re-reading them
 * aloud, and every mistyped one moves a student closer to the ten-failure
 * lockout. One password the whole class can be told once removes that.
 *
 * What keeps it defensible:
 *  - it is only ever valid until first sign-in — the change is forced, and no
 *    other page is reachable until it is done;
 *  - the new password may not be this one, checked against the stored hash;
 *  - login IDs are per-student and not published, so knowing this is not on its
 *    own enough to reach an account;
 *  - lockout still applies.
 *
 * It is still a shared secret in a classroom, so it protects nothing after the
 * first lesson. Reset an account rather than assuming this is still current.
 */
export const DEFAULT_STUDENT_PASSWORD = 'Bizboosters123';

export function generateDefaultPassword(): string {
  return DEFAULT_STUDENT_PASSWORD;
}

/** Random and single-use — for the bootstrap admin, which no class shares. */
export function generateRandomPassword(): string {
  return `${pickWord()}-${pickWord()}-${randomInt(100, 1000)}`;
}
