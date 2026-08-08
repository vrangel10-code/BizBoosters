import type { Enrollment, User } from '@prisma/client';
import { prisma } from '../db';
import { apiError } from '../errors';
import { createStudent, type StudentCredentials } from './students';
import { recordActivity } from './activity';

export interface RosterRow {
  enrollment_id: string;
  student_id: string;
  display_name: string;
  login_id: string | null;
  token_balance: number;
  must_change_password: boolean;
  locked: boolean;
  last_login_at: string | null;
  joined_at: string;
}

export async function listRoster(roomId: string): Promise<RosterRow[]> {
  const enrollments = await prisma.enrollment.findMany({
    where: { roomId, status: 'active' },
    orderBy: { student: { displayName: 'asc' } },
    include: { student: true },
  });

  return enrollments.map((enrollment) => ({
    enrollment_id: enrollment.id,
    student_id: enrollment.studentId,
    display_name: enrollment.student.displayName,
    login_id: enrollment.student.loginId,
    token_balance: enrollment.tokenBalance,
    must_change_password: enrollment.student.mustChangePassword,
    locked: Boolean(
      enrollment.student.lockedUntil && enrollment.student.lockedUntil.getTime() > Date.now(),
    ),
    last_login_at: enrollment.student.lastLoginAt?.toISOString() ?? null,
    joined_at: enrollment.joinedAt.toISOString(),
  }));
}

/**
 * Re-enrolling a student who was previously removed reactivates the original
 * enrolment rather than creating a second one — which keeps their balance and
 * their history intact. A student who leaves and comes back mid-term has not
 * lost what they earned.
 */
async function enroll(roomId: string, studentId: string): Promise<Enrollment> {
  const existing = await prisma.enrollment.findUnique({
    where: { roomId_studentId: { roomId, studentId } },
  });

  if (existing) {
    if (existing.status === 'active') {
      throw apiError('already_enrolled', 'That student is already in this room.');
    }
    return prisma.enrollment.update({
      where: { id: existing.id },
      data: { status: 'active', removedAt: null },
    });
  }

  return prisma.enrollment.create({ data: { roomId, studentId } });
}

export interface AddExistingStudentsInput {
  actor: User;
  roomId: string;
  studentIds: string[];
  ip: string;
}

export async function addExistingStudents({
  actor,
  roomId,
  studentIds,
}: AddExistingStudentsInput): Promise<RosterRow[]> {
  const students = await prisma.user.findMany({
    where: { id: { in: studentIds }, role: 'student', schoolId: actor.schoolId ?? undefined },
  });

  if (students.length !== studentIds.length) {
    throw apiError('not_found', 'One or more of those students could not be found.');
  }

  for (const student of students) {
    const enrollment = await enroll(roomId, student.id);
    await recordActivity({
      roomId,
      type: 'enrollment.added',
      actorUserId: actor.id,
      subjectEnrollmentId: enrollment.id,
      payload: { student_name: student.displayName },
    });
  }

  return listRoster(roomId);
}

export interface CreatedStudentRow extends StudentCredentials {
  enrollmentId: string;
}

export interface CreateAndEnrollInput {
  actor: User;
  schoolId: string;
  roomId: string;
  displayName: string;
  loginId?: string | null;
  ip: string;
}

export async function createAndEnrollStudent({
  actor,
  schoolId,
  roomId,
  displayName,
  loginId,
  ip,
}: CreateAndEnrollInput): Promise<CreatedStudentRow> {
  const credentials = await createStudent({ actor, schoolId, displayName, loginId, ip });
  const enrollment = await enroll(roomId, credentials.userId);

  await recordActivity({
    roomId,
    type: 'enrollment.added',
    actorUserId: actor.id,
    subjectEnrollmentId: enrollment.id,
    payload: { student_name: credentials.displayName, created: true },
  });

  return { ...credentials, enrollmentId: enrollment.id };
}

export interface ImportRow {
  displayName: string;
  loginId?: string;
}

export interface ImportResult {
  created: CreatedStudentRow[];
  skipped: { row: number; name: string; reason: string }[];
}

/**
 * Parses `name[,login_id]` with an optional header line.
 *
 * Deliberately minimal rather than a CSV library: the input is a class list a
 * teacher pasted or exported, and the failure mode that matters is a bad row
 * being reported clearly, not RFC 4180 edge cases. Quoted fields are handled
 * because names like "Tan, Aisha" are common.
 */
