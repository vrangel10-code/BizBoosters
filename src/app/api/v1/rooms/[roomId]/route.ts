import { updateRoomSchema } from '@/lib/validation';
import { requireAuth } from '@/server/auth/guard';
import { requireRoomEducator, requireRoomEnrollment } from '@/server/auth/room-guard';
import { updateRoom } from '@/server/services/rooms';
import { handle, json, parseBody } from '@/server/http';

export const dynamic = 'force-dynamic';

export const GET = handle(
  async (_request: Request, context: { params: Promise<{ roomId: string }> }) => {
    const { user } = await requireAuth();
    const { roomId } = await context.params;

    if (user.role === 'student') {
      const { room, enrollment } = await requireRoomEnrollment(user, roomId);
      return json({
        room: {
          id: room.id,
          name: room.name,
          status: room.status,
          draw_cost_tokens: room.drawCostTokens,
          students_see_odds: room.studentsSeeOdds,
        },
        enrollment: {
          id: enrollment.id,
          token_balance: enrollment.tokenBalance,
          draws_affordable: Math.floor(enrollment.tokenBalance / room.drawCostTokens),
        },
      });
    }

    const { room } = await requireRoomEducator(user, roomId, { allowArchived: true });
    return json({
      room: {
        id: room.id,
        name: room.name,
        status: room.status,
        draw_cost_tokens: room.drawCostTokens,
        trades_enabled: room.tradesEnabled,
        trade_ratio: room.tradeRatio,
        students_see_odds: room.studentsSeeOdds,
        low_stock_threshold: room.lowStockThreshold,
        version: room.version,
        created_at: room.createdAt.toISOString(),
      },
    });
  },
);

export const PATCH = handle(
  async (request: Request, context: { params: Promise<{ roomId: string }> }) => {
    const { user } = await requireAuth({ roles: ['educator', 'school_admin', 'super_admin'] });
    const { roomId } = await context.params;
    const { room } = await requireRoomEducator(user, roomId);
    const body = await parseBody(request, updateRoomSchema);

    const updated = await updateRoom({
      actor: user,
      room,
      expectedVersion: body.expected_version,
      name: body.name,
      drawCostTokens: body.draw_cost_tokens,
      tradesEnabled: body.trades_enabled,
      tradeRatio: body.trade_ratio,
      studentsSeeOdds: body.students_see_odds,
      lowStockThreshold: body.low_stock_threshold,
    });

    return json({
      room: {
        id: updated.id,
        name: updated.name,
        draw_cost_tokens: updated.drawCostTokens,
        trades_enabled: updated.tradesEnabled,
        trade_ratio: updated.tradeRatio,
        students_see_odds: updated.studentsSeeOdds,
        low_stock_threshold: updated.lowStockThreshold,
        version: updated.version,
      },
    });
  },
);
