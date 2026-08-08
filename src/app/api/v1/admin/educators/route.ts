import { requireAdmin, requireSchoolScope } from '@/server/auth/guard';
import { prisma } from '@/server/db';
import { handle, json } from '@/server/http';

export const dynamic = 'force-dynamic';

export const GET = handle(async (_request: Request) => {
  const { user } = await requireAdmin();
  const schoolId = requireSchoolScope(user);

  const educators = await prisma.user.findMany({
    where: { schoolId, role: { in: ['educator', 'school_admin'] } },
    orderBy: { displayName: 'asc' },
    select: {
      id: true,
      displayName: true,
      email: true,
      role: true,
      isActive: true,
      lastLoginAt: true,
      createdAt: true,
    },
  });

  return json({
    data: educators.map((educator) => ({
      id: educator.id,
      display_name: educator.displayName,
      email: educator.email,
      role: educator.role,
      is_active: educator.isActive,
      last_login_at: educator.lastLoginAt?.toISOString() ?? null,
    })),
  });
});
