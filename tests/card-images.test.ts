import { beforeEach, afterAll, afterEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import type { School, User } from '@prisma/client';
import { prisma, resetDatabase, createSchool, seedUser } from './helpers';
import { createCard, setCardImage } from '../src/server/services/cards';
import { cardImageUrl, IMAGE_VARIANTS, processCardImage } from '../src/server/services/card-images';
import { MemoryStorage, setStorage } from '../src/server/storage';
import { ApiError } from '../src/server/errors';

let school: School;
let educator: User;
let storage: MemoryStorage;

const expectApiError = async (promise: Promise<unknown>, code: string) => {
  await expect(promise).rejects.toSatisfy(
    (error: unknown) => error instanceof ApiError && error.code === code,
    `expected ApiError with code "${code}"`,
  );
};

const pngOf = (width: number, height: number, colour = { r: 60, g: 90, b: 200 }) =>
  sharp({
    create: { width, height, channels: 3, background: colour },
  })
    .png()
    .toBuffer();

beforeEach(async () => {
  await resetDatabase();
  storage = new MemoryStorage();
  setStorage(storage);
  school = await createSchool();
  educator = await seedUser({
    schoolId: school.id,
    role: 'educator',
    email: 'sam@school.edu',
    password: 'correct-horse-battery',
  });
});

afterEach(() => setStorage(null));
afterAll(async () => {
  await prisma.$disconnect();
});

describe('processCardImage', () => {
  it('writes all three variants as webp', async () => {
    const result = await processCardImage('card-1', await pngOf(900, 1200));

    expect(storage.objects.size).toBe(3);
    for (const variant of Object.keys(IMAGE_VARIANTS)) {
      const stored = storage.objects.get(`${result.keyStem}/${variant}.webp`);
      expect(stored?.contentType).toBe('image/webp');
    }
  });

  it('resizes each variant to the card aspect ratio', async () => {
    const result = await processCardImage('card-1', await pngOf(900, 900));

    for (const [variant, width] of Object.entries(IMAGE_VARIANTS)) {
      const stored = storage.objects.get(`${result.keyStem}/${variant}.webp`)!;
      const meta = await sharp(stored.body).metadata();
      expect(meta.width).toBe(width);
      // The prototype's 160x220 card shape, so a square source is cropped
      // rather than letterboxed.
      expect(meta.height).toBe(Math.round(width * (220 / 160)));
    }
  });

  it('gives identical bytes the same key, so re-uploading does not duplicate', async () => {
    const image = await pngOf(400, 550);
    const first = await processCardImage('card-1', image);
    const second = await processCardImage('card-1', image);

    expect(second.keyStem).toBe(first.keyStem);
    expect(storage.objects.size).toBe(3);
  });

  it('gives different art different keys', async () => {
    const first = await processCardImage('card-1', await pngOf(400, 550, { r: 10, g: 10, b: 10 }));
    const second = await processCardImage('card-1', await pngOf(400, 550, { r: 250, g: 10, b: 10 }));

    expect(second.keyStem).not.toBe(first.keyStem);
  });

  it('rejects a file that is not an image, whatever it claims to be', async () => {
    // Validation is by decoding, not by trusting the declared MIME type — this
    // is educator-supplied input.
    await expectApiError(
      processCardImage('card-1', Buffer.from('#!/bin/sh\nrm -rf /\n'), {
        declaredType: 'image/png',
      }),
      'validation_failed',
    );
  });

  it('rejects an empty file', async () => {
    await expectApiError(processCardImage('card-1', Buffer.alloc(0)), 'validation_failed');
  });

  it('rejects a file over 5 MB', async () => {
    const oversized = Buffer.alloc(5 * 1024 * 1024 + 1, 1);
    await expectApiError(processCardImage('card-1', oversized), 'validation_failed');
  });
});

describe('setCardImage', () => {
  it('stores the key stem on the card and builds a servable URL', async () => {
    const card = await createCard({
      actor: educator,
      schoolId: school.id,
      name: 'Cashflow Boost',
      rarity: 'C',
    });

    const updated = await setCardImage(educator, card.id, await pngOf(600, 800), 'image/png');

    expect(updated.imageKey).toBeTruthy();
    // A key, never a URL: the bucket can move without a data migration.
    expect(updated.imageKey).not.toMatch(/^https?:/);
    expect(cardImageUrl(updated.imageKey)).toBe(`/api/v1/images/${updated.imageKey}/card.webp`);
  });

  it('deletes the previous art when art is replaced', async () => {
    const card = await createCard({
      actor: educator,
      schoolId: school.id,
      name: 'Cashflow Boost',
      rarity: 'C',
    });

    const first = await setCardImage(educator, card.id, await pngOf(600, 800, { r: 1, g: 1, b: 1 }));
    expect(storage.objects.size).toBe(3);

    const second = await setCardImage(
      educator,
      card.id,
      await pngOf(600, 800, { r: 250, g: 1, b: 1 }),
    );

    // Only the new art survives; the old objects are not left orphaned.
    expect(storage.objects.size).toBe(3);
    expect([...storage.objects.keys()].every((key) => key.startsWith(second.imageKey!))).toBe(true);
    expect(first.imageKey).not.toBe(second.imageKey);
  });

  it('refuses a card at another school', async () => {
    const other = await createSchool('Southgate High');
    const otherEducator = await seedUser({
      schoolId: other.id,
      role: 'educator',
      email: 'other@southgate.edu',
      password: 'correct-horse-battery',
    });
    const card = await createCard({
      actor: educator,
      schoolId: school.id,
      name: 'Cashflow Boost',
      rarity: 'C',
    });

    await expectApiError(
      setCardImage(otherEducator, card.id, await pngOf(400, 550)),
      'not_found',
    );
  });

  it('leaves the old art in place when the new upload is invalid', async () => {
    const card = await createCard({
      actor: educator,
      schoolId: school.id,
      name: 'Cashflow Boost',
      rarity: 'C',
    });
    const good = await setCardImage(educator, card.id, await pngOf(600, 800));

    await expectApiError(
      setCardImage(educator, card.id, Buffer.from('not an image')),
      'validation_failed',
    );

    const after = await prisma.card.findUniqueOrThrow({ where: { id: card.id } });
    expect(after.imageKey).toBe(good.imageKey);
    expect(storage.objects.size).toBe(3);
  });
});

describe('cardImageUrl', () => {
  it('returns null for a card with no art', () => {
    expect(cardImageUrl(null)).toBeNull();
  });

  it('addresses each variant off one stored stem', () => {
    expect(cardImageUrl('cards/x/abc', 'thumb')).toBe('/api/v1/images/cards/x/abc/thumb.webp');
    expect(cardImageUrl('cards/x/abc', 'full')).toBe('/api/v1/images/cards/x/abc/full.webp');
  });
});
