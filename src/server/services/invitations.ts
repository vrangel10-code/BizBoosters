import { randomBytes } from 'node:crypto';
import type { EducatorInvitation, InvitationRole, User } from '@prisma/client';
import { prisma } from '../db';
import { apiError } from '../errors';
import { normalizeIdentifier } from '../auth/identifiers';
import { hashPassword, assertPasswordAllowed } from '../auth/password';
import { hashToken, createSession } from '../auth/session';
import { enforceRateLimit } from '../auth/rate-limit';
import { appUrl, getMailer } from '../mailer';
import { recordAudit } from './audit';

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const invitationLink = (token: string) => `${appUrl()}/invite/${token}`;

async function sendInvitationEmail(params: {
  to: string;
  schoolName: string;
  inviterName: string;
  role: InvitationRole;
  token: string;
  expiresAt: Date;
}): Promise<void> {
  const roleLabel = params.role === 'school_admin' ? 'administrator' : 'educator';
  await getMailer().send({
    to: params.to,
    subject: `You have been invited to BizBoosters (${params.schoolName})`,
    text: [
      `${params.inviterName} has invited you to join ${params.schoolName} on BizBoosters as an ${roleLabel}.`,
      '',
      'Set your password and activate your account here:',
      invitationLink(params.token),
      '',
      `This link works once and expires on ${params.expiresAt.toUTCString()}.`,
      'If you were not expecting this invitation you can ignore it.',
    ].join('\n'),
  });
}

export interface CreateInvitationInput {
  actor: User;
  schoolId: string;
  email: string;
  role: InvitationRole;
  ip: string;
}

/**
 * Educators exist by invitation only — there is no signup route. Re-inviting a
 * pending address revokes the previous invitation, so exactly one live token
 * per address is ever outstanding.
 */
export async function createInvitation({
  actor,
  schoolId,
  email,
  role,
  ip,
}: CreateInvitationInput): Promise<{ invitation: EducatorInvitation; token: string }> {
  const normalizedEmail = normalizeIdentifier(email);

  const existingUser = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  if (existingUser) {
    throw apiError('email_in_use', 'Someone already has an account with that email.');
  }

  const school = await prisma.school.findUnique({ where: { id: schoolId } });
  if (!school) throw apiError('not_found', 'Not found.');

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);

  const invitation = await prisma.$transaction(async (tx) => {
    await tx.educatorInvitation.updateMany({
      where: { schoolId, email: normalizedEmail, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    const created = await tx.educatorInvitation.create({
      data: {
        schoolId,
        email: normalizedEmail,
        role,
        tokenHash: hashToken(token),
        invitedBy: actor.id,
        expiresAt,
      },
    });

    await recordAudit(
      {
        action: 'admin.invitation_created',
        actorUserId: actor.id,
        payload: { email: normalizedEmail, role, invitation_id: created.id },
        ip,
      },
      tx,
    );

    return created;
  });

  await sendInvitationEmail({
    to: normalizedEmail,
    schoolName: school.name,
    inviterName: actor.displayName,
    role,
    token,
    expiresAt,
  });

  return { invitation, token };
}

export interface InvitationPreview {
  email: string;
  role: InvitationRole;
  schoolName: string;
  expiresAt: Date;
}

/** Validates a token before rendering the accept form. */
export async function previewInvitation(token: string): Promise<InvitationPreview> {
  const invitation = await prisma.educatorInvitation.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { school: true },
  });

  if (!invitation || invitation.revokedAt) {
    throw apiError('invitation_invalid', 'This invitation link is not valid.');
  }
  if (invitation.acceptedAt) {
    throw apiError('invitation_already_accepted', 'This invitation has already been used.');
  }
  if (invitation.expiresAt.getTime() <= Date.now()) {
    throw apiError('invitation_expired', 'This invitation has expired. Ask for a new one.');
  }

  return {
    email: invitation.email,
    role: invitation.role,
    schoolName: invitation.school.name,
    expiresAt: invitation.expiresAt,
  };
}

export interface AcceptInvitationInput {
  token: string;
  displayName: string;
  password: string;
  ip: string;
  userAgent?: string | null;
}

/**
 * Redeeming the token proves control of the mailbox, so it doubles as email
 * verification — there is no separate verify step. The email on the invitation
 * is authoritative; the invitee cannot substitute another.
 */
