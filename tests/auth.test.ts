import { beforeEach, afterAll, describe, expect, it } from 'vitest';
import type { School } from '@prisma/client';
import { prisma, resetDatabase, createSchool, seedUser, testIp } from './helpers';
import { login, changePassword } from '../src/server/services/auth-service';
import { resolveSession, revokeAllSessionsForUser, hashToken } from '../src/server/auth/session';
import { ApiError } from '../src/server/errors';

let school: School;

beforeEach(async () => {
  await resetDatabase();
  school = await createSchool();
});

afterAll(async () => {
  await prisma.$disconnect();
});

const expectApiError = async (promise: Promise<unknown>, code: string) => {
  await expect(promise).rejects.toSatisfy(
    (error: unknown) => error instanceof ApiError && error.code === code,
    `expected ApiError with code "${code}"`,
  );
};

describe('login', () => {
  it('signs a student in by login ID', async () => {
    await seedUser({ schoolId: school.id, role: 'student', loginId: 'apex-4821', password: 'maple-otter-473' });

    const result = await login({ identifier: 'apex-4821', password: 'maple-otter-473', ip: testIp });

    expect(result.user.role).toBe('student');
    expect(result.token).toBeTruthy();
  });

  it('signs an educator in by email', async () => {
    await seedUser({
      schoolId: school.id,
      role: 'educator',
      email: 'sam@school.edu',
      password: 'correct-horse-battery',
    });

    const result = await login({
      identifier: 'sam@school.edu',
      password: 'correct-horse-battery',
      ip: testIp,
    });

    expect(result.user.email).toBe('sam@school.edu');
  });

  it('matches identifiers case-insensitively', async () => {
    await seedUser({ schoolId: school.id, role: 'student', loginId: 'apex-4821', password: 'maple-otter-473' });

    const result = await login({ identifier: '  APEX-4821 ', password: 'maple-otter-473', ip: testIp });
    expect(result.user.loginId).toBe('apex-4821');
  });

  it('rejects a wrong password and counts the failure', async () => {
    const user = await seedUser({
      schoolId: school.id,
      role: 'student',
      loginId: 'apex-4821',
      password: 'maple-otter-473',
    });

    await expectApiError(
      login({ identifier: 'apex-4821', password: 'wrong', ip: testIp }),
      'invalid_credentials',
    );

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.failedLoginCount).toBe(1);
  });

  it('gives the same error for an unknown account as for a wrong password', async () => {
    await expectApiError(
      login({ identifier: 'nobody-0000', password: 'whatever', ip: testIp }),
      'invalid_credentials',
    );
  });

  it('locks the account after ten consecutive failures', async () => {
    await seedUser({ schoolId: school.id, role: 'student', loginId: 'apex-4821', password: 'maple-otter-473' });

    for (let attempt = 0; attempt < 9; attempt += 1) {
      await expectApiError(
        login({ identifier: 'apex-4821', password: 'wrong', ip: `10.0.0.${attempt}` }),
        'invalid_credentials',
      );
    }

    await expectApiError(
      login({ identifier: 'apex-4821', password: 'wrong', ip: '10.0.0.99' }),
      'account_locked',
    );

    // Correct credentials must not open the lock.
    await expectApiError(
      login({ identifier: 'apex-4821', password: 'maple-otter-473', ip: '10.0.0.100' }),
      'account_locked',
    );
  });

  it('clears the failure counter on a successful sign-in', async () => {
    const user = await seedUser({
      schoolId: school.id,
      role: 'student',
      loginId: 'apex-4821',
      password: 'maple-otter-473',
    });

    await expectApiError(
      login({ identifier: 'apex-4821', password: 'wrong', ip: testIp }),
      'invalid_credentials',
    );
    await login({ identifier: 'apex-4821', password: 'maple-otter-473', ip: testIp });

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.failedLoginCount).toBe(0);
    expect(after.lastLoginAt).not.toBeNull();
  });

  it('refuses a deactivated account', async () => {
    await seedUser({
      schoolId: school.id,
      role: 'educator',
      email: 'gone@school.edu',
      password: 'correct-horse-battery',
      isActive: false,
    });

    await expectApiError(
      login({ identifier: 'gone@school.edu', password: 'correct-horse-battery', ip: testIp }),
      'account_inactive',
    );
  });

  it('lets a whole class sign in from one shared school IP', async () => {
    // Regression: schools sit behind one public IP, so 30 successful sign-ins
    // from one address is the product working, not an attack. A limit that
    // counted every attempt locked out the 31st student — found by the phase-3
    // acceptance run, where exactly that happened.
    const students = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        seedUser({
          schoolId: school.id,
          role: 'student',
          loginId: `student-${String(i).padStart(3, '0')}`,
          password: 'maple-otter-473',
        }),
      ),
    );

    const results = await Promise.allSettled(
      students.map((student) =>
        login({ identifier: student.loginId!, password: 'maple-otter-473', ip: '198.51.100.1' }),
      ),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(40);
  });

  it('still throttles repeated FAILURES from one shared IP', async () => {
    // The same address failing over and over is the case worth stopping, and
    // it is unaffected by how many students legitimately signed in first.
    const codes: string[] = [];
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        await login({ identifier: `ghost-${attempt}`, password: 'wrong', ip: '198.51.100.2' });
      } catch (error) {
        if (error instanceof ApiError) codes.push(error.code);
      }
    }
    expect(codes).toContain('rate_limited');
  });

  it('throttles grinding against an identifier that has no account to lock', async () => {
    // Lockout cannot protect an identifier that does not exist — there is no
    // row to set locked_until on — so the per-identifier rate limit is the only
    // thing standing between an attacker and unlimited enumeration.
    const codes: string[] = [];
    for (let attempt = 0; attempt < 24; attempt += 1) {
      try {
        await login({ identifier: 'ghost-0000', password: 'wrong', ip: `198.51.100.${attempt}` });
      } catch (error) {
        if (error instanceof ApiError) codes.push(error.code);
      }
    }

    expect(codes).toContain('rate_limited');
  });

  it('locks a real account before the identifier throttle can mask it', async () => {
    // Regression guard on a real ordering bug: with the per-identifier limit at
    // or below MAX_FAILED_LOGINS, the throttle fires first and lockout becomes
    // dead code that never runs.
    await seedUser({ schoolId: school.id, role: 'student', loginId: 'apex-4821', password: 'maple-otter-473' });

    const codes: string[] = [];
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        await login({ identifier: 'apex-4821', password: 'wrong', ip: `198.51.100.${attempt}` });
      } catch (error) {
        if (error instanceof ApiError) codes.push(error.code);
      }
    }

    expect(codes.at(-1)).toBe('account_locked');
    expect(codes).not.toContain('rate_limited');
  });
});

