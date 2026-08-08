import { requireAuth } from '@/server/auth/guard';
import { requireRoomEducator } from '@/server/auth/room-guard';
import { exportRosterCsv } from '@/server/services/exports';
import { handle } from '@/server/http';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/** The end-of-term summary: tokens earned, cards held and used, per student. */
export const GET = handle(
  async (_request: Request, context: { params: Promise<{ roomId: string }> }) => {
    const { user } = await requireAuth({ roles: ['educator', 'school_admin', 'super_admin'] });
    const { roomId } = await context.params;
    const { room } = await requireRoomEducator(user, roomId, { allowArchived: true });

    const csv = await exportRosterCsv(roomId);
    const filename = `${room.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-students.csv`;

    return new NextResponse(csv, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${filename}"`,
      },
    });
  },
);
