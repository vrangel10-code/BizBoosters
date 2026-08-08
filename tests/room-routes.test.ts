import { beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import type { School } from '@prisma/client';

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
const { GET: listRoomsRoute, POST: createRoomRoute } = await import(
  '../src/app/api/v1/rooms/route'
);
const { GET: getRoomRoute } = await import('../src/app/api/v1/rooms/[roomId]/route');
const { POST: addStudentRoute } = await import(
  '../src/app/api/v1/rooms/[roomId]/students/route'
);
const { POST: changePasswordRoute } = await import(
  '../src/app/api/v1/auth/change-password/route'
);
const { POST: awardRoute } = await import(
  '../src/app/api/v1/rooms/[roomId]/tokens/award/route'
);
const { POST: adjustRoute } = await import(
  '../src/app/api/v1/rooms/[roomId]/tokens/adjust/route'
);
const { GET: historyRoute } = await import('../src/app/api/v1/rooms/[roomId]/history/route');
const { GET: activityRoute } = await import('../src/app/api/v1/rooms/[roomId]/activity/route');

let school: School;

const post = (body: unknown) =>
  new Request('http://localhost/api/v1/x', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.10' },
    body: JSON.stringify(body),
  });

const get = (query = '') =>
  new Request(`http://localhost/api/v1/x${query}`, {
    headers: { 'x-forwarded-for': '203.0.113.10' },
  });

const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });

/**
 * Route responses are deliberately loosely typed here: these tests assert on
 * the wire shape a client actually receives, so re-declaring server types would
 * only prove the test agrees with itself.
 */
