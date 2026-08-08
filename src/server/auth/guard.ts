import type { User, UserRole } from '@prisma/client';
import { apiError } from '../errors';
import { readSessionCookie, resolveSession } from './session';

export interface AuthContext {
  sessionId: string;
  user: User;
}

export interface RequireAuthOptions {
  roles?: UserRole[];
  /**
   * Set only on the handful of routes that must stay reachable while a first
   * login is pending: change-password, logout, and /auth/me.
   */
  allowPasswordChangePending?: boolean;
}

/**
 * The single authentication and authorization entry point for every route.
 *
 * The password-change gate lives here rather than in the UI on purpose: a
 * student who skips the change-password screen by typing a URL, or who calls
 * the API directly, still cannot reach anything until the default password is
 * gone.
 */
export async function requireAuth(options: RequireAuthOptions = {}): Promise<AuthContext> {
  const token = await readSessionCookie();
  const session = await resolveSession(token);

  if (!session) {
    throw apiError('unauthenticated', 'You are not signed in.');
  }

  const { user } = session;

  if (!user.isActive) {
    throw apiError('account_inactive', 'This account has been deactivated.');
  }

  if (user.mustChangePassword && !options.allowPasswordChangePending) {
    throw apiError('password_change_required', 'You must set a new password before continuing.');
  }

  if (options.roles && !options.roles.includes(user.role)) {
    throw apiError('forbidden', 'You do not have access to this.');
  }

  return { sessionId: session.sessionId, user };
}

export const requireEducator = () =>
  requireAuth({ roles: ['educator', 'school_admin', 'super_admin'] });

export const requireAdmin = () => requireAuth({ roles: ['school_admin', 'super_admin'] });

export const requireStudent = () => requireAuth({ roles: ['student'] });

/**
 * Every actor except a super_admin is confined to their own school. Returns the
 * school the caller may act within.
 */
export function requireSchoolScope(user: User, targetSchoolId?: string | null): string {
  if (user.role === 'super_admin') {
    const scope = targetSchoolId ?? user.schoolId;
    if (!scope) throw apiError('validation_failed', 'A school must be specified.');
    return scope;
  }

  if (!user.schoolId) {
    throw apiError('forbidden', 'This account is not attached to a school.');
  }
  if (targetSchoolId && targetSchoolId !== user.schoolId) {
    // 404 rather than 403: do not confirm that another school's record exists.
    throw apiError('not_found', 'Not found.');
  }
  return user.schoolId;
}
