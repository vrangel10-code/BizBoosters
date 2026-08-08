-- Emails and student login IDs are normalized to lowercase by
-- normalizeIdentifier() on every read and write. These constraints make that a
-- guarantee rather than a convention: a code path that forgets to normalize
-- fails loudly here instead of quietly creating a case-duplicate account that
-- can never log in.

ALTER TABLE "users"
  ADD CONSTRAINT "users_email_lowercase"
  CHECK ("email" IS NULL OR "email" = lower("email"));

ALTER TABLE "users"
  ADD CONSTRAINT "users_login_id_lowercase"
  CHECK ("login_id" IS NULL OR "login_id" = lower("login_id"));

ALTER TABLE "educator_invitations"
  ADD CONSTRAINT "educator_invitations_email_lowercase"
  CHECK ("email" = lower("email"));

-- Identity shape per role: educators authenticate by email, students by login
-- ID, and neither may hold the other's identifier.
ALTER TABLE "users"
  ADD CONSTRAINT "users_identity_matches_role"
  CHECK (
    (role = 'student'      AND "login_id" IS NOT NULL AND "email" IS NULL)
    OR
    (role <> 'student'     AND "email" IS NOT NULL AND "login_id" IS NULL)
  );

-- At most one live invitation per address per school; re-inviting revokes the
-- previous one first (see createInvitation).
CREATE UNIQUE INDEX "educator_invitations_one_live_per_email"
  ON "educator_invitations" ("school_id", "email")
  WHERE "accepted_at" IS NULL AND "revoked_at" IS NULL;
