import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import type { User, UserRole } from '@prisma/client';
import { prisma } from '../db';

export const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME ?? 'bb_session';

/**
 * Student devices are shared — a Chromebook cart, a classroom desktop — so a
 * student session dies far sooner than an educator's, and neither offers
 * "remember me".
 */
const SESSION_TTL_MS: Record<UserRole, number> = {
  student: 2 * 60 * 60 * 1000, // 2 hours
  educator: 12 * 60 * 60 * 1000, // 12 hours
  school_admin: 12 * 60 * 60 * 1000,
  super_admin: 12 * 60 * 60 * 1000,
};

/** Only extend a rolling session once it is 10% through its window. */
const REFRESH_AFTER_FRACTION = 0.1;

export const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

const constantTimeEquals = (a: string, b: string): boolean => {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
};

export interface CreateSessionOptions {
  userId: string;
  role: UserRole;
  userAgent?: string | null;
  ip?: string | null;
}

/**
 * Returns the raw token exactly once. Only its SHA-256 hash is stored, so a
 * database leak does not hand out live sessions.
 */
export async function createSession({
  userId,
  role,
  userAgent,
  ip,
}: CreateSessionOptions): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS[role]);

  await prisma.session.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      expiresAt,
      userAgent: userAgent?.slice(0, 500) ?? null,
      ip: ip ?? null,
    },
  });

  return { token, expiresAt };
}

export interface ResolvedSession {
  sessionId: string;
  user: User;
}

/**
 * Resolves the cookie to a live session, sliding its expiry forward on
 * activity. Returns null for absent, unknown, revoked, expired, or
 * deactivated-user sessions — the caller cannot tell these apart, and should
 * not be able to.
 */
export async function resolveSession(token: string | undefined): Promise<ResolvedSession | null> {
  if (!token) return null;

  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });

  if (!session) return null;
  if (!constantTimeEquals(session.tokenHash, hashToken(token))) return null;
  if (session.revokedAt) return null;
  if (session.expiresAt.getTime() <= Date.now()) return null;
  if (!session.user.isActive) return null;

  const ttl = SESSION_TTL_MS[session.user.role];
  const elapsed = Date.now() - session.lastUsedAt.getTime();
  if (elapsed > ttl * REFRESH_AFTER_FRACTION) {
    await prisma.session.update({
      where: { id: session.id },
      data: { lastUsedAt: new Date(), expiresAt: new Date(Date.now() + ttl) },
    });
  }

  return { sessionId: session.id, user: session.user };
}

export async function revokeSession(sessionId: string): Promise<void> {
  await prisma.session.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/**
 * Used on password change and educator-initiated reset: any session opened on
 * another device stops working immediately.
 */
export async function revokeAllSessionsForUser(
  userId: string,
  options: { exceptSessionId?: string } = {},
): Promise<number> {
  const { count } = await prisma.session.updateMany({
    where: {
      userId,
      revokedAt: null,
      ...(options.exceptSessionId ? { id: { not: options.exceptSessionId } } : {}),
    },
    data: { revokedAt: new Date() },
  });
  return count;
}

export async function setSessionCookie(token: string, expiresAt: Date): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
}

export async function readSessionCookie(): Promise<string | undefined> {
  const store = await cookies();
  return store.get(SESSION_COOKIE)?.value;
}
