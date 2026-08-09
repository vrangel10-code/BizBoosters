import { beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import type { School, User } from '@prisma/client';

/**
 * These tests drive the real route handlers, including requireAuth. That is the
 * only honest way to prove the first-login gate: a test that re-implements the
 * check proves the test, not the gate.
 *
 * next/headers' cookies() only works inside a Next request scope, so it is
 * replaced with a jar the test controls — the same object the handlers read and
 * write through setSessionCookie().
 */
const jar = new Map<string, string>();

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = jar.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set: (name: string, value: string) => {
      if (value === '') jar.delete(name);
      else jar.set(name, value);
    },
    delete: (name: string) => jar.delete(name),
  }),
}));

const { prisma, resetDatabase, createSchool, seedUser } = await import('./helpers');
const { POST: loginRoute } = await import('../src/app/api/v1/auth/login/route');
const { POST: logoutRoute } = await import('../src/app/api/v1/auth/logout/route');
const { GET: meRoute } = await import('../src/app/api/v1/auth/me/route');
const { POST: changePasswordRoute } = await import(
  '../src/app/api/v1/auth/change-password/route'
);
const { GET: listStudentsRoute, POST: createStudentRoute } = await import(
  '../src/app/api/v1/students/route'
);
const { GET: listInvitationsRoute, POST: createInvitationRoute } = await import(
  '../src/app/api/v1/admin/invitations/route'
);
const { GET: healthRoute } = await import('../src/app/api/v1/health/route');

let school: School;
let educator: User;

const post = (path: string, body: unknown) =>
  new Request(`http://localhost/api/v1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.10' },
    body: JSON.stringify(body),
  });

const get = (path: string) =>
  new Request(`http://localhost/api/v1${path}`, {
    headers: { 'x-forwarded-for': '203.0.113.10' },
  });

interface Envelope {
  status: number;
  body: Record<string, unknown> & { error?: { code: string; message: string } };
}

const read = async (response: Response): Promise<Envelope> => ({
  status: response.status,
  body: (await response.json().catch(() => ({}))) as Envelope['body'],
});

