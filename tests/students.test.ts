import { beforeEach, afterAll, describe, expect, it } from 'vitest';
import type { School, User } from '@prisma/client';
import { prisma, resetDatabase, createSchool, seedUser, testIp } from './helpers';
import { createStudent, resetStudentPassword } from '../src/server/services/students';
import { login, changePassword } from '../src/server/services/auth-service';
import { resolveSession } from '../src/server/auth/session';
import { ApiError } from '../src/server/errors';
import { DEFAULT_STUDENT_PASSWORD } from '../src/server/auth/identifiers';

let school: School;
let educator: User;

beforeEach(async () => {
  await resetDatabase();
  school = await createSchool();
  educator = await seedUser({
    schoolId: school.id,
    role: 'educator',
    email: 'sam@school.edu',
    password: 'correct-horse-battery',
  });
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

const newStudent = (displayName = 'Aisha Tan', loginId?: string) =>
  createStudent({ actor: educator, schoolId: school.id, displayName, loginId, ip: testIp });

describe('createStudent', () => {
  it('returns usable credentials and forces a change at first login', async () => {
    const credentials = await newStudent();

    expect(credentials.loginId).toMatch(/^aisha-tan-\d{4}$/);
    expect(credentials.defaultPassword).toBe(DEFAULT_STUDENT_PASSWORD);

    const student = await prisma.user.findUniqueOrThrow({ where: { id: credentials.userId } });
    expect(student.mustChangePassword).toBe(true);
    expect(student.role).toBe('student');
    expect(student.email).toBeNull();
  });

  /**
   * Every student starts on the same known password now, by explicit product
   * decision. It is a weaker secret than a per-student one and that is accepted
   * because of what it replaces: a teacher reading thirty distinct one-time
   * passwords aloud, each mistype moving a child closer to a ten-failure
   * lockout. What keeps it defensible is that it is only ever valid until first
   * sign-in — which is the assertion below, not the sharing.
   */
  it('starts every student on the same password, valid only until first sign-in', async () => {
    const first = await newStudent('Aisha Tan');
    const second = await newStudent('Ben Cole');

    expect(first.defaultPassword).toBe(DEFAULT_STUDENT_PASSWORD);
    expect(second.defaultPassword).toBe(DEFAULT_STUDENT_PASSWORD);

    for (const credentials of [first, second]) {
      const student = await prisma.user.findUniqueOrThrow({ where: { id: credentials.userId } });
      expect(student.mustChangePassword).toBe(true);
    }
  });

  it('stores only a hash of the default password', async () => {
    const credentials = await newStudent();
    const student = await prisma.user.findUniqueOrThrow({ where: { id: credentials.userId } });
    expect(student.passwordHash).not.toContain(credentials.defaultPassword);
  });

  it('accepts an explicit login ID and normalizes it', async () => {
    const credentials = await newStudent('Aisha Tan', 'S1234567A');
    expect(credentials.loginId).toBe('s1234567a');
  });

  it('rejects a duplicate explicit login ID', async () => {
    await newStudent('Aisha Tan', 'S1234567A');
    await expectApiError(newStudent('Ben Cole', 'S1234567A'), 'login_id_in_use');
  });

  it('retries past a collision when generating', async () => {
    const names = ['Aisha Tan', 'Aisha Tan', 'Aisha Tan', 'Aisha Tan'];
    const ids = new Set<string>();
    for (const name of names) {
      ids.add((await newStudent(name)).loginId);
    }
    expect(ids.size).toBe(names.length);
  });

  it('falls back to a generated word when a name has no Latin characters', async () => {
    const credentials = await newStudent('陈伟明');
    expect(credentials.loginId).toMatch(/^[a-z]+-\d{4}$/);
  });
});

describe('first-login gate', () => {
  // The gate itself is exercised through the real route handlers in
  // tests/routes.test.ts, which is the only place it can be tested honestly.

  it('opens up once the student sets their own password', async () => {
    const credentials = await newStudent();
    await login({
      identifier: credentials.loginId,
      password: credentials.defaultPassword,
      ip: testIp,
    });

    const user = await prisma.user.findUniqueOrThrow({ where: { id: credentials.userId } });
    const session = await prisma.session.findFirstOrThrow();

    await changePassword({
      user,
      currentPassword: credentials.defaultPassword,
      newPassword: 'aisha-picks-this',
      currentSessionId: session.id,
      ip: testIp,
    });

    const after = await prisma.user.findUniqueOrThrow({ where: { id: credentials.userId } });
    expect(after.mustChangePassword).toBe(false);
  });

  it('will not accept the default password as the new password', async () => {
    const credentials = await newStudent();
    const user = await prisma.user.findUniqueOrThrow({ where: { id: credentials.userId } });

    await expectApiError(
      changePassword({
        user,
        currentPassword: credentials.defaultPassword,
        newPassword: credentials.defaultPassword,
        currentSessionId: 'irrelevant',
        ip: testIp,
      }),
      'weak_password',
    );
  });
});

describe('resetStudentPassword', () => {
  it('issues a new default, re-arms the gate and signs the student out everywhere', async () => {
    const credentials = await newStudent();
    const { token } = await login({
      identifier: credentials.loginId,
      password: credentials.defaultPassword,
      ip: testIp,
    });
    expect(await resolveSession(token)).not.toBeNull();

    const reset = await resetStudentPassword(educator, credentials.userId, testIp);

    // A reset puts the account back on the shared default, so what it revokes
    // is the password the student chose — not this one.
    expect(reset.defaultPassword).toBe(DEFAULT_STUDENT_PASSWORD);
    expect(await resolveSession(token)).toBeNull();

    const student = await prisma.user.findUniqueOrThrow({ where: { id: credentials.userId } });
    expect(student.mustChangePassword).toBe(true);

    await expect(
      login({ identifier: reset.loginId, password: reset.defaultPassword, ip: testIp }),
    ).resolves.toBeTruthy();
  });

  it('invalidates the password the student had chosen', async () => {
    const credentials = await newStudent();
    const { user, token } = await login({
      identifier: credentials.loginId,
      password: credentials.defaultPassword,
      ip: testIp,
    });
    const session = await prisma.session.findFirstOrThrow({ where: { userId: user.id } });
    await changePassword({
      user,
      newPassword: 'aisha-picks-this',
      currentSessionId: session.id,
      ip: testIp,
    });

    await resetStudentPassword(educator, credentials.userId, testIp);

    await expectApiError(
      login({ identifier: credentials.loginId, password: 'aisha-picks-this', ip: testIp }),
      'invalid_credentials',
    );
    expect(await resolveSession(token)).toBeNull();
  });

  it('clears a lockout, so a reset is also the unlock', async () => {
    const credentials = await newStudent();
    await prisma.user.update({
      where: { id: credentials.userId },
      data: { failedLoginCount: 10, lockedUntil: new Date(Date.now() + 900_000) },
    });

    const reset = await resetStudentPassword(educator, credentials.userId, testIp);

    await expect(
      login({ identifier: reset.loginId, password: reset.defaultPassword, ip: testIp }),
    ).resolves.toBeTruthy();
  });

  it('refuses to touch a student at another school', async () => {
    const otherSchool = await createSchool('Southgate High');
    const otherEducator = await seedUser({
      schoolId: otherSchool.id,
      role: 'educator',
      email: 'other@southgate.edu',
      password: 'correct-horse-battery',
    });
    const credentials = await newStudent();

    await expectApiError(
      resetStudentPassword(otherEducator, credentials.userId, testIp),
      'not_found',
    );
  });

  it('refuses to reset an educator through the student path', async () => {
    await expectApiError(resetStudentPassword(educator, educator.id, testIp), 'not_found');
  });
});
