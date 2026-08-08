import { requireEducator } from '@/server/auth/guard';
import { resetStudentPassword } from '@/server/services/students';
import { clientIp, handle, json } from '@/server/http';

export const dynamic = 'force-dynamic';

/** Two clicks in the UI. Students forget passwords weekly. */
export const POST = handle(
  async (request: Request, context: { params: Promise<{ id: string }> }) => {
    const { user } = await requireEducator();
    const { id } = await context.params;

    const credentials = await resetStudentPassword(user, id, clientIp(request));

    return json({
      credentials: {
        login_id: credentials.loginId,
        default_password: credentials.defaultPassword,
        note: 'Shown once. The student must change this at next login.',
      },
    });
  },
);
