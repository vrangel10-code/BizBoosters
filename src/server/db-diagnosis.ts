/**
 * Turns a connection failure into a fixed, safe sentence.
 *
 * The health endpoint is the one place a misconfiguration should explain
 * itself: it is the first URL anyone opens after a deploy, and answering
 * "something went wrong, go read a log" makes the person setting this up dig
 * through a hosting dashboard to discover they pasted the wrong port.
 *
 * The rule that makes this safe is that nothing here is derived from the error
 * text. Each branch returns a constant written by hand, so a driver that one
 * day includes the connection string in its message cannot leak it through this
 * route. Matching reads the error; only the reason code and hint are returned.
 */
export type DatabaseFailure =
  | 'not_configured'
  | 'invalid_url'
  | 'auth_failed'
  | 'tenant_not_found'
  | 'unreachable'
  | 'pooler_mode_mismatch'
  | 'schema_missing'
  | 'unknown';

const HINTS: Record<DatabaseFailure, string> = {
  not_configured:
    'DATABASE_URL is not set on this deployment. Add it, then redeploy — environment variables only reach the site on the next build.',
  invalid_url:
    'DATABASE_URL is not a valid connection string. The usual cause is quotation marks around the value, which belong in a local .env file but not in a hosting dashboard.',
  auth_failed:
    'The database rejected the username or password. Check the password in DATABASE_URL, and note that a password containing symbols such as @ / ? # must be percent-encoded or changed to letters and numbers.',
  tenant_not_found:
    'The pooler did not recognise the username. With Supabase it must be postgres.<project-ref>, not plain postgres — copy the whole string from Connect rather than editing one you already had.',
  unreachable:
    'The database did not answer. On Supabase free tier the project pauses after a week of inactivity: open the dashboard to wake it. Otherwise check the host and port in DATABASE_URL.',
  pooler_mode_mismatch:
    'The connection works but the pooler is rejecting prepared statements. Add ?pgbouncer=true&connection_limit=1 to the end of DATABASE_URL — required when using the transaction pooler on port 6543.',
  schema_missing:
    'Connected, but the tables do not exist. Run `pnpm prisma migrate deploy` against this database — it is never run automatically.',
  unknown:
    'The database could not be queried. The full error is in the server log, recorded against this error_id.',
};

/**
 * Prisma reports some of these as codes and others only as text, and the text
 * differs between Postgres, PgBouncer and Supavisor. Codes are checked first
 * because they are stable; the string matches are the fallback for errors that
 * arrive before Prisma has classified them.
 */
export function diagnoseDatabaseError(error: unknown): {
  reason: DatabaseFailure;
  hint: string;
} {
  const code = typeof error === 'object' && error !== null && 'errorCode' in error
    ? String((error as { errorCode?: unknown }).errorCode ?? '')
    : '';
  const prismaCode = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : '';
  const text = (error instanceof Error ? error.message : String(error)).toLowerCase();

  const reason = ((): DatabaseFailure => {
    if (text.includes('environment variable not found') || prismaCode === 'P1012') {
      return 'not_configured';
    }
    if (
      text.includes('must start with the protocol') ||
      text.includes('invalid connection string') ||
      prismaCode === 'P1013'
    ) {
      return 'invalid_url';
    }
    // Supavisor answers an unknown pooler username this way, and it is not an
    // authentication failure — telling someone to check their password here
    // sends them to the wrong place entirely.
    if (text.includes('tenant or user not found')) return 'tenant_not_found';
    if (prismaCode === 'P1000' || text.includes('authentication failed')) return 'auth_failed';
    if (
      prismaCode === 'P1001' ||
      prismaCode === 'P1002' ||
      text.includes("can't reach database server") ||
      text.includes('timed out')
    ) {
      return 'unreachable';
    }
    if (text.includes('prepared statement') || code === '42P05' || code === '26000') {
      return 'pooler_mode_mismatch';
    }
    if (
      prismaCode === 'P2021' ||
      prismaCode === 'P2022' ||
      code === '42P01' ||
      text.includes('does not exist in the current database')
    ) {
      return 'schema_missing';
    }
    return 'unknown';
  })();

  return { reason, hint: HINTS[reason] };
}
