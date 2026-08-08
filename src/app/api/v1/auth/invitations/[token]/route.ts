import { previewInvitation } from '@/server/services/invitations';
import { handle, json } from '@/server/http';

export const dynamic = 'force-dynamic';

/** Validate an invitation before rendering the accept form. */
export const GET = handle(
  async (_request: Request, context: { params: Promise<{ token: string }> }) => {
    const { token } = await context.params;
    const preview = await previewInvitation(token);

    return json({
      email: preview.email,
      role: preview.role,
      school_name: preview.schoolName,
      expires_at: preview.expiresAt.toISOString(),
    });
  },
);
