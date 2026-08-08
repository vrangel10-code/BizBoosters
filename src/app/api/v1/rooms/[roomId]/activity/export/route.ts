import { requireAuth } from '@/server/auth/guard';
import { requireRoomEducator } from '@/server/auth/room-guard';
import { exportActivityCsv } from '@/server/services/exports';
import { handle } from '@/server/http';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export const GET = handle(
  async (request: Request, context: { params: Promise<{ roomId: string }> }) => {
    const { user } = await requireAuth({ roles: ['educator', 'school_admin', 'super_admin'] });
    const { roomId } = await context.params;
    const { room } = await requireRoomEducator(user, roomId, { allowArchived: true });

    const url = new URL(request.url);
    const csv = await exportActivityCsv({
      roomId,
      ...(url.searchParams.get('enrollment_id')
        ? { enrollmentId: url.searchParams.get('enrollment_id')! }
        : {}),
      ...(url.searchParams.get('type') ? { type: url.searchParams.get('type')! } : {}),
      ...(url.searchParams.get('from') ? { from: new Date(url.searchParams.get('from')!) } : {}),
      ...(url.searchParams.get('to') ? { to: new Date(url.searchParams.get('to')!) } : {}),
    });

    const filename = `${room.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-activity.csv`;
    return new NextResponse(csv, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${filename}"`,
      },
    });
  },
);
