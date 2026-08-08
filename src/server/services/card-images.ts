import sharp, { type Metadata } from 'sharp';
import { apiError } from '../errors';
import { getStorage, imageKey } from '../storage';

/**
 * Card art is stored in three sizes so a deck grid of 20 cards does not ship
 * three 800px images per row. The stored key on the card is the *stem*; the
 * variant suffix is appended when a URL is built, so one column addresses all
 * three.
 */
export const IMAGE_VARIANTS = {
  thumb: 160,
  card: 400,
  full: 800,
} as const;

export type ImageVariant = keyof typeof IMAGE_VARIANTS;

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/** The prototype's card aspect ratio: 160x220. */
const ASPECT = 220 / 160;

export interface ProcessedImage {
  /** Stored as `cards.image_key`; variants hang off it. */
  keyStem: string;
  bytes: number;
}

/**
 * Validates by decoding rather than by trusting the declared MIME type or the
 * file extension — a renamed file with an image/png header is still not an
 * image, and this is educator-supplied input.
 */
export async function processCardImage(
  cardId: string,
  input: Buffer,
  options: { declaredType?: string } = {},
): Promise<ProcessedImage> {
  if (input.byteLength === 0) {
    throw apiError('validation_failed', 'That file is empty.');
  }
  if (input.byteLength > MAX_UPLOAD_BYTES) {
    throw apiError('validation_failed', 'Card images must be 5 MB or smaller.', {
      max_bytes: MAX_UPLOAD_BYTES,
    });
  }

  let metadata: Metadata;
  try {
    metadata = await sharp(input).metadata();
  } catch {
    throw apiError('validation_failed', 'That file is not an image we can read.');
  }

  if (!metadata.format || !['png', 'jpeg', 'webp', 'gif', 'avif'].includes(metadata.format)) {
    throw apiError('validation_failed', 'Card images must be PNG, JPEG, WebP or AVIF.', {
      detected: metadata.format ?? options.declaredType ?? 'unknown',
    });
  }

  const storage = getStorage();
  const stem = imageKey(cardId, 'v', input, 'webp').replace(/\/v-([a-f0-9]+)\.webp$/, '/$1');

  for (const [variant, width] of Object.entries(IMAGE_VARIANTS)) {
    const resized = await sharp(input)
      .rotate() // honour EXIF orientation before cropping
      .resize({
        width,
        height: Math.round(width * ASPECT),
        fit: 'cover',
        position: 'attention',
      })
      .webp({ quality: 82 })
      .toBuffer();

    await storage.put(`${stem}/${variant}.webp`, resized, 'image/webp');
  }

  return { keyStem: stem, bytes: input.byteLength };
}

export function cardImageUrl(keyStem: string | null, variant: ImageVariant = 'card'): string | null {
  if (!keyStem) return null;
  const key = `${keyStem}/${variant}.webp`;
  return getStorage().publicUrl(key) ?? `/api/v1/images/${key}`;
}

export async function deleteCardImage(keyStem: string): Promise<void> {
  const storage = getStorage();
  await Promise.all(
    Object.keys(IMAGE_VARIANTS).map((variant) => storage.delete(`${keyStem}/${variant}.webp`)),
  );
}
