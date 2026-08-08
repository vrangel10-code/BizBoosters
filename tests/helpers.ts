import { PrismaClient } from '@prisma/client';
import type { School, User } from '@prisma/client';
import { hashPassword } from '../src/server/auth/password';
import { normalizeIdentifier } from '../src/server/auth/identifiers';

export const prisma = new PrismaClient();

/** Order matters: children before parents. */
export async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      activity_events, token_transactions, enrollments, room_educators, rooms,
      audit_log, sessions, educator_invitations, rate_limits, users, schools
    RESTART IDENTITY CASCADE
  `);
}

export async function createSchool(name = 'Northgate High'): Promise<School> {
  return prisma.school.create({ data: { name } });
}

export interface SeedUserOptions {
  schoolId: string;
  role: 'student' | 'educator' | 'school_admin' | 'super_admin';
  displayName?: string;
  email?: string;
  loginId?: string;
  password: string;
  mustChangePassword?: boolean;
  isActive?: boolean;
}

export async function seedUser(options: SeedUserOptions): Promise<User> {
  const isStudent = options.role === 'student';
  return prisma.user.create({
    data: {
      schoolId: options.schoolId,
      role: options.role,
      displayName: options.displayName ?? (isStudent ? 'Test Student' : 'Test Educator'),
      email: isStudent ? null : normalizeIdentifier(options.email ?? 'educator@example.edu'),
      loginId: isStudent ? normalizeIdentifier(options.loginId ?? 'apex-1234') : null,
      passwordHash: await hashPassword(options.password),
      mustChangePassword: options.mustChangePassword ?? false,
      isActive: options.isActive ?? true,
    },
  });
}

/**
 * next/headers' cookies() is only available inside a request scope, so service
 * tests exercise the services directly and cookie handling is covered by the
 * route-level assertions in auth-routes.test.ts.
 */
export const testIp = '203.0.113.10';