describe('sessions', () => {
  it('resolves a freshly issued token and rejects an unknown one', async () => {
    await seedUser({ schoolId: school.id, role: 'student', loginId: 'apex-4821', password: 'maple-otter-473' });
    const { token } = await login({ identifier: 'apex-4821', password: 'maple-otter-473', ip: testIp });

    expect(await resolveSession(token)).not.toBeNull();
    expect(await resolveSession('not-a-real-token')).toBeNull();
    expect(await resolveSession(undefined)).toBeNull();
  });

  it('stores only the hash of the session token', async () => {
    await seedUser({ schoolId: school.id, role: 'student', loginId: 'apex-4821', password: 'maple-otter-473' });
    const { token } = await login({ identifier: 'apex-4821', password: 'maple-otter-473', ip: testIp });

    const stored = await prisma.session.findFirstOrThrow();
    expect(stored.tokenHash).not.toBe(token);
    expect(stored.tokenHash).toBe(hashToken(token));
  });

  it('stops resolving once revoked', async () => {
    const user = await seedUser({
      schoolId: school.id,
      role: 'student',
      loginId: 'apex-4821',
      password: 'maple-otter-473',
    });
    const { token } = await login({ identifier: 'apex-4821', password: 'maple-otter-473', ip: testIp });

    await revokeAllSessionsForUser(user.id);
    expect(await resolveSession(token)).toBeNull();
  });

  it('stops resolving once expired', async () => {
    await seedUser({ schoolId: school.id, role: 'student', loginId: 'apex-4821', password: 'maple-otter-473' });
    const { token } = await login({ identifier: 'apex-4821', password: 'maple-otter-473', ip: testIp });

    await prisma.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await resolveSession(token)).toBeNull();
  });

  it('stops resolving when the user is deactivated', async () => {
    const user = await seedUser({
      schoolId: school.id,
      role: 'student',
      loginId: 'apex-4821',
      password: 'maple-otter-473',
    });
    const { token } = await login({ identifier: 'apex-4821', password: 'maple-otter-473', ip: testIp });

    await prisma.user.update({ where: { id: user.id }, data: { isActive: false } });
    expect(await resolveSession(token)).toBeNull();
  });

  it('gives students a shorter window than educators', async () => {
    const student = await seedUser({
      schoolId: school.id,
      role: 'student',
      loginId: 'apex-4821',
      password: 'maple-otter-473',
    });
    const educator = await seedUser({
      schoolId: school.id,
      role: 'educator',
      email: 'sam@school.edu',
      password: 'correct-horse-battery',
    });

    const studentSession = await login({
      identifier: 'apex-4821',
      password: 'maple-otter-473',
      ip: testIp,
    });
    const educatorSession = await login({
      identifier: 'sam@school.edu',
      password: 'correct-horse-battery',
      ip: testIp,
    });

    expect(studentSession.user.id).toBe(student.id);
    expect(educatorSession.user.id).toBe(educator.id);
    expect(studentSession.expiresAt.getTime()).toBeLessThan(educatorSession.expiresAt.getTime());
  });
});

