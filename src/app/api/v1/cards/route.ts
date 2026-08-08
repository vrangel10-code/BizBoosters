import { createCardSchema } from '@/lib/validation';
import { requireEducator, requireSchoolScope } from '@/server/auth/guard';
import { createCard, listCards } from '@/server/services/cards';
import { cardImageUrl } from '@/server/services/card-images';
import { created, handle, json, parseBody } from '@/server/http';

export const dynamic = 'force-dynamic';

/** The school-wide catalog. Cards are reusable across every room. */
export const GET = handle(async (request: Request) => {
  const { user } = await requireEducator();
  const schoolId = requireSchoolScope(user);
  const includeArchived = new URL(request.url).searchParams.get('include_archived') === 'true';

  return json({ data: await listCards(schoolId, { includeArchived }) });
});

export const POST = handle(async (request: Request) => {
  const { user } = await requireEducator();
  const schoolId = requireSchoolScope(user);
  const body = await parseBody(request, createCardSchema);

  const card = await createCard({
    actor: user,
    schoolId,
    name: body.name,
    rarity: body.rarity,
    effectText: body.effect_text ?? null,
    description: body.description ?? null,
  });

  return created({
    card: {
      id: card.id,
      name: card.name,
      rarity: card.rarity,
      effect_text: card.effectText,
      image_url: cardImageUrl(card.imageKey),
    },
  });
});
