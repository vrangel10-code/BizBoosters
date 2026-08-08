# Runbook

## Local development

```bash
cp .env.example .env          # DATABASE_URL points at the compose service
docker compose up -d          # Postgres 16 on :5432
pnpm install
pnpm prisma migrate deploy    # or `pnpm db:migrate` when changing the schema
pnpm dev                      # http://localhost:3000
```

### Create the first administrator

**A fresh deployment has no way in until you run this.** Every educator account
comes from an invitation, and an invitation needs an admin to send it, so the
first admin is created out of band:

```bash
pnpm admin:create --school "Northgate High" --email head@northgate.edu --name "Sam Okafor"
```

Omit `--password` and one is generated, printed once, and flagged for change at
first login. Run it interactively with no arguments to be prompted instead.

This is the only account that exists outside the invitation flow. Run it once
per environment, at setup, and record where you ran it.

### Sending invitations in development

`MAIL_TRANSPORT=console` prints every email to the server log rather than
sending it. The invitation link is in that output:

```
─── email ───────────────────────────────
to:      alex@northgate.edu
subject: You have been invited to BizBoosters (Northgate High)

Set your password and activate your account here:
http://localhost:3000/invite/AkxIS1cxT8qg...
```

Open the link to redeem it. Nothing leaves the machine.

## Verification

```bash
pnpm typecheck
pnpm lint
pnpm test        # against a real Postgres; see below
pnpm build
```

CI runs all four on every push (`.github/workflows/ci.yml`), plus a
`prisma migrate diff` that fails when the committed migrations no longer
reproduce `schema.prisma` — the check that catches a schema edited without a
migration.

### Tests need a real database

Tests run against Postgres, never a mock, and the harness refuses any
`DATABASE_URL` whose database name does not contain `test`:

```bash
createdb bizboosters_test
DATABASE_URL="postgresql://.../bizboosters_test" pnpm test
```

This matters more later than it does now: phase 3's draw transaction is
behaviour only a real database exhibits — row locks, constraint violations,
concurrent decrements — so the harness is in place before the code that needs
it.

## Migrations

```bash
pnpm db:migrate --name what_changed   # develop: creates + applies
pnpm db:deploy                        # staging/production: applies only
pnpm db:status                        # what has been applied where
```

Forward-only. Run `db:deploy` in CI **before** the new app version rolls, and
snapshot the database first — a bad migration against a live classroom destroys
student inventories mid-lesson.

## Operational notes

**Unlocking an account.** Ten consecutive failed logins locks an account for 15
minutes. An educator resetting the student's password clears the lock as a side
effect, which is the intended path — students who are locked out have usually
forgotten the password anyway.

```
POST /api/v1/students/:id/reset-password
```

**Forcing a sign-out.** Sessions are server-side rows, so revoking works
immediately and everywhere. A password change revokes every session except the
one performing it; a password reset revokes all of them.

**Rate limits** live in the `rate_limits` table, not in process memory, so they
hold across instances and on serverless. Old windows are dead weight — prune
them periodically with `pruneRateLimits()`.

**Session lifetimes** are 2 hours for students and 12 hours for educators,
sliding on activity. Student devices are shared; there is deliberately no
"remember me".

## Environment variables

| Name | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres connection string. |
| `APP_URL` | yes in production | Public origin; builds invitation links. |
| `SESSION_COOKIE_NAME` | no | Defaults to `bb_session`. |
| `MAIL_TRANSPORT` | no | `console` (default) or `smtp`. |
| `SMTP_*` | when `MAIL_TRANSPORT=smtp` | Host, port, credentials, from address. |

Secrets come from the environment only. Nothing sensitive belongs in the repo.
