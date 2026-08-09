/**
 * Nightly housekeeping, 04:00 UTC. See cron-reconcile.mjs for why the schedule
 * lives in code rather than in a dashboard.
 *
 * This one sweeps expired sessions and rate-limit windows, and *reports* rooms
 * past their retention window. It never erases a room on its own — that stays a
 * decision a human makes, so a quiet scheduled job cannot delete a term of
 * student work.
 */
const retention = async () => {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error('CRON_SECRET is not set; skipping retention sweep.');
    return new Response('CRON_SECRET is not set.', { status: 500 });
  }

  const origin = (process.env.APP_URL ?? process.env.URL ?? '').replace(/\/+$/, '');
  if (!origin) {
    console.error('Neither APP_URL nor URL is set; cannot find the app.');
    return new Response('No app URL configured.', { status: 500 });
  }

  const response = await fetch(`${origin}/api/v1/cron/retention`, {
    headers: { authorization: `Bearer ${secret}` },
  });
  const body = await response.text();

  if (!response.ok) {
    console.error(`Retention sweep failed (${response.status}): ${body}`);
    return new Response(body, { status: 500 });
  }

  console.info(`Retention sweep: ${body}`);
  return new Response(body, { status: 200 });
};

export default retention;

export const config = { schedule: '0 4 * * *' };