beforeEach(async () => {
  jar.clear();
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

const signIn = async (identifier: string, password: string) =>
  read(await loginRoute(post('/auth/login', { identifier, password })));

describe('health', () => {
  it('reports database reachability', async () => {
    const { status, body } = await read(await healthRoute(get('/health')));
    expect(status).toBe(200);
    expect(body.status).toBe('ok');
  });
});

describe('login route', () => {
  it('sets a session cookie on success', async () => {
    const { status } = await signIn('sam@school.edu', 'correct-horse-battery');
    expect(status).toBe(200);
    expect(jar.get('bb_session')).toBeTruthy();
  });

  it('returns invalid_credentials without a cookie on failure', async () => {
    const { status, body } = await signIn('sam@school.edu', 'wrong');
    expect(status).toBe(401);
    expect(body.error?.code).toBe('invalid_credentials');
    expect(jar.get('bb_session')).toBeUndefined();
  });

  it('rejects a malformed body with validation_failed', async () => {
    const { status, body } = await read(await loginRoute(post('/auth/login', { identifier: '' })));
    expect(status).toBe(422);
    expect(body.error?.code).toBe('validation_failed');
  });
});

describe('unauthenticated access', () => {
  it('401s on protected routes with no session', async () => {
    const { status, body } = await read(await listStudentsRoute(get('/students')));
    expect(status).toBe(401);
    expect(body.error?.code).toBe('unauthenticated');
  });

  it('401s on a forged cookie', async () => {
    jar.set('bb_session', 'not-a-real-token');
    const { status } = await read(await listStudentsRoute(get('/students')));
    expect(status).toBe(401);
  });
});

describe('first-login gate', () => {
  const createStudentAndSignIn = async () => {
    await signIn('sam@school.edu', 'correct-horse-battery');
    const { body } = await read(
      await createStudentRoute(post('/students', { display_name: 'Aisha Tan' })),
    );
    const credentials = body.credentials as { login_id: string; default_password: string };

    jar.clear();
    await signIn(credentials.login_id, credentials.default_password);
    return credentials;
  };

  it('signals must_change_password at login', async () => {
    await signIn('sam@school.edu', 'correct-horse-battery');
    const { body } = await read(
      await createStudentRoute(post('/students', { display_name: 'Aisha Tan' })),
    );
    const credentials = body.credentials as { login_id: string; default_password: string };

    jar.clear();
    const result = await signIn(credentials.login_id, credentials.default_password);
    expect(result.body.must_change_password).toBe(true);
  });

  it('blocks a normal API route until the password is changed', async () => {
    await createStudentAndSignIn();

    const { status, body } = await read(await listStudentsRoute(get('/students')));
    expect(status).toBe(403);
    expect(body.error?.code).toBe('password_change_required');
  });

  it('still allows /auth/me, change-password and logout', async () => {
    await createStudentAndSignIn();

    expect((await read(await meRoute(get('/auth/me')))).status).toBe(200);
    expect(
      (await read(await changePasswordRoute(post('/auth/change-password', {})))).status,
    ).toBe(422); // reached the handler; failed validation, not the gate
  });

  it('lifts the gate after a successful change, in the same session', async () => {
    const credentials = await createStudentAndSignIn();

    const changed = await read(
      await changePasswordRoute(
        post('/auth/change-password', {
          current_password: credentials.default_password,
          new_password: 'aisha-picks-this',
        }),
      ),
    );
    expect(changed.status).toBe(200);

    const me = await read(await meRoute(get('/auth/me')));
    expect(me.body.must_change_password).toBe(false);
  });

  /**
   * The first change does not ask for the temporary password again — signing
   * in with it is what created this session, so a retype only gives a child
   * another chance to mistype a password read off a slip.
   */
  it('lets the forced first change omit the temporary password', async () => {
    await createStudentAndSignIn();

    const changed = await read(
      await changePasswordRoute(
        post('/auth/change-password', { new_password: 'aisha-picks-this' }),
      ),
    );

    expect(changed.status).toBe(200);
    expect((await read(await meRoute(get('/auth/me')))).body.must_change_password).toBe(false);
  });

  /**
   * The other side of that: once the gate is lifted the session may be one
   * left open on a shared classroom machine, so the current password is the
   * only thing between a passer-by and taking the account over. It stays
   * required, and is still checked.
   */
  it('still demands the current password for a voluntary change', async () => {
    await createStudentAndSignIn();
    await changePasswordRoute(post('/auth/change-password', { new_password: 'aisha-picks-this' }));

    const omitted = await read(
      await changePasswordRoute(post('/auth/change-password', { new_password: 'another-one-now' })),
    );
    expect(omitted.status).toBe(422);
    expect(omitted.body.error?.code).toBe('validation_failed');

    const wrong = await read(
      await changePasswordRoute(
        post('/auth/change-password', {
          current_password: 'not-the-right-one',
          new_password: 'another-one-now',
        }),
      ),
    );
    expect(wrong.body.error?.code).toBe('invalid_credentials');

    const right = await read(
      await changePasswordRoute(
        post('/auth/change-password', {
          current_password: 'aisha-picks-this',
          new_password: 'another-one-now',
        }),
      ),
    );
    expect(right.status).toBe(200);
  });

  /** Keeping the temporary password would defeat the gate entirely. */
  it('refuses a new password identical to the current one', async () => {
    const credentials = await createStudentAndSignIn();

    const { status, body } = await read(
      await changePasswordRoute(
        post('/auth/change-password', { new_password: credentials.default_password }),
      ),
    );

    expect(status).toBe(422);
    expect(body.error?.code).toBe('weak_password');
  });

  it('rejects a weak replacement password with weak_password', async () => {
    const credentials = await createStudentAndSignIn();

    const { status, body } = await read(
      await changePasswordRoute(
        post('/auth/change-password', {
          current_password: credentials.default_password,
          new_password: 'short',
        }),
      ),
    );
    expect(status).toBe(422);
    expect(body.error?.code).toBe('weak_password');
  });
});

describe('role authorization', () => {
  it('forbids a student from creating students', async () => {
    await signIn('sam@school.edu', 'correct-horse-battery');
    const { body } = await read(
      await createStudentRoute(post('/students', { display_name: 'Aisha Tan' })),
    );
    const credentials = body.credentials as { login_id: string; default_password: string };

    jar.clear();
    await signIn(credentials.login_id, credentials.default_password);
    await changePasswordRoute(
      post('/auth/change-password', {
        current_password: credentials.default_password,
        new_password: 'aisha-picks-this',
      }),
    );

    const attempt = await read(
      await createStudentRoute(post('/students', { display_name: 'Sneaky' })),
    );
    expect(attempt.status).toBe(403);
    expect(attempt.body.error?.code).toBe('forbidden');
  });

  it('forbids a plain educator from inviting colleagues', async () => {
    await signIn('sam@school.edu', 'correct-horse-battery');

    const { status, body } = await read(
      await createInvitationRoute(post('/admin/invitations', { email: 'new@school.edu' })),
    );
    expect(status).toBe(403);
    expect(body.error?.code).toBe('forbidden');
  });

  it('allows a school admin to invite, and lists it as pending', async () => {
    await seedUser({
      schoolId: school.id,
      role: 'school_admin',
      email: 'head@school.edu',
      password: 'correct-horse-battery',
    });
    await signIn('head@school.edu', 'correct-horse-battery');

    const created = await read(
      await createInvitationRoute(post('/admin/invitations', { email: 'new@school.edu' })),
    );
    expect(created.status).toBe(201);

    const listed = await read(await listInvitationsRoute(get('/admin/invitations')));
    const data = listed.body.data as { email: string; status: string }[];
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({ email: 'new@school.edu', status: 'pending' });
  });

  it('never returns the invitation token in the API response', async () => {
    await seedUser({
      schoolId: school.id,
      role: 'school_admin',
      email: 'head@school.edu',
      password: 'correct-horse-battery',
    });
    await signIn('head@school.edu', 'correct-horse-battery');

    const created = await read(
      await createInvitationRoute(post('/admin/invitations', { email: 'new@school.edu' })),
    );
    expect(JSON.stringify(created.body)).not.toMatch(/token/i);
  });
});

describe('student credentials', () => {
  it('returns the default password exactly once, at creation', async () => {
    await signIn('sam@school.edu', 'correct-horse-battery');

    const created = await read(
      await createStudentRoute(post('/students', { display_name: 'Aisha Tan' })),
    );
    expect(created.status).toBe(201);
    const credentials = created.body.credentials as { default_password: string };
    expect(credentials.default_password).toBeTruthy();

    // Nothing in the listing can reproduce it.
    const listed = await read(await listStudentsRoute(get('/students')));
    expect(JSON.stringify(listed.body)).not.toContain(credentials.default_password);
  });
});

describe('logout', () => {
  it('clears the cookie and invalidates the session', async () => {
    await signIn('sam@school.edu', 'correct-horse-battery');
    expect(jar.get('bb_session')).toBeTruthy();

    const { status } = await read(await logoutRoute(post('/auth/logout', {})));
    expect(status).toBe(200);
    expect(jar.get('bb_session')).toBeUndefined();

    const after = await read(await meRoute(get('/auth/me')));
    expect(after.status).toBe(401);
  });

  it('leaves the old token dead even if it is replayed', async () => {
    await signIn('sam@school.edu', 'correct-horse-battery');
    const stolen = jar.get('bb_session')!;

    await logoutRoute(post('/auth/logout', {}));
    jar.set('bb_session', stolen);

    expect((await read(await meRoute(get('/auth/me')))).status).toBe(401);
    expect(educator.id).toBeTruthy();
  });
});
