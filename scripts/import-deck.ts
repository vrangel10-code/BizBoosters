/**
 * Imports a deck definition (seed/prototype-deck.json) into a school's card
 * catalog, and optionally builds a room's deck from it.
 *
 *   pnpm deck:import --school <school-id> [--room <room-id>] [--file seed/prototype-deck.json]
 *
 * Images come from `seed/images/<ref>.<ext>` when present, otherwise they are
 * downloaded from each card's `source_url`. Local files are the reliable route:
 * Google Drive throttles, blocks hotlinking unpredictably, and requires the
 * file to be publicly shared. Download failures are reported per card and never
 * abort the import — the deck is still usable, and art can be added later from
 * the card page.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { PrismaClient, type RarityCode } from '@prisma/client';
import { processCardImage } from '../src/server/services/card-images';
import { ensureRoomRarities } from '../src/server/services/decks';

const prisma = new PrismaClient();

interface DeckFile {
  deck?: { name?: string };
  cards: {
    ref: string;
    rarity: RarityCode;
    copies: number;
    name: string;
    effect_text: string | null;
    source_url: string | null;
  }[];
}

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token?.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[token.slice(2)] = next;
      i += 1;
    } else {
      args[token.slice(2)] = 'true';
    }
  }
  return args;
}

/** `https://drive.google.com/file/d/<id>/view` → a direct-download URL. */
function directDownloadUrl(url: string): string {
  const match = url.match(/(?:\/file\/d\/|[?&]id=)([a-zA-Z0-9_-]+)/);
  return match?.[1]
    ? `https://drive.usercontent.google.com/download?id=${match[1]}&export=download`
    : url;
}

/**
 * Finds the source art for a card in `seed/images/`.
 *
 * Matching is forgiving on purpose: whoever exports the art is far more likely
 * to save "DJ for the Day.png" than "C1.png", and being strict here just makes
 * the import silently skip everything. A file matches if its name, ignoring
 * case, punctuation and extension, equals either the card's `ref` or its name.
 */
const normalizeFileStem = (value: string): string =>
  value
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

async function findLocalImage(ref: string, cardName: string): Promise<Buffer | null> {
  const dir = join(process.cwd(), 'seed', 'images');
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }

  const wanted = new Set([normalizeFileStem(ref), normalizeFileStem(cardName)]);
  const match = entries.find(
    (name) => !name.startsWith('.') && wanted.has(normalizeFileStem(name)),
  );
  return match ? readFile(join(dir, match)) : null;
}

async function fetchImage(sourceUrl: string): Promise<Buffer> {
  const response = await fetch(directDownloadUrl(sourceUrl), {
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const buffer = Buffer.from(await response.arrayBuffer());
  // Drive answers an un-shared file with an HTML interstitial and a 200, so the
  // status code alone is not enough to know an image arrived.
  if (buffer.subarray(0, 200).toString('utf8').trimStart().toLowerCase().startsWith('<!doctype')) {
    throw new Error('received an HTML page, not an image — is the file shared publicly?');
  }
  return buffer;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const file = args.file ?? 'seed/prototype-deck.json';
  const schoolId = args.school;
  const roomId = args.room;
  const skipImages = args['skip-images'] === 'true';

  if (!schoolId) throw new Error('--school <school-id> is required. Find it with `pnpm db:studio`.');

  const school = await prisma.school.findUnique({ where: { id: schoolId } });
  if (!school) throw new Error(`No school with id ${schoolId}.`);

  const admin = await prisma.user.findFirst({
    where: { schoolId, role: { in: ['school_admin', 'educator'] } },
    orderBy: { createdAt: 'asc' },
  });
  if (!admin) throw new Error('That school has no educator to attribute the cards to.');

  const deckFile = JSON.parse(await readFile(file, 'utf8')) as DeckFile;

  const unnamed = deckFile.cards.filter((card) => !card.name?.trim());
  if (unnamed.length > 0) {
    throw new Error(
      `${unnamed.length} card(s) have no name (${unnamed
        .map((c) => c.ref)
        .join(', ')}). Names drive the activity log — fill them in first. See seed/README.md.`,
    );
  }

  const imported: { cardId: string; copies: number }[] = [];
  const imageFailures: { ref: string; name: string; reason: string }[] = [];

  for (const entry of deckFile.cards) {
    const card = await prisma.card.upsert({
      where: { schoolId_name: { schoolId, name: entry.name } },
      create: {
        schoolId,
        name: entry.name,
        rarity: entry.rarity,
        effectText: entry.effect_text,
        sourceUrl: entry.source_url,
        createdBy: admin.id,
      },
      update: { effectText: entry.effect_text, sourceUrl: entry.source_url },
    });

    imported.push({ cardId: card.id, copies: entry.copies });

    if (skipImages || card.imageKey) continue;

    try {
      const local = await findLocalImage(entry.ref, entry.name);
      const bytes = local ?? (entry.source_url ? await fetchImage(entry.source_url) : null);
      if (!bytes) {
          imageFailures.push({
          ref: entry.ref,
          name: entry.name,
          reason: `no file in seed/images/ matching "${entry.ref}" or "${entry.name}"`,
        });
        continue;
      }
      const processed = await processCardImage(card.id, bytes);
      await prisma.card.update({ where: { id: card.id }, data: { imageKey: processed.keyStem } });
      console.info(`  ✓ ${entry.ref.padEnd(4)} ${entry.name} ${local ? '(local)' : '(downloaded)'}`);
    } catch (error) {
      imageFailures.push({
        ref: entry.ref,
        name: entry.name,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  console.info(`\nImported ${imported.length} cards into ${school.name}.`);

  if (roomId) {
    const room = await prisma.room.findUnique({ where: { id: roomId } });
    if (!room || room.schoolId !== schoolId) throw new Error(`No room ${roomId} in that school.`);

    await ensureRoomRarities(room.id);

    for (const entry of imported) {
      await prisma.roomCard.upsert({
        where: { roomId_cardId: { roomId: room.id, cardId: entry.cardId } },
        create: {
          roomId: room.id,
          cardId: entry.cardId,
          copiesTotal: entry.copies,
          copiesRemaining: entry.copies,
        },
        // Adding copies is always safe; never assign remaining = total here,
        // which would mint copies out of students' hands (MECHANICS §3.1).
        update: {},
      });
    }

    const totals = await prisma.roomCard.aggregate({
      where: { roomId: room.id },
      _sum: { copiesTotal: true, copiesRemaining: true },
    });
    console.info(
      `Built the deck for "${room.name}": ${totals._sum.copiesTotal ?? 0} copies, ` +
        `${totals._sum.copiesRemaining ?? 0} in the deck.`,
    );
  }

  if (imageFailures.length > 0) {
    console.warn(`\n${imageFailures.length} image(s) could not be imported:`);
    for (const failure of imageFailures) {
      console.warn(`  ✗ ${failure.ref.padEnd(4)} ${failure.name} — ${failure.reason}`);
    }
    console.warn(
      '\nThe deck works without art. To add it, save each image in seed/images/ ' +
        'named after either the card (\'DJ for the Day.png\') or its ref (\'C1.png\'), ' +
        'then re-run. Or upload it from the card catalog page in the app.',
    );
  }
}

main()
  .catch((error: unknown) => {
    console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
