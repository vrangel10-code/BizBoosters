import type { User } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { apiError } from '../errors';
import { generateDefaultPassword, generateLoginId, normalizeIdentifier } from '../auth/identifiers';
import { hashPassword } from '../auth/password';
import { revokeAllSessionsForUser } from '../auth/session';
import { recordAudit } from './audit';

/**
 * Credentials are returned exactly once, at creation or reset, and never
 * retrievable afterwards — only the hash is stored. The educator prints or
 * copies them at that moment; if they lose them, the fix is a reset, not a
 * lookup.
 */
export interface StudentCredentials {
  userId: string;
  displayName: string;
  loginId: string;
  defaultPassword: string;
}

const isUniqueViolation = (error: unknown, target: string): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === 'P2002' &&
  String(error.meta?.target ?? '').includes(target);

export interface CreateStudentInput {
  actor: User;
  schoolId: string;
  displayName: string;
  /** Optional: a school's own student number. Generated when omitted. */
  loginId?: string | null;
  ip: string;
}

export async function createStudent({
  actor,
  schoolId,
  displayName,
  loginId,
  ip,
}: CreateStudentInput): Promise<StudentCredentials> {
  const name = displayName.trim();
  if (!name) throw apiError('validation_failed', 'A student name is required.');

  const defaultPassword = generateDefaultPassword();
  const passwordHash = await hashPassword(defaultPassword);

  const explicitLoginId = loginId ? normalizeIdentifier(loginId) : null;

  // Generated IDs carry a random suffix, so a collision just means trying
  // again. An explicitly supplied ID gets one attempt and a clear error.
  const attempts = explicitLoginId ? 1 : 5;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const candidate = explicitLoginId ?? normalizeIdentifier(generateLoginId(name));
    try {
      const student = await prisma.user.create({
        data: {
          schoolId,
          role: 'student',
          displayName: name,
          loginId: candidate,
          passwordHash,
          mustChangePassword: true,
        },
      });

      await recordAudit({
        action: 'student.created',
        actorUserId: actor.id,
        targetUserId: student.id,
        payload: { login_id: candidate },
        ip,
      });

      return {
        userId: student.id,
        displayName: student.displayName,
        loginId: candidate,
        defaultPassword,
      };
    } catch (error) {
      if (isUniqueViolation(error, 'login_id')) {
        if (explicitLoginId) {
          throw apiError('login_id_in_use', 'That login ID is already taken.');
        }
        continue;
      }
      throw error;
    }
  }

  throw apiError('login_id_in_use', 'Could not allocate a login ID. Please try again.');
}

/**
 * Students forget passwords constantly, so this is deliberately a single call:
 * generate a new default, force a change at next login, and sign out every
 * device currently holding the old one.
 */
export async function resetStudentPassword(
  actor: User,
  studentId: string,
  ip: string,
): Promise<StudentCredentials> {
  const student = await prisma.user.findUnique({ where: { id: studentId } });

  if (!student || student.role !== 'student' || student.schoolId !== actor.schoolId) {
    throw apiError('not_found', 'Not found.');
  }

  const defaultPassword = generateDefaultPassword();

  await prisma.user.update({
    where: { id: student.id },
    data: {
      passwordHash: await hashPassword(defaultPassword),
      mustChangePassword: true,
      failedLoginCount: 0,
      lockedUntil: null,
    },
  });

  const revoked = await revokeAllSessionsForUser(student.id);

  await recordAudit({
    action: 'student.password_reset',
    actorUserId: actor.id,
    targetUserId: student.id,
    payload: { revoked_sessions: revoked },
    ip,
  });

  return {
    userId: student.id,
    displayName: student.displayName,
    loginId: student.loginId ?? '',
    defaultPassword,
  };
}

export async function listStudents(schoolId: string) {
  return prisma.user.findMany({
    where: { schoolId, role: 'student' },
    orderBy: { displayName: 'asc' },
    select: {
      id: true,
      displayName: true,
      loginId: true,
      isActive: true,
      mustChangePassword: true,
      lockedUntil: true,
      lastLoginAt: true,
      createdAt: true,
    },
  });
}