interface Envelope {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

const read = async (response: Response): Promise<Envelope> => ({
  status: response.status,
  body: ((await response.json().catch(() => ({}))) ?? {}) as Envelope['body'],
});

const signInAs = async (identifier: string, password: string) => {
  jar.clear();
  return read(await loginRoute(post({ identifier, password })));
};

beforeEach(async () => {
  jar.clear();
  await resetDatabase();
  school = await createSchool();
  await seedUser({
    schoolId: school.id,
    role: 'educator',
    email: 'sam@school.edu',
    password: 'correct-horse-battery',
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** Creates a room with two students, each past their first-login gate. */
async function setupRoom() {
  await signInAs('sam@school.edu', 'correct-horse-battery');

  const roomResponse = await read(await createRoomRoute(post({ name: 'Enterprise 7B' })));
  const roomId = roomResponse.body.room.id as string;

  // Create both students first, while still signed in as the educator. Signing
  // in as a student mid-loop would replace the session and make the next
  // creation a forbidden student-acting-as-educator call.
  const issued: { name: string; loginId: string; defaultPassword: string; enrollmentId: string }[] =
    [];

  for (const name of ['Aisha Tan', 'Ben Cole']) {
    const response = await read(
      await addStudentRoute(post({ display_name: name }), params({ roomId })),
    );
    if (response.status !== 201) {
      throw new Error(`student creation failed: ${JSON.stringify(response.body)}`);
    }
    issued.push({
      name,
      loginId: response.body.credentials.login_id as string,
      defaultPassword: response.body.credentials.default_password as string,
      enrollmentId: response.body.student.enrollment_id as string,
    });
  }

  // Then clear each student's first-login gate in its own session.
  const students = [];
  for (const student of issued) {
    await signInAs(student.loginId, student.defaultPassword);
    const chosen = `${student.loginId.split('-')[0]}-chose-this`;
    const changed = await read(
      await changePasswordRoute(
        post({ current_password: student.defaultPassword, new_password: chosen }),
      ),
    );
    if (changed.status !== 200) {
      throw new Error(`password change failed: ${JSON.stringify(changed.body)}`);
    }
    students.push({ ...student, password: chosen });
  }

  await signInAs('sam@school.edu', 'correct-horse-battery');
  return { roomId, students };
}

describe('room listing', () => {
  it('gives an educator their rooms and a student theirs', async () => {
    const { roomId, students } = await setupRoom();

    const educatorView = await read(await listRoomsRoute(get()));
    expect(educatorView.body.data).toHaveLength(1);
    expect(educatorView.body.data[0]).toMatchObject({ id: roomId, student_count: 2 });

    await signInAs(students[0]!.loginId, students[0]!.password);
    const studentView = await read(await listRoomsRoute(get()));
    expect(studentView.body.data).toHaveLength(1);
    expect(studentView.body.data[0]).toMatchObject({ room_id: roomId, token_balance: 0 });
  });

  it('404s a student asking for a room they are not in', async () => {
    const { students } = await setupRoom();
    const other = await read(await createRoomRoute(post({ name: 'Enterprise 8C' })));
    const otherRoomId = other.body.room.id as string;

    await signInAs(students[0]!.loginId, students[0]!.password);
    const response = await read(await getRoomRoute(get(), params({ roomId: otherRoomId })));

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('not_found');
  });
});

describe('awarding tokens', () => {
  it('reaches every student’s own history with the reason attached', async () => {
    const { roomId, students } = await setupRoom();

    const award = await read(
      await awardRoute(
        post({
          enrollment_ids: students.map((s) => s.enrollmentId),
          amount: 40,
          note: 'Great pitch in week 4',
        }),
        params({ roomId }),
      ),
    );
    expect(award.status).toBe(200);

    for (const student of students) {
      await signInAs(student.loginId, student.password);
      const history = await read(await historyRoute(get(), params({ roomId })));

      expect(history.body.token_balance).toBe(40);
      expect(history.body.ledger[0]).toMatchObject({
        delta: 40,
        balance_after: 40,
        note: 'Great pitch in week 4',
        awarded_by: 'Test Educator',
      });
    }
  });

  it('never shows one student another student’s activity', async () => {
    const { roomId, students } = await setupRoom();

    await awardRoute(
      post({ enrollment_ids: [students[0]!.enrollmentId], amount: 40, note: 'For Aisha only' }),
      params({ roomId }),
    );

    await signInAs(students[1]!.loginId, students[1]!.password);
    const history = await read(await historyRoute(get(), params({ roomId })));

    expect(history.body.token_balance).toBe(0);
    expect(history.body.ledger).toHaveLength(0);
    expect(JSON.stringify(history.body)).not.toContain('For Aisha only');
  });

  it('still shows room-wide events to students', async () => {
    const { roomId, students } = await setupRoom();

    await signInAs(students[0]!.loginId, students[0]!.password);
    const history = await read(await historyRoute(get(), params({ roomId })));

    // room.created has no subject, so it must reach everyone.
    expect(history.body.activity.map((row: { type: string }) => row.type)).toContain(
      'room.created',
    );
  });

  it('forbids a student from awarding tokens', async () => {
    const { roomId, students } = await setupRoom();

    await signInAs(students[0]!.loginId, students[0]!.password);
    const response = await read(
      await awardRoute(
        post({ enrollment_ids: [students[0]!.enrollmentId], amount: 1000 }),
        params({ roomId }),
      ),
    );

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('forbidden');
  });

  it('forbids a student from reading the room-wide activity log', async () => {
    const { roomId, students } = await setupRoom();

    await signInAs(students[0]!.loginId, students[0]!.password);
    const response = await read(await activityRoute(get(), params({ roomId })));

    expect(response.status).toBe(403);
  });

  it('404s an educator from another school', async () => {
    const { roomId } = await setupRoom();

    const otherSchool = await createSchool('Southgate High');
    await seedUser({
      schoolId: otherSchool.id,
      role: 'educator',
      email: 'other@southgate.edu',
      password: 'correct-horse-battery',
    });

    await signInAs('other@southgate.edu', 'correct-horse-battery');
    const response = await read(
      await awardRoute(post({ enrollment_ids: [], amount: 10 }), params({ roomId })),
    );

    expect(response.status).toBe(404);
  });

  it('rejects a negative or zero award at the schema', async () => {
    const { roomId, students } = await setupRoom();

    const zero = await read(
      await awardRoute(
        post({ enrollment_ids: [students[0]!.enrollmentId], amount: 0 }),
        params({ roomId }),
      ),
    );
    expect(zero.status).toBe(422);
  });
});

describe('adjusting tokens', () => {
  it('requires a reason', async () => {
    const { roomId, students } = await setupRoom();

    const response = await read(
      await adjustRoute(
        post({ enrollment_id: students[0]!.enrollmentId, delta: -10, note: '' }),
        params({ roomId }),
      ),
    );

    expect(response.status).toBe(422);
  });

  it('shows the correction in the student’s ledger beside the original', async () => {
    const { roomId, students } = await setupRoom();

    await awardRoute(
      post({ enrollment_ids: [students[0]!.enrollmentId], amount: 60, note: 'Group bonus' }),
      params({ roomId }),
    );
    await adjustRoute(
      post({
        enrollment_id: students[0]!.enrollmentId,
        delta: -20,
        note: 'Double-counted the group bonus',
      }),
      params({ roomId }),
    );

    await signInAs(students[0]!.loginId, students[0]!.password);
    const history = await read(await historyRoute(get(), params({ roomId })));

    expect(history.body.token_balance).toBe(40);
    expect(history.body.ledger).toHaveLength(2);
    expect(history.body.ledger[0]).toMatchObject({
      delta: -20,
      note: 'Double-counted the group bonus',
    });
  });
});

describe('educator activity log', () => {
  it('records one row per student, sharing a batch id', async () => {
    const { roomId, students } = await setupRoom();

    await awardRoute(
      post({ enrollment_ids: students.map((s) => s.enrollmentId), amount: 40, note: 'Week 4' }),
      params({ roomId }),
    );

    const log = await read(await activityRoute(get('?type=tokens.awarded'), params({ roomId })));
    expect(log.body.data).toHaveLength(2);

    const batchIds = new Set(
      log.body.data.map((row: { payload: { batch_id: string } }) => row.payload.batch_id),
    );
    expect(batchIds.size).toBe(1);
    expect(log.body.data[0].student_name).toBeTruthy();
  });

  it('filters to one student when asked', async () => {
    const { roomId, students } = await setupRoom();

    await awardRoute(
      post({ enrollment_ids: students.map((s) => s.enrollmentId), amount: 40 }),
      params({ roomId }),
    );

    const log = await read(
      await activityRoute(get(`?enrollment_id=${students[0]!.enrollmentId}`), params({ roomId })),
    );

    expect(
      log.body.data.every(
        (row: { enrollment_id: string }) => row.enrollment_id === students[0]!.enrollmentId,
      ),
    ).toBe(true);
  });
});
