import type { Enrollment, Room, User } from '@prisma/client';
import { prisma } from '../db';
import { apiError } from '../errors';

/**
 * Room access is decided here and nowhere else.
 *
 * Every failure is a 404, never a 403. A teacher at another school asking about
 * a room ID should not be able to tell "that room exists but you cannot see it"
 * apart from "no such room" — the difference leaks the existence of other
 * schools' classes.
 */

export interface RoomEducatorContext {
  room: Room;
  isOwner: boolean;
}

export async function requireRoomEducator(
  user: User,
  roomId: string,
  options: { allowArchived?: boolean } = {},
): Promise<RoomEducatorContext> {
  if (user.role === 'student') throw apiError('not_found', 'Not found.');

  const room = await prisma.room.findUnique({
    where: { id: roomId },
    include: { educators: { where: { userId: user.id } } },
  });

  if (!room) throw apiError('not_found', 'Not found.');

  // A super_admin crosses schools; everyone else is confined to their own.
  const sameSchool = room.schoolId === user.schoolId;
  const membership = room.educators[0];

  if (user.role === 'super_admin') {
    // through
  } else if (user.role === 'school_admin') {
    // Admins oversee every room in their school without being enrolled in it.
    if (!sameSchool) throw apiError('not_found', 'Not found.');
  } else if (!membership || !sameSchool) {
    throw apiError('not_found', 'Not found.');
  }

  if (room.status === 'archived' && !options.allowArchived) {
    throw apiError('room_archived', 'This room has been archived and cannot be changed.');
  }

  return { room, isOwner: membership?.role === 'owner' || user.role !== 'educator' };
}

export interface RoomStudentContext {
  room: Room;
  enrollment: Enrollment;
}

export async function requireRoomEnrollment(
  user: User,
  roomId: string,
  options: { allowArchived?: boolean } = {},
): Promise<RoomStudentContext> {
  const enrollment = await prisma.enrollment.findFirst({
    where: { roomId, studentId: user.id, status: 'active' },
    include: { room: true },
  });

  if (!enrollment) throw apiError('not_found', 'Not found.');

  if (enrollment.room.status === 'archived' && !options.allowArchived) {
    throw apiError('room_archived', 'This room has been archived.');
  }

  const { room, ...rest } = enrollment;
  return { room, enrollment: rest as Enrollment };
}

/**
 * Resolves an enrolment the acting educator is allowed to touch. Takes the room
 * from the path rather than trusting an enrolment ID alone, so a valid ID from
 * another room cannot be used to reach across.
 */
export async function requireEnrollmentInRoom(
  roomId: string,
  enrollmentId: string,
): Promise<Enrollment> {
  const enrollment = await prisma.enrollment.findUnique({ where: { id: enrollmentId } });
  if (!enrollment || enrollment.roomId !== roomId) {
    throw apiError('not_found', 'Not found.');
  }
  return enrollment;
}
