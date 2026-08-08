import { execSync } from 'node:child_process';

/**
 * Tests run against a real Postgres database, never a mock. The whole point of
 * phase 3's draw transaction is behaviour that only a real database exhibits
 * (row locks, constraint violations, serialization), and building that habit
 * from phase 0 means the harness is already in place when it matters.
 */
export default function setup() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL must be set for tests (see .env.test).');
  if (!/test/i.test(url)) {
    throw new Error(
      `Refusing to run tests against "${url}" — the database name must contain "test".`,
    );
  }

  execSync('pnpm prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: url },
  });
}
