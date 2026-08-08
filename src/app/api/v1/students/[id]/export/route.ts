import { requireEducator } from '@/server/auth/guard';
import { exportStudentData } from '@/server/services/exports';
import { recordAudit } from '@/server/services/audit';
import { prisma } from '@/server/db';
import { apiError } from '@/server/errors';
import { clientIp, handle } from '@/server/http';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * Everything held about one student, for a subject-access request. Downloading
 * it is itself an action on a child's data, so it is audited.
 */
export const GET = handle(
  async (request: Request, context: { params: Promise<{ id: string }> }) => {
    const { user } = await requireEducator();
    const { id } = await context.params;

    const student = await prisma.user.findUnique({ where: { id } });
    if (!student || student.role !== 'student' || student.schoolId !== user.schoolId) {
      throw apiError('not_found', 'Not found.');
    }

    const data = await exportStudentData(id);
    await recordAudit({
      action: 'data.exported',
      actorUserId: user.id,
      targetUserId: id,
      ip: clientIp(request),
    });

    const filename = `${student.displayName.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-data.json`;
    return new NextResponse(JSON.stringify(data, null, 2), {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="${filename}"`,
      },
    });
  },
);
