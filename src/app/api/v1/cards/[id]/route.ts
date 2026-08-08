import { updateCardSchema } from '@/lib/validation';
import { requireEducator } from '@/server/auth/guard';
import { updateCard } from '@/server/services/cards';
import { cardImageUrl } from '@/server/services/card-images';
import { handle, json, parseBody } from '@/server/http';

export const dynamic = 'force-dynamic';

export const PATCH = handle(
  async (request: Request, context: { params: Promise<{ id: string }> }) => {
    const { user } = await requireEducator();
    const { id } = await context.params;
    const body = await parseBody(request, updateCardSchema);

    const card = await updateCard({
      actor: user,
      cardId: id,
      name: body.name,
      rarity: body.rarity,
      effectText: body.effect_text,
      description: body.description,
    });

    return json({
      card: {
        id: card.id,
        name: card.name,
        rarity: card.rarity,
        effect_text: card.effectText,
        image_url: cardImageUrl(card.imageKey),
      },
    });
  },
);
