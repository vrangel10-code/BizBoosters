/**
 * Whether this deployment can afford to hold a connection open.
 *
 * Server-sent events assume a process that lives for hours. A serverless
 * function lives for tens of seconds and is billed for every one of them, so
 * the same code that is free on a container costs a full function lifetime per
 * attempt — and the client reconnects, forever, for as long as a tab is open.
 * Measured on a real deployment: ~1,000 connections in a day, 7.5 GB-hours,
 * from a single tab nobody was looking at.
 *
 * So the default is **off wherever we can tell we are serverless**, rather than
 * on everywhere and switched off by whoever reads the deployment guide closely
 * enough. Getting this wrong costs money silently; getting it wrong in the
 * other direction costs a 30-second delay on a notification badge.
 *
 * `LIVE_UPDATES=on` forces it back on, for a container host that wants the
 * realtime behaviour and knows it can sustain it.
 */
export function streamingAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  const setting = env.LIVE_UPDATES?.trim().toLowerCase();
  if (setting === 'off') return false;
  if (setting === 'on') return true;

  // AWS_LAMBDA_FUNCTION_NAME is set by Lambda itself, which is what Netlify,
  // Vercel and Amplify functions run on. NETLIFY covers Netlify's own build and
  // runtime. Either one means a platform that will cut this connection.
  const serverless = Boolean(env.AWS_LAMBDA_FUNCTION_NAME || env.NETLIFY || env.VERCEL);
  return !serverless;
}
