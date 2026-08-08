import { prisma } from '@/server/db';
import { handle, json } from '@/server/http';

export const dynamic = 'force-dynamic';

/** Liveness + database reachability, for the platform's health probe. */
export const GET = handle(async (_request: Request) => {
  await prisma.$queryRaw`SELECT 1`;
  return json({ status: 'ok', time: new Date().toISOString() });
});
