import { z } from 'zod';
import { requireAuth } from '@/server/auth/guard';
import { requireRoomEducator } from '@/server/auth/room-guard';
import { undoTokenTransaction } from '@/server/services/tokens';
import { handle, json, parseBody } from '@/server/http';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({ room_id: z.string().uuid() });

/**
 * The room comes from the body and is authorized before the transaction is
 * touched, so possession of a transaction ID alone grants nothing.
 */
export const POST = handle(
  async (request: Request, context: { params: Promise<{ id: string }> }) => {
    const { user } = await requireAuth({ roles: ['educator', 'school_admin', 'super_admin'] });
    const { id } = await context.params;
    const body = await parseBody(request, bodySchema);

    await requireRoomEducator(user, body.room_id);
    const result = await undoTokenTransaction(user, id, body.room_id);

    return json({ token_balance: result.balance });
  },
);
