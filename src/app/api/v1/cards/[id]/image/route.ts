import { requireEducator } from '@/server/auth/guard';
import { setCardImage } from '@/server/services/cards';
import { cardImageUrl } from '@/server/services/card-images';
import { apiError } from '@/server/errors';
import { handle, json } from '@/server/http';

export const dynamic = 'force-dynamic';

/**
 * Multipart upload. The file is validated by decoding it, not by trusting the
 * declared type — a renamed executable with an image/png header is not an
 * image, and this is educator-supplied input.
 */
export const POST = handle(
  async (request: Request, context: { params: Promise<{ id: string }> }) => {
    const { user } = await requireEducator();
    const { id } = await context.params;

    const form = await request.formData().catch(() => null);
    const file = form?.get('file');

    if (!file || typeof file === 'string') {
      throw apiError('validation_failed', 'Attach an image file as "file".');
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const card = await setCardImage(user, id, buffer, file.type);

    return json({ card: { id: card.id, image_url: cardImageUrl(card.imageKey) } });
  },
);
