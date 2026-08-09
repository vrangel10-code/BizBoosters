import { describe, expect, it } from 'vitest';
import { diagnoseDatabaseError } from '../src/server/db-diagnosis';

/**
 * The error shapes below are the real ones, copied from what Prisma, Postgres
 * and Supavisor actually produce. Paraphrasing them would make this suite pass
 * while the classifier still misread production errors, which is the only thing
 * it is for.
 */
const prismaError = (code: string, message: string) =>
  Object.assign(new Error(message), { code });

describe('diagnoseDatabaseError', () => {
  it('spots a missing DATABASE_URL', () => {
    const { reason, hint } = diagnoseDatabaseError(
      new Error('error: Environment variable not found: DATABASE_URL.'),
    );
    expect(reason).toBe('not_configured');
    expect(hint).toContain('redeploy');
  });

  it('spots quotation marks left around the value', () => {
    const { reason } = diagnoseDatabaseError(
      new Error(
        'error: the URL must start with the protocol `postgresql://` or `postgres://`',
      ),
    );
    expect(reason).toBe('invalid_url');
  });

  it('spots a wrong password', () => {
    expect(diagnoseDatabaseError(prismaError('P1000', 'Authentication failed')).reason).toBe(
      'auth_failed',
    );
  });

  /**
   * The distinction that matters most here. Supavisor answers an unrecognised
   * pooler username with "Tenant or user not found", which reads like a
   * password problem and is not one — it means the username is missing the
   * project ref. Diagnosing it as auth_failed would send someone to reset a
   * password that was never wrong.
   */
  it('separates an unknown pooler tenant from a bad password', () => {
    const { reason, hint } = diagnoseDatabaseError(
      new Error('FATAL: Tenant or user not found'),
    );
    expect(reason).toBe('tenant_not_found');
    expect(hint).toContain('postgres.<project-ref>');
  });

  it('spots an unreachable or sleeping database', () => {
    expect(
      diagnoseDatabaseError(
        prismaError('P1001', "Can't reach database server at `db.example.supabase.co:5432`"),
      ).reason,
    ).toBe('unreachable');
  });

  it('spots the missing pgbouncer flag', () => {
    const { reason, hint } = diagnoseDatabaseError(
      new Error('ERROR: prepared statement "s0" already exists'),
    );
    expect(reason).toBe('pooler_mode_mismatch');
    expect(hint).toContain('pgbouncer=true');
  });

  it('spots migrations that were never run', () => {
    expect(
      diagnoseDatabaseError(
        prismaError('P2021', 'The table `public.users` does not exist in the current database.'),
      ).reason,
    ).toBe('schema_missing');
  });

  it('falls back to unknown rather than guessing', () => {
    expect(diagnoseDatabaseError(new Error('something nobody has seen before')).reason).toBe(
      'unknown',
    );
    expect(diagnoseDatabaseError('not even an error').reason).toBe('unknown');
  });

  /**
   * The safety property the whole design rests on: hints are constants, so a
   * driver that one day puts the connection string in its message cannot leak
   * it through an unauthenticated endpoint.
   */
  it('never echoes anything from the error into the hint', () => {
    const secret = 'postgresql://postgres.abcdef:hunter2@aws-0-x.pooler.supabase.com:6543/postgres';
    for (const error of [
      new Error(`Can't reach database server at ${secret}`),
      prismaError('P1000', `Authentication failed against ${secret}`),
      new Error(`Tenant or user not found for ${secret}`),
      new Error(secret),
    ]) {
      const { hint } = diagnoseDatabaseError(error);
      expect(hint).not.toContain('hunter2');
      expect(hint).not.toContain('abcdef');
      expect(hint).not.toContain('pooler.supabase.com');
    }
  });
});
