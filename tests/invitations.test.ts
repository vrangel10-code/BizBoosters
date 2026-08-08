import { beforeEach, afterAll, describe, expect, it } from 'vitest';
import type { School, User } from '@prisma/client';
import { prisma, resetDatabase, createSchool, seedUser, testIp } from './helpers';
import {
  acceptInvitation,
  createInvitation,
  previewInvitation,
  resendInvitation,
  revokeInvitation,
} from '../src/server/services/invitations';
import { MemoryMailer, setMailer } from '../src/server/mailer';
import { ApiError } from '../src/server/errors';
import { login } from '../src/server/services/auth-service';

let school: School;
let admin: User;
let mailer: MemoryMailer;

/** The emailed link is the only place the raw token exists. */
const tokenFromLastEmail = (): string => {
  const email = mailer.sent.at(-1);
  if (!email) throw new Error('No invitation email was sent.');
  const match = email.text.match(/\/invite\/([A-Za-z0-9_-]+)/);
  if (!match?.[1]) throw new Error(`No invitation link in email:\n${email.text}`);
  return match[1];
};

beforeEach(async () => {
  await resetDatabase();
  school = await createSchool();
  admin = await seedUser({
    schoolId: school.id,
    role: 'school_admin',
    email: 'head@school.edu',
    displayName: 'Sam Okafor',
    password: 'correct-horse-battery',
  });
  mailer = new MemoryMailer();
  setMailer(mailer);
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

const invite = (email = 'newteacher@school.edu') =>
  createInvitation({ actor: admin, schoolId: school.id, email, role: 'educator', ip: testIp });

describe('createInvitation', () => {
  it('emails a link and never returns the token in the record', async () => {
    const { invitation } = await invite();

    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.to).toBe('newteacher@school.edu');
    expect(mailer.sent[0]!.text).toContain('/invite/');
    expect(invitation.tokenHash).not.toContain(tokenFromLastEmail());
  });

  it('normalizes the email address', async () => {
    const { invitation } = await invite('  NewTeacher@School.edu ');
    expect(invitation.email).toBe('newteacher@school.edu');
  });

  it('refuses an address that already has an account', async () => {
    await expectApiError(invite('head@school.edu'), 'email_in_use');
  });

  it('revokes the previous invitation when re-inviting', async () => {
    await invite();
    const firstToken = tokenFromLastEmail();

    await invite();
    const secondToken = tokenFromLastEmail();

    await expectApiError(previewInvitation(firstToken), 'invitation_invalid');
    await expect(previewInvitation(secondToken)).resolves.toMatchObject({
      email: 'newteacher@school.edu',
    });
  });
});

describe('previewInvitation', () => {
  it('describes a live invitation', async () => {
    await invite();
    await expect(previewInvitation(tokenFromLastEmail())).resolves.toMatchObject({
      email: 'newteacher@school.edu',
      role: 'educator',
      schoolName: school.name,
    });
  });

  it('rejects unknown, revoked and expired tokens', async () => {
    await expectApiError(previewInvitation('nonsense'), 'invitation_invalid');

    const { invitation } = await invite();
    const token = tokenFromLastEmail();

    await prisma.educatorInvitation.update({
      where: { id: invitation.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await expectApiError(previewInvitation(token), 'invitation_expired');

    await prisma.educatorInvitation.update({
      where: { id: invitation.id },
      data: { revokedAt: new Date(), expiresAt: new Date(Date.now() + 60_000) },
    });
    await expectApiError(previewInvitation(token), 'invitation_invalid');
  });
});

describe('acceptInvitation', () => {
  it('creates an active educator who can sign in immediately', async () => {
    await invite();
    const token = tokenFromLastEmail();

    const { user } = await acceptInvitation({
      token,
      displayName: 'Alex Rivera',
      password: 'a-good-long-password',
      ip: testIp,
    });

    expect(user.role).toBe('educator');
    expect(user.email).toBe('newteacher@school.edu');
    expect(user.schoolId).toBe(school.id);
    // Educators choose their own password, so nothing to force on first login.
    expect(user.mustChangePassword).toBe(false);

    const signedIn = await login({
      identifier: 'newteacher@school.edu',
      password: 'a-good-long-password',
      ip: testIp,
    });
    expect(signedIn.user.id).toBe(user.id);
  });

  it('binds the account to the invited address, not one the invitee picks', async () => {
    await invite();
    const { user } = await acceptInvitation({
      token: tokenFromLastEmail(),
      displayName: 'Alex Rivera',
      password: 'a-good-long-password',
      ip: testIp,
    });
    expect(user.email).toBe('newteacher@school.edu');
  });

  it('works exactly once', async () => {
    await invite();
    const token = tokenFromLastEmail();

    await acceptInvitation({
      token,
      displayName: 'Alex Rivera',
      password: 'a-good-long-password',
      ip: testIp,
    });

    await expectApiError(
      acceptInvitation({
        token,
        displayName: 'Impostor',
        password: 'another-long-password',
        ip: testIp,
      }),
      'invitation_already_accepted',
    );

    expect(await prisma.user.count({ where: { email: 'newteacher@school.edu' } })).toBe(1);
  });

  it('creates only one account when the same link is submitted concurrently', async () => {
    await invite();
    const token = tokenFromLastEmail();

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        acceptInvitation({
          token,
          displayName: 'Alex Rivera',
          password: 'a-good-long-password',
          ip: testIp,
        }),
      ),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.user.count({ where: { email: 'newteacher@school.edu' } })).toBe(1);
  });

  it('enforces the educator password floor', async () => {
    await invite();
    await expectApiError(
      acceptInvitation({
        token: tokenFromLastEmail(),
        displayName: 'Alex Rivera',
        password: 'short',
        ip: testIp,
      }),
      'weak_password',
    );
  });

  it('refuses an expired invitation', async () => {
    const { invitation } = await invite();
    const token = tokenFromLastEmail();
    await prisma.educatorInvitation.update({
      where: { id: invitation.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await expectApiError(
      acceptInvitation({
        token,
        displayName: 'Alex Rivera',
        password: 'a-good-long-password',
        ip: testIp,
      }),
      'invitation_expired',
    );
  });
});

describe('revoke and resend', () => {
  it('revoking kills the link', async () => {
    const { invitation } = await invite();
    const token = tokenFromLastEmail();

    await revokeInvitation(admin, invitation.id, testIp);
    await expectApiError(previewInvitation(token), 'invitation_invalid');
  });

  it('resending rotates the token, invalidating the old link', async () => {
    const { invitation } = await invite();
    const oldToken = tokenFromLastEmail();

    await resendInvitation(admin, invitation.id, testIp);
    const newToken = tokenFromLastEmail();

    expect(newToken).not.toBe(oldToken);
    await expectApiError(previewInvitation(oldToken), 'invitation_invalid');
    await expect(previewInvitation(newToken)).resolves.toMatchObject({ email: 'newteacher@school.edu' });
  });

  it('will not touch another school’s invitation', async () => {
    const otherSchool = await createSchool('Southgate High');
    const otherAdmin = await seedUser({
      schoolId: otherSchool.id,
      role: 'school_admin',
      email: 'other@southgate.edu',
      password: 'correct-horse-battery',
    });
    const { invitation } = await invite();

    await expectApiError(revokeInvitation(otherAdmin, invitation.id, testIp), 'not_found');
    await expectApiError(resendInvitation(otherAdmin, invitation.id, testIp), 'not_found');
  });
});
