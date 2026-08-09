import { hash, verify } from '@node-rs/argon2';
import { apiError } from '../errors';

/**
 * OWASP's recommended Argon2id baseline: 19 MiB memory, 2 iterations,
 * parallelism 1. Memory cost is the parameter that actually resists GPU
 * cracking, so it is the one not to trim.
 */
const ARGON2_OPTIONS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export const hashPassword = (plain: string): Promise<string> => hash(plain, ARGON2_OPTIONS);

export const verifyPassword = (digest: string, plain: string): Promise<boolean> =>
  verify(digest, plain, ARGON2_OPTIONS).catch(() => false);

/**
 * Burn roughly the same CPU as a real verification when the account does not
 * exist, so response timing does not disclose which login IDs are real.
 * Computed once at module load, not per request.
 */
const DUMMY_HASH_PROMISE = hashPassword('bizboosters-timing-equalizer');
export const equalizeTiming = async (plain: string): Promise<void> => {
  await verifyPassword(await DUMMY_HASH_PROMISE, plain);
};

const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', '12345678', '123456789', '1234567890',
  'qwertyuiop', 'iloveyou', 'letmein1', 'welcome1', 'abc12345', 'football1',
  'bizboosters', 'bizboosters1', 'changeme', 'changeme1', 'students', 'teacher1',
]);

/**
 * Eight characters for everyone, which is the NIST SP 800-63B floor for a
 * user-chosen secret. The educator minimum was 10 — my own conservatism rather
 * than a standard — and an arbitrary extra two characters buys far less than
 * the blocklist and the account lockout that back it up.
 */
export const MIN_PASSWORD_LENGTH = { student: 8, educator: 8 } as const;

export interface PasswordPolicyInput {
  password: string;
  isStudent: boolean;
  /** Values the new password must not equal: the default password, login ID, email. */
  forbidden?: (string | null | undefined)[];
}

/**
 * Deliberately minimal. Complexity rules ("one uppercase, one symbol") applied
 * to twelve-year-olds produce passwords written on sticky notes, which is a
 * worse outcome than a slightly shorter password behind account lockout.
 */
export function assertPasswordAllowed({
  password,
  isStudent,
  forbidden = [],
}: PasswordPolicyInput): void {
  const min = isStudent ? MIN_PASSWORD_LENGTH.student : MIN_PASSWORD_LENGTH.educator;

  if (password.length < min) {
    throw apiError('weak_password', `Password must be at least ${min} characters.`, {
      min_length: min,
    });
  }
  if (password.length > 200) {
    throw apiError('weak_password', 'Password must be 200 characters or fewer.');
  }

  const normalized = password.trim().toLowerCase();
  if (COMMON_PASSWORDS.has(normalized)) {
    throw apiError('weak_password', 'That password is too easy to guess. Pick another.');
  }

  for (const value of forbidden) {
    if (value && normalized === value.trim().toLowerCase()) {
      throw apiError(
        'weak_password',
        'Your new password must be different from your old one and from your login ID.',
      );
    }
  }
}
