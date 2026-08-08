import { requireEducator } from '@/server/auth/guard';
import { archiveCard } from '@/server/services/cards';
import { handle, json } from '@/server/http';

export const dynamic = 'force-dynamic';

/** Hides the card from new decks; decks already using it are unaffected. */
export const POST = handle(
  async (_request: Request, context: { params: Promise<{ id: string }> }) => {
    const { user } = await requireEducator();
    const { id } = await context.params;

    await archiveCard(user, id);
    return json({ ok: true });
  },
);
