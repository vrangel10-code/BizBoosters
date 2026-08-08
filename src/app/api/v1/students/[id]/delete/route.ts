import { z } from 'zod';
import { requireEducator } from '@/server/auth/guard';
import { deleteStudent, previewStudentDeletion } from '@/server/services/retention';
import { clientIp, handle, json, parseBody } from '@/server/http';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({ confirm: z.string().min(1) });

/** What erasing this student would destroy — shown before anything happens. */
export const GET = handle(
  async (_request: Request, context: { params: Promise<{ id: string }> }) => {
    const { user } = await requireEducator();
    const { id } = await context.params;
    return json({ preview: await previewStudentDeletion(user, id) });
  },
);

/**
 * Really deletes. The users are children, so erasure means erasure — not a
 * hidden flag that leaves the data in place.
 */
export const POST = handle(
  async (request: Request, context: { params: Promise<{ id: string }> }) => {
    const { user } = await requireEducator();
    const { id } = await context.params;
    const body = await parseBody(request, bodySchema);

    const deleted = await deleteStudent(user, id, body.confirm, clientIp(request));
    return json({ deleted });
  },
);
