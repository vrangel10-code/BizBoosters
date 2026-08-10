import { describe, expect, it } from 'vitest';
import { streamingAllowed } from '../src/server/streaming';

const env = (values: Record<string, string | undefined>) =>
  values as unknown as NodeJS.ProcessEnv;

/**
 * The expensive default is "on", so these assert that it is off wherever the
 * platform will cut the connection — the case that silently billed 7.5
 * GB-hours in a day from one idle browser tab.
 */
describe('streamingAllowed', () => {
  it('is on for a plain long-lived server', () => {
    expect(streamingAllowed(env({}))).toBe(true);
  });

  it('is off on Lambda-backed hosts without anyone configuring it', () => {
    for (const values of [
      { AWS_LAMBDA_FUNCTION_NAME: 'some-fn' },
      { NETLIFY: 'true' },
      { VERCEL: '1' },
    ]) {
      expect(streamingAllowed(env(values))).toBe(false);
    }
  });

  it('honours an explicit off, even on a host that could sustain it', () => {
    expect(streamingAllowed(env({ LIVE_UPDATES: 'off' }))).toBe(false);
    expect(streamingAllowed(env({ LIVE_UPDATES: 'OFF ' }))).toBe(false);
  });

  it('honours an explicit on, overriding the serverless default', () => {
    expect(
      streamingAllowed(env({ LIVE_UPDATES: 'on', NETLIFY: 'true' })),
    ).toBe(true);
  });
});