describe('changePassword', () => {
  it('clears the first-login flag and keeps the current session alive', async () => {
    const user = await seedUser({
      schoolId: school.id,
      role: 'student',
      loginId: 'apex-4821',
      password: 'maple-otter-473',
      mustChangePassword: true,
    });
    const { token } = await login({ identifier: 'apex-4821', password: 'maple-otter-473', ip: testIp });
    const session = await prisma.session.findFirstOrThrow();

    await changePassword({
      user,
      currentPassword: 'maple-otter-473',
      newPassword: 'my-own-password',
      currentSessionId: session.id,
      ip: testIp,
    });

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.mustChangePassword).toBe(false);
    expect(await resolveSession(token)).not.toBeNull();
  });

  it('signs out every other device', async () => {
    const user = await seedUser({
      schoolId: school.id,
      role: 'student',
      loginId: 'apex-4821',
      password: 'maple-otter-473',
      mustChangePassword: true,
    });

    const first = await login({ identifier: 'apex-4821', password: 'maple-otter-473', ip: testIp });
    const second = await login({ identifier: 'apex-4821', password: 'maple-otter-473', ip: testIp });
    const keep = await prisma.session.findFirstOrThrow({
      where: { tokenHash: hashToken(second.token) },
    });

    await changePassword({
      user,
      currentPassword: 'maple-otter-473',
      newPassword: 'my-own-password',
      currentSessionId: keep.id,
      ip: testIp,
    });

    expect(await resolveSession(first.token)).toBeNull();
    expect(await resolveSession(second.token)).not.toBeNull();
  });

  it('requires the correct current password', async () => {
    const user = await seedUser({
      schoolId: school.id,
      role: 'student',
      loginId: 'apex-4821',
      password: 'maple-otter-473',
      mustChangePassword: true,
    });

    await expectApiError(
      changePassword({
        user,
        currentPassword: 'not-it',
        newPassword: 'my-own-password',
        currentSessionId: 'irrelevant',
        ip: testIp,
      }),
      'invalid_credentials',
    );
  });

  it('rejects a new password that is too short, reused, or the login ID', async () => {
    const user = await seedUser({
      schoolId: school.id,
      role: 'student',
      loginId: 'apex-4821',
      password: 'maple-otter-473',
      mustChangePassword: true,
    });
    const session = { currentSessionId: 'irrelevant', ip: testIp, user };

    await expectApiError(
      changePassword({ ...session, currentPassword: 'maple-otter-473', newPassword: 'short' }),
      'weak_password',
    );
    await expectApiError(
      changePassword({
        ...session,
        currentPassword: 'maple-otter-473',
        newPassword: 'maple-otter-473',
      }),
      'weak_password',
    );
    await expectApiError(
      changePassword({ ...session, currentPassword: 'maple-otter-473', newPassword: 'APEX-4821' }),
      'weak_password',
    );
  });

  it('lets the student sign in with the new password afterwards', async () => {
    const user = await seedUser({
      schoolId: school.id,
      role: 'student',
      loginId: 'apex-4821',
      password: 'maple-otter-473',
      mustChangePassword: true,
    });
    await login({ identifier: 'apex-4821', password: 'maple-otter-473', ip: testIp });
    const session = await prisma.session.findFirstOrThrow();

    await changePassword({
      user,
      currentPassword: 'maple-otter-473',
      newPassword: 'my-own-password',
      currentSessionId: session.id,
      ip: testIp,
    });

    const result = await login({ identifier: 'apex-4821', password: 'my-own-password', ip: testIp });
    expect(result.user.mustChangePassword).toBe(false);

    await expectApiError(
      login({ identifier: 'apex-4821', password: 'maple-otter-473', ip: testIp }),
      'invalid_credentials',
    );
  });
});
