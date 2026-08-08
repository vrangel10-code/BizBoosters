import { importRosterSchema } from '@/lib/validation';
import { requireAuth, requireSchoolScope } from '@/server/auth/guard';
import { requireRoomEducator } from '@/server/auth/room-guard';
import { importRoster } from '@/server/services/roster';
import { clientIp, created, handle, parseBody } from '@/server/http';

export const dynamic = 'force-dynamic';

/**
 * Returns every generated credential exactly once, for printing or pasting into
 * a mail merge. There is no way to read them back afterwards — only the hashes
 * are stored — so the response is the moment that matters.
 */
export const POST = handle(
  async (request: Request, context: { params: Promise<{ roomId: string }> }) => {
    const { user } = await requireAuth({ roles: ['educator', 'school_admin', 'super_admin'] });
    const schoolId = requireSchoolScope(user);
    const { roomId } = await context.params;
    await requireRoomEducator(user, roomId);

    const body = await parseBody(request, importRosterSchema);

    const result = await importRoster({
      actor: user,
      schoolId,
      roomId,
      csv: body.csv,
      ip: clientIp(request),
    });

    return created({
      created: result.created.map((row) => ({
        id: row.userId,
        enrollment_id: row.enrollmentId,
        display_name: row.displayName,
        login_id: row.loginId,
        default_password: row.defaultPassword,
      })),
      skipped: result.skipped,
      note: 'Passwords are shown once. Print or save them before leaving this page.',
    });
  },
);
