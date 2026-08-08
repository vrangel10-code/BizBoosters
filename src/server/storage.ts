import { createHash } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/**
 * Card art lives behind this interface so the bucket can change without a data
 * migration: `cards.image_key` stores a key, never a URL.
 *
 * Two drivers. Local writes to disk and is served by an app route — fine for
 * development and for a single long-lived server, useless on serverless where
 * the filesystem is ephemeral. S3 covers Cloudflare R2, AWS S3 and anything
 * else speaking the same protocol, and is the production path.
 */
export interface StoredObject {
  body: Buffer;
  contentType: string;
}

export interface Storage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
  /** Public URL when the bucket serves one; null means "serve it yourself". */
  publicUrl(key: string): string | null;
}

class LocalStorage implements Storage {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private path(key: string): string {
    // Keys are generated internally, but a traversal here would let an upload
    // overwrite application files, so it is checked rather than assumed.
    const full = resolve(join(this.root, key));
    if (!full.startsWith(this.root)) throw new Error('Invalid storage key.');
    return full;
  }

  async put(key: string, body: Buffer): Promise<void> {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }

  async get(key: string): Promise<StoredObject | null> {
    try {
      const body = await readFile(this.path(key));
      return { body, contentType: contentTypeFor(key) };
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    await unlink(this.path(key)).catch(() => undefined);
  }

  publicUrl(): string | null {
    return null; // served by /api/v1/images/[...key]
  }
}

class S3Storage implements Storage {
  private readonly bucket: string;
  private readonly baseUrl: string | null;
  // Imported lazily so the SDK is not loaded when the local driver is in use.
  private clientPromise: Promise<import('@aws-sdk/client-s3').S3Client> | null = null;

  constructor(config: {
    bucket: string;
    region: string;
    endpoint?: string;
    accessKeyId: string;
    secretAccessKey: string;
    baseUrl?: string;
  }) {
    this.bucket = config.bucket;
    this.baseUrl = config.baseUrl?.replace(/\/+$/, '') ?? null;
    this.clientPromise = import('@aws-sdk/client-s3').then(
      ({ S3Client }) =>
        new S3Client({
          region: config.region,
          ...(config.endpoint ? { endpoint: config.endpoint, forcePathStyle: true } : {}),
          credentials: {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey,
          },
        }),
    );
  }

  private async client() {
    if (!this.clientPromise) throw new Error('S3 storage is not configured.');
    return this.clientPromise;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    const [client, { PutObjectCommand }] = await Promise.all([
      this.client(),
      import('@aws-sdk/client-s3'),
    ]);
    await client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        // Content-hashed keys, so a given key's bytes never change.
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );
  }

  async get(key: string): Promise<StoredObject | null> {
    const [client, { GetObjectCommand }] = await Promise.all([
      this.client(),
      import('@aws-sdk/client-s3'),
    ]);
    try {
      const result = await client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      const bytes = await result.Body?.transformToByteArray();
      if (!bytes) return null;
      return {
        body: Buffer.from(bytes),
        contentType: result.ContentType ?? contentTypeFor(key),
      };
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    const [client, { DeleteObjectCommand }] = await Promise.all([
      this.client(),
      import('@aws-sdk/client-s3'),
    ]);
    await client
      .send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }))
      .catch(() => undefined);
  }

  publicUrl(key: string): string | null {
    return this.baseUrl ? `${this.baseUrl}/${key}` : null;
  }
}

function contentTypeFor(key: string): string {
  if (key.endsWith('.png')) return 'image/png';
  if (key.endsWith('.jpg') || key.endsWith('.jpeg')) return 'image/jpeg';
  if (key.endsWith('.webp')) return 'image/webp';
  return 'application/octet-stream';
}

let storage: Storage | null = null;

export function getStorage(): Storage {
  if (storage) return storage;

  const bucket = process.env.S3_BUCKET;
  if (bucket) {
    storage = new S3Storage({
      bucket,
      region: process.env.S3_REGION ?? 'auto',
      ...(process.env.S3_ENDPOINT ? { endpoint: process.env.S3_ENDPOINT } : {}),
      accessKeyId: process.env.S3_ACCESS_KEY_ID ?? '',
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
      ...(process.env.S3_PUBLIC_BASE_URL ? { baseUrl: process.env.S3_PUBLIC_BASE_URL } : {}),
    });
  } else {
    storage = new LocalStorage(process.env.STORAGE_DIR ?? './storage');
  }
  return storage;
}

/** Tests swap in an in-memory driver. */
export function setStorage(next: Storage | null): void {
  storage = next;
}

export class MemoryStorage implements Storage {
  readonly objects = new Map<string, StoredObject>();

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    this.objects.set(key, { body, contentType });
  }
  async get(key: string): Promise<StoredObject | null> {
    return this.objects.get(key) ?? null;
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
  publicUrl(): string | null {
    return null;
  }
}

/**
 * Content-hashed so identical art uploaded twice occupies one object, and so a
 * key's bytes are immutable — which is what makes the year-long cache header
 * safe.
 */
export function imageKey(cardId: string, variant: string, body: Buffer, ext: string): string {
  const digest = createHash('sha256').update(body).digest('hex').slice(0, 16);
  return `cards/${cardId}/${variant}-${digest}.${ext}`;
}