export function parseRosterCsv(input: string): ImportRow[] {
  const lines = input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) return [];

  const parseLine = (line: string): string[] => {
    const cells: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];
      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        cells.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    cells.push(current.trim());
    return cells;
  };

  const first = parseLine(lines[0]!);
  const looksLikeHeader = /^(name|student|display[_ ]?name|full[_ ]?name)$/i.test(first[0] ?? '');
  const bodyLines = looksLikeHeader ? lines.slice(1) : lines;

  return bodyLines
    .map((line) => {
      const cells = parseLine(line);
      const displayName = cells[0] ?? '';
      const loginId = cells[1];
      return { displayName, ...(loginId ? { loginId } : {}) };
    })
    .filter((row) => row.displayName.length > 0);
}

export interface ImportRosterInput {
  actor: User;
  schoolId: string;
  roomId: string;
  csv: string;
  ip: string;
}

/**
 * Creating thirty students by hand is the thing that decides whether a teacher
 * adopts the tool, so import is a first-class path rather than a convenience.
 *
 * A bad row never aborts the import: the good rows land, and the failures come
 * back listed with their line numbers so the teacher can fix and re-run. An
 * all-or-nothing import of a 30-line paste would be maddening.
 */
export async function importRoster({
  actor,
  schoolId,
  roomId,
  csv,
  ip,
}: ImportRosterInput): Promise<ImportResult> {
  const rows = parseRosterCsv(csv);

  if (rows.length === 0) {
    throw apiError('validation_failed', 'No student rows found. Expected "Name" or "Name,LoginID".');
  }
  if (rows.length > 200) {
    throw apiError('validation_failed', 'Import up to 200 students at a time.');
  }

  const created: CreatedStudentRow[] = [];
  const skipped: ImportResult['skipped'] = [];

  for (const [index, row] of rows.entries()) {
    try {
      created.push(
        await createAndEnrollStudent({
          actor,
          schoolId,
          roomId,
          displayName: row.displayName,
          loginId: row.loginId ?? null,
          ip,
        }),
      );
    } catch (error) {
      skipped.push({
        row: index + 1,
        name: row.displayName,
        reason:
          error instanceof Error && 'code' in error && error.code === 'login_id_in_use'
            ? 'That login ID is already taken.'
            : 'Could not create this student.',
      });
    }
  }

  return { created, skipped };
}

/**
 * Soft removal. History and the token ledger are retained — a student who left
 * still happened, and their activity is part of the room's record — but their
 * held cards go back to the deck.
 */
export async function removeStudent(
  actor: User,
  roomId: string,
  enrollmentId: string,
): Promise<void> {
  const enrollment = await prisma.enrollment.findUnique({
    where: { id: enrollmentId },
    include: { student: { select: { displayName: true } } },
  });

  if (!enrollment || enrollment.roomId !== roomId) throw apiError('not_found', 'Not found.');
  if (enrollment.status === 'removed') return;

  await prisma.$transaction(async (tx) => {
    // Deck mutation, so it takes the same room lock as the draw.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${roomId}, 0))`;

    await tx.enrollment.update({
      where: { id: enrollmentId },
      data: { status: 'removed', removedAt: new Date() },
    });

    // Their held copies go back to the deck. Leaving them out of circulation
    // would let a departed student hold the room's Legendary hostage for the
    // rest of term.
    const held = await tx.inventoryItem.findMany({
      where: { enrollmentId, state: 'owned' },
      select: { id: true, cardId: true },
    });

    if (held.length > 0) {
      await tx.inventoryItem.updateMany({
        where: { id: { in: held.map((item) => item.id) } },
        data: { state: 'revoked', returnedAt: new Date() },
      });

      for (const item of held) {
        await tx.$executeRaw`
          UPDATE room_cards
             SET copies_remaining = copies_remaining + 1
           WHERE room_id = ${roomId}::uuid AND card_id = ${item.cardId}::uuid
             AND copies_remaining < copies_total
        `;
      }
    }

    await recordActivity(
      {
        roomId,
        type: 'enrollment.removed',
        actorUserId: actor.id,
        subjectEnrollmentId: enrollmentId,
        payload: {
          student_name: enrollment.student.displayName,
          token_balance_at_removal: enrollment.tokenBalance,
          copies_returned: held.length,
        },
      },
      tx,
    );
  });
}
