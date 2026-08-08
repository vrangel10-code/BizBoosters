import { createStudentSchema } from '@/lib/validation';
import { requireEducator, requireSchoolScope } from '@/server/auth/guard';
import { createStudent, listStudents } from '@/server/services/students';
import { clientIp, created, handle, json, parseBody } from '@/server/http';

export const dynamic = 'force-dynamic';

/**
 * Phase 0 keeps students at the school level so the first-login flow can be
 * exercised end to end. Phase 1 adds rooms and enrolments; roster management
 * moves under /rooms/:roomId/students then, and this stays as the school-wide
 * directory.
 */
export const GET = handle(async (_request: Request) => {
  const { user } = await requireEducator();
  const schoolId = requireSchoolScope(user);

  const students = await listStudents(schoolId);

  return json({
    data: students.map((student) => ({
      id: student.id,
      display_name: student.displayName,
      login_id: student.loginId,
      is_active: student.isActive,
      must_change_password: student.mustChangePassword,
      locked: Boolean(student.lockedUntil && student.lockedUntil.getTime() > Date.now()),
      last_login_at: student.lastLoginAt?.toISOString() ?? null,
    })),
  });
});

export const POST = handle(async (request: Request) => {
  const { user } = await requireEducator();
  const schoolId = requireSchoolScope(user);
  const body = await parseBody(request, createStudentSchema);

  const credentials = await createStudent({
    actor: user,
    schoolId,
    displayName: body.display_name,
    loginId: body.login_id ?? null,
    ip: clientIp(request),
  });

  // Shown once. There is no way to read the password back afterwards.
  return created({
    student: {
      id: credentials.userId,
      display_name: credentials.displayName,
      login_id: credentials.loginId,
    },
    credentials: {
      login_id: credentials.loginId,
      default_password: credentials.defaultPassword,
      note: 'Shown once. The student must change this at first login.',
    },
  });
});
