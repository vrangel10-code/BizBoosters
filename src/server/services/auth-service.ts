import type { User } from '@prisma/client';
import { prisma } from '../db';
import { apiError } from '../errors';
import { equalizeTiming, hashPassword, verifyPassword, assertPasswordAllowed } from '../auth/password';
import { looksLikeEmail, normalizeIdentifier } from '../auth/identifiers';
import { consumeRateLimit, enforceRateLimit, enforceRateLimitPeek } from '../auth/rate-limit';
import { createSession, revokeAllSessionsForUser } from '../auth/session';
import { recordAudit } from './audit';

/** Lock the account after this many consecutive failures. */
const MAX_FAILED_LOGINS = 10;
const LOCKOUT_MS = 15 * 60 * 1000;

export interface LoginInput {
  identifier: string;
  password: string;
  ip: string;
  userAgent?: string | null;
}

export interface LoginResult {
  user: User;
  token: string;
  expiresAt: Date;
}

async function findByIdentifier(identifier: string): Promise<User | null> {
  const normalized = normalizeIdentifier(identifier);
  return looksLikeEmail(normalized)
    ? prisma.user.findUnique({ where: { email: normalized } })
    : prisma.user.findUnique({ where: { loginId: normalized } });
}

export async function login({
  identifier,
  password,
  ip,
  userAgent,
}: LoginInput): Promise<LoginResult> {
  const normalized = normalizeIdentifier(identifier);

  // Three limits, each doing a different job.
  //
  // The volume limit counts every attempt and exists only to blunt a flood. It
  // is deliberately generous: a school sits behind one public IP, so a whole
  // year group signing in at the start of a lesson all looks like one address.
  // A tight limit here locks out real classes — which is exactly what happened
  // when 30 students hit a limit of 30.
  await enforceRateLimit({ key: `login:ip:${ip}`, limit: 600, windowMs: 5 * 60 * 1000 });

  // The two that matter count FAILURES only, checked before the password is
  // verified and incremented after it fails. Successful sign-ins are unbounded,
  // because a classroom full of them is the product working.
  const ipFailures = { key: `login:fail:ip:${ip}`, limit: 50, windowMs: 5 * 60 * 1000 };
  const idFailures = {
    key: `login:fail:id:${normalized}`,
    // Above MAX_FAILED_LOGINS on purpose: set it lower and lockout becomes
    // unreachable dead code, because the throttle would always fire first.
    limit: 20,
    windowMs: 5 * 60 * 1000,
  };

  await enforceRateLimitPeek(ipFailures);
  await enforceRateLimitPeek(idFailures);

  const user = await findByIdentifier(normalized);

  if (!user) {
    // Spend comparable CPU so a missing account is not detectably faster.
    await equalizeTiming(password);
    // No account to lock, so the failure counters are the only protection
    // against enumeration.
    await Promise.all([consumeRateLimit(ipFailures), consumeRateLimit(idFailures)]);
    throw apiError('invalid_credentials', 'That login ID or password is not correct.');
  }

  if (!user.isActive) {
    throw apiError('account_inactive', 'This account has been deactivated.');
  }

  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    throw apiError('account_locked', 'Too many failed attempts. Ask your teacher to unlock it.', {
      locked_until: user.lockedUntil.toISOString(),
    });
  }

  const ok = await verifyPassword(user.passwordHash, password);

  if (!ok) {
    await Promise.all([consumeRateLimit(ipFailures), consumeRateLimit(idFailures)]);
    const failedLoginCount = user.failedLoginCount + 1;
    const shouldLock = failedLoginCount >= MAX_FAILED_LOGINS;

    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount,
        lockedUntil: shouldLock ? new Date(Date.now() + LOCKOUT_MS) : user.lockedUntil,
      },
    });

    await recordAudit({
      action: shouldLock ? 'auth.account_locked' : 'auth.login_failed',
      targetUserId: user.id,
      payload: { failed_login_count: failedLoginCount },
      ip,
    });

    if (shouldLock) {
      throw apiError('account_locked', 'Too many failed attempts. Ask your teacher to unlock it.');
    }
    throw apiError('invalid_credentials', 'That login ID or password is not correct.');
  }

  const [, session] = await Promise.all([
    prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
    }),
    createSession({ userId: user.id, role: user.role, ip, userAgent }),
  ]);

  await recordAudit({ action: 'auth.login_succeeded', actorUserId: user.id, targetUserId: user.id, ip });

  return { user, token: session.token, expiresAt: session.expiresAt };
}

export interface ChangePasswordInput {
  user: User;
  currentPassword: string;
  newPassword: string;
  /** Kept alive so the user is not logged out by their own password change. */
  currentSessionId: string;
  ip: string;
}

export async function changePassword({
  user,
  currentPassword,
  newPassword,
  currentSessionId,
  ip,
}: ChangePasswordInput): Promise<void> {
  await enforceRateLimit({
    key: `password-change:${user.id}`,
    limit: 10,
    windowMs: 15 * 60 * 1000,
  });

  const ok = await verifyPassword(user.passwordHash, currentPassword);
  if (!ok) {
    throw apiError('invalid_credentials', 'Your current password is not correct.');
  }

  assertPasswordAllowed({
    password: newPassword,
    isStudent: user.role === 'student',
    forbidden: [currentPassword, user.loginId, user.email, user.displayName],
  });

  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash: await hashPassword(newPassword),
      mustChangePassword: false,
      failedLoginCount: 0,
      lockedUntil: null,
    },
  });

  // Everything else signs out: a shared classroom device left logged in is the
  // exact thing a password change is meant to fix.
  const revoked = await revokeAllSessionsForUser(user.id, { exceptSessionId: currentSessionId });

  await recordAudit({
    action: 'auth.password_changed',
    actorUserId: user.id,
    targetUserId: user.id,
    payload: { revoked_sessions: revoked },
    ip,
  });
}
