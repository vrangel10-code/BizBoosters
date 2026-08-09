/**
 * Nightly integrity check, 03:00 UTC.
 *
 * Netlify has no cron service, so the schedule lives here instead of in a
 * dashboard. The function does nothing itself: it calls the app's own
 * `/api/v1/cron/reconcile` route, which is where the logic and the shared
 * secret check live. Keeping it that way means the same endpoint can be driven
 * by Netlify, GitHub Actions or a laptop with `curl`, and the scheduler stays
 * a dumb trigger.
 *
 * A non-2xx return marks the invocation as failed in Netlify's function log,
 * which is what you want to alert on — the reconcile route answers 500 when
 * card copies or token balances stop adding up.
 */
const reconcile = async () => {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    // The route is disabled without a secret, so calling it would 404 forever.
    console.error('CRON_SECRET is not set; skipping reconciliation.');
    return new Response('CRON_SECRET is not set.', { status: 500 });
  }

  // APP_URL is the canonical origin (a custom domain, if you have one).
  // process.env.URL is Netlify's own primary URL, used when APP_URL is unset.
  const origin = (process.env.APP_URL ?? process.env.URL ?? '').replace(/\/+$/, '');
  if (!origin) {
    console.error('Neither APP_URL nor URL is set; cannot find the app.');
    return new Response('No app URL configured.', { status: 500 });
  }

  const response = await fetch(`${origin}/api/v1/cron/reconcile`, {
    headers: { authorization: `Bearer ${secret}` },
  });
  const body = await response.text();

  if (!response.ok) {
    console.error(`Reconciliation failed (${response.status}): ${body}`);
    return new Response(body, { status: 500 });
  }

  console.info(`Reconciliation clean: ${body}`);
  return new Response(body, { status: 200 });
};

export default reconcile;

export const config = { schedule: '0 3 * * *' };
