import { createInvitationSchema } from '@/lib/validation';
import { requireAdmin, requireSchoolScope } from '@/server/auth/guard';
import { createInvitation } from '@/server/services/invitations';
import { prisma } from '@/server/db';
import { clientIp, created, handle, json, parseBody } from '@/server/http';

export const dynamic = 'force-dynamic';

export const GET = handle(async (_request: Request) => {
  const { user } = await requireAdmin();
  const schoolId = requireSchoolScope(user);

  const invitations = await prisma.educatorInvitation.findMany({
    where: { schoolId },
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: {
      id: true,
      email: true,
      role: true,
      expiresAt: true,
      acceptedAt: true,
      revokedAt: true,
      createdAt: true,
    },
  });

  return json({
    data: invitations.map((invitation) => ({
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      status: invitation.acceptedAt
        ? 'accepted'
        : invitation.revokedAt
          ? 'revoked'
          : invitation.expiresAt.getTime() <= Date.now()
            ? 'expired'
            : 'pending',
      expires_at: invitation.expiresAt.toISOString(),
      created_at: invitation.createdAt.toISOString(),
    })),
  });
});

export const POST = handle(async (request: Request) => {
  const { user } = await requireAdmin();
  const schoolId = requireSchoolScope(user);
  const body = await parseBody(request, createInvitationSchema);

  const { invitation } = await createInvitation({
    actor: user,
    schoolId,
    email: body.email,
    role: body.role,
    ip: clientIp(request),
  });

  // The token is emailed, never returned: an API response is a far easier place
  // to leak it from than a mailbox.
  return created({
    invitation: {
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      expires_at: invitation.expiresAt.toISOString(),
    },
  });
});
