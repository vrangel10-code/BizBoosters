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
 * `maple-otter-473`. Two words plus three digits is ~26 bits, which is thin on
 * its own but is only ever a single-use credential: it is shown to the educator
 * once, forced to be changed at first login, and sits behind account lockout.
 * Readability matters more here — a teacher reads these aloud or off a slip.
 */
export function generateDefaultPassword(): string {
  return `${pickWord()}-${pickWord()}-${randomInt(100, 1000)}`;
}
