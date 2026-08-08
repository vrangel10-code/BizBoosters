import { createRoomSchema } from '@/lib/validation';
import { requireAuth, requireEducator, requireSchoolScope } from '@/server/auth/guard';
import { createRoom, listRoomsForEducator, listRoomsForStudent } from '@/server/services/rooms';
import { created, handle, json, parseBody } from '@/server/http';

export const dynamic = 'force-dynamic';

/**
 * Role-dependent: a student gets the rooms they are enrolled in with their own
 * balance in each; an educator gets the rooms they teach.
 */
export const GET = handle(async (_request: Request) => {
  const { user } = await requireAuth();

  if (user.role === 'student') {
    return json({ data: await listRoomsForStudent(user) });
  }
  return json({ data: await listRoomsForEducator(user) });
});

export const POST = handle(async (request: Request) => {
  const { user } = await requireEducator();
  const schoolId = requireSchoolScope(user);
  const body = await parseBody(request, createRoomSchema);

  const room = await createRoom({
    actor: user,
    schoolId,
    name: body.name,
    drawCostTokens: body.draw_cost_tokens,
  });

  return created({
    room: {
      id: room.id,
      name: room.name,
      status: room.status,
      draw_cost_tokens: room.drawCostTokens,
      version: room.version,
    },
  });
});
