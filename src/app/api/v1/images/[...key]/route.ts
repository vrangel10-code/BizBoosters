import { getStorage } from '@/server/storage';

export const dynamic = 'force-dynamic';

/**
 * Serves card art when the storage driver has no public URL of its own (the
 * local filesystem driver used in development). With S3/R2 plus a CDN base URL
 * configured, `cardImageUrl` returns the CDN address and this route is never
 * hit.
 *
 * Deliberately unauthenticated: keys are content-hashed and unguessable, and
 * card art is not sensitive. Gating it behind a session would mean a signed-out
 * 404 for every image on a shared classroom screen.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ key: string[] }> },
): Promise<Response> {
  const { key } = await context.params;
  const object = await getStorage().get(key.join('/'));

  if (!object) return new Response('Not found', { status: 404 });

  return new Response(new Uint8Array(object.body), {
    headers: {
      'content-type': object.contentType,
      'cache-control': 'public, max-age=31536000, immutable',
    },
  });
}
