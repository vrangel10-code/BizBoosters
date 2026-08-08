import { previewInvitation, type InvitationPreview } from '@/server/services/invitations';
import { ApiError } from '@/server/errors';
import AcceptInvitationForm from './accept-form';

export const dynamic = 'force-dynamic';

type PreviewResult =
  | { ok: true; invitation: InvitationPreview }
  | { ok: false; message: string };

/**
 * The try/catch wraps only the lookup, never the JSX. React renders the
 * returned tree after this function has already returned, so JSX built inside
 * a catch scope is not actually protected by it — the catch would swallow
 * lookup failures while render failures escaped regardless.
 */
async function loadInvitation(token: string): Promise<PreviewResult> {
  try {
    return { ok: true, invitation: await previewInvitation(token) };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof ApiError ? error.message : 'This invitation link is not valid.',
    };
  }
}

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const result = await loadInvitation(token);

  if (!result.ok) {
    return (
      <main className="shell">
        <h1>Invitation unavailable</h1>
        <div className="panel">
          <p className="alert error" role="alert">
            {result.message}
          </p>
          <p className="hint">
            Invitations last 7 days and work once. Ask your administrator to send a new one.
          </p>
        </div>
      </main>
    );
  }

  const { invitation } = result;
  const roleLabel = invitation.role === 'school_admin' ? 'an administrator' : 'an educator';

  return (
    <main className="shell">
      <h1>Join {invitation.schoolName}</h1>
      <p className="lede">
        You were invited as {roleLabel}. Set a password to activate{' '}
        <strong>{invitation.email}</strong>.
      </p>
      <AcceptInvitationForm token={token} />
    </main>
  );
}