export async function acceptInvitation({
  token,
  displayName,
  password,
  ip,
  userAgent,
}: AcceptInvitationInput): Promise<{ user: User; sessionToken: string; expiresAt: Date }> {
  await enforceRateLimit({ key: `invite-accept:ip:${ip}`, limit: 20, windowMs: 15 * 60 * 1000 });

  const invitation = await prisma.educatorInvitation.findUnique({
    where: { tokenHash: hashToken(token) },
  });

  if (!invitation || invitation.revokedAt) {
    throw apiError('invitation_invalid', 'This invitation link is not valid.');
  }
  if (invitation.acceptedAt) {
    throw apiError('invitation_already_accepted', 'This invitation has already been used.');
  }
  if (invitation.expiresAt.getTime() <= Date.now()) {
    throw apiError('invitation_expired', 'This invitation has expired. Ask for a new one.');
  }

  assertPasswordAllowed({
    password,
    isStudent: false,
    forbidden: [invitation.email, displayName],
  });

  const passwordHash = await hashPassword(password);

  const user = await prisma.$transaction(async (tx) => {
    // Re-check inside the transaction: two tabs submitting the same link must
    // not both create an account.
    const claimed = await tx.educatorInvitation.updateMany({
      where: { id: invitation.id, acceptedAt: null, revokedAt: null },
      data: { acceptedAt: new Date() },
    });
    if (claimed.count === 0) {
      throw apiError('invitation_already_accepted', 'This invitation has already been used.');
    }

    const taken = await tx.user.findUnique({ where: { email: invitation.email } });
    if (taken) {
      throw apiError('email_in_use', 'Someone already has an account with that email.');
    }

    const createdUser = await tx.user.create({
      data: {
        schoolId: invitation.schoolId,
        role: invitation.role,
        displayName: displayName.trim(),
        email: invitation.email,
        passwordHash,
        mustChangePassword: false,
      },
    });

    await tx.educatorInvitation.update({
      where: { id: invitation.id },
      data: { acceptedBy: createdUser.id },
    });

    await recordAudit(
      {
        action: 'admin.invitation_accepted',
        actorUserId: createdUser.id,
        targetUserId: createdUser.id,
        payload: { invitation_id: invitation.id, role: invitation.role },
        ip,
      },
      tx,
    );

    return createdUser;
  });

  const session = await createSession({ userId: user.id, role: user.role, ip, userAgent });
  return { user, sessionToken: session.token, expiresAt: session.expiresAt };
}

export async function revokeInvitation(actor: User, id: string, ip: string): Promise<void> {
  const invitation = await prisma.educatorInvitation.findUnique({ where: { id } });
  if (!invitation || invitation.schoolId !== actor.schoolId) {
    throw apiError('not_found', 'Not found.');
  }
  if (invitation.acceptedAt) {
    throw apiError('invitation_already_accepted', 'That invitation has already been used.');
  }

  await prisma.educatorInvitation.update({
    where: { id },
    data: { revokedAt: new Date() },
  });

  await recordAudit({
    action: 'admin.invitation_revoked',
    actorUserId: actor.id,
    payload: { invitation_id: id, email: invitation.email },
    ip,
  });
}

/** Resending rotates the token rather than re-mailing the old one. */
export async function resendInvitation(
  actor: User,
  id: string,
  ip: string,
): Promise<{ token: string }> {
  const invitation = await prisma.educatorInvitation.findUnique({
    where: { id },
    include: { school: true },
  });
  if (!invitation || invitation.schoolId !== actor.schoolId) {
    throw apiError('not_found', 'Not found.');
  }
  if (invitation.acceptedAt) {
    throw apiError('invitation_already_accepted', 'That invitation has already been used.');
  }

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);

  await prisma.educatorInvitation.update({
    where: { id },
    data: { tokenHash: hashToken(token), expiresAt, revokedAt: null },
  });

  await sendInvitationEmail({
    to: invitation.email,
    schoolName: invitation.school.name,
    inviterName: actor.displayName,
    role: invitation.role,
    token,
    expiresAt,
  });

  await recordAudit({
    action: 'admin.invitation_resent',
    actorUserId: actor.id,
    payload: { invitation_id: id, email: invitation.email },
    ip,
  });

  return { token };
}
