import { requireAuth } from '@/server/auth/guard';
import { handle, json } from '@/server/http';

export const dynamic = 'force-dynamic';

export const GET = handle(async (_request: Request) => {
  const { user } = await requireAuth({ allowPasswordChangePending: true });

  return json({
    user: {
      id: user.id,
      role: user.role,
      display_name: user.displayName,
      email: user.email,
      login_id: user.loginId,
      school_id: user.schoolId,
    },
    must_change_password: user.mustChangePassword,
    // Rooms and unread notification counts arrive in phases 1 and 4.
    rooms: [],
    unread_notifications: 0,
  });
});
