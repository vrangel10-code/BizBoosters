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

## Importing the starter deck

`seed/prototype-deck.json` holds the 20 cards and their copy counts (103 copies
total). To load them into a school's catalog, and optionally build a room's deck
from them:

```bash
pnpm deck:import                                 # catalog only
pnpm deck:import --room <room-id>                # and build the deck
pnpm deck:import --skip-images                   # names only, art later
```

Find the school id with `pnpm db:studio`, or from the output of
`pnpm admin:create`.

### Card art

There are three ways to get art onto a card. All three end in the same place —
processed into three sizes and recorded as `cards.image_key`.

**1. Commit the files to the repo (recommended for the starter deck).** Put the
images in `seed/images/` and commit them, then run the importer. Naming is
forgiving: a file matches if its name, ignoring case and punctuation, equals
either the card's name or its `ref` — `DJ for the Day.png`, `dj-for-the-day.jpg`
and `C1.png` all work. See `seed/images/README.md` for the full list.

**Committing the files is not enough on its own.** The app serves art from
object storage keyed by the database, so the importer has to process them once:

```bash
pnpm deck:import
```

Re-running is safe — cards that already have art are skipped, so you can add a
few images at a time.

**2. Upload from the app.** The card catalog page has an *Add art* / *Replace
art* button per card. This is the route for art that changes later, and the only
route educators have without repository access.

**3. Let the importer download from `source_url`.** Each card's Drive link is
tried when no local file matches. Drive throttles, blocks hotlinking
unpredictably, and returns an HTML page for files that are not publicly shared —
the importer detects that case and reports it rather than storing a web page as
a card image. Treat this as a convenience, not the plan.

A failed image never aborts the import: the deck works without art, and every
failure is listed with its reason.

## Where card art is stored

With no `S3_BUCKET` set, images are written to `STORAGE_DIR` (default
`./storage`) and served by the app at `/api/v1/images/...`. That is fine for
development and for a single long-lived server, and **wrong on serverless**,
where the filesystem is ephemeral and every deploy loses the art.

For production set the `S3_*` variables (see `.env.example`) to any
S3-compatible bucket — Cloudflare R2 is the cheap option. Set
`S3_PUBLIC_BASE_URL` as well and images are served straight from your CDN
instead of proxied through the app.

Each upload is stored in three sizes (160/400/800px wide) as WebP, keyed by a
hash of the original bytes, so re-uploading the same file costs nothing and the
year-long cache header is safe.

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

## Backups and restore

**Take backups with `pg_dump` in custom format** and keep them somewhere other
than the database host:

```bash
pg_dump "$DATABASE_URL" -Fc -f "bizboosters-$(date +%F).dump"
```

Managed providers (Neon, Supabase, RDS) also take their own automated backups —
use them, but keep an independent dump as well. A provider account problem takes
the provider's backups with it.

### Restore

```bash
createdb bizboosters_restored
pg_restore -d bizboosters_restored bizboosters-2026-08-08.dump
```

### The drill — run it before you go live

An untested backup is not a backup. This exact sequence has been run against
this schema and verified:

```bash
# 1. Record a checksum of something that must survive
psql "$DATABASE_URL" -tAc "SELECT md5(string_agg(t::text,'|' ORDER BY t::text))
  FROM (SELECT id, token_balance FROM enrollments) t"

# 2. Back up
pg_dump "$DATABASE_URL" -Fc -f drill.dump

# 3. Restore into a scratch database and compare the checksum
createdb bizboosters_drill
pg_restore -d bizboosters_drill drill.dump
psql bizboosters_drill -tAc "SELECT md5(string_agg(t::text,'|' ORDER BY t::text))
  FROM (SELECT id, token_balance FROM enrollments) t"

# 4. Confirm integrity survived
psql bizboosters_drill -tAc "SELECT count(*) FROM room_cards rc
  LEFT JOIN LATERAL (SELECT count(*) n FROM inventory_items i
    WHERE i.room_id=rc.room_id AND i.card_id=rc.card_id AND i.state='owned') h ON true
  WHERE rc.copies_remaining + COALESCE(h.n,0) <> rc.copies_total"   # must be 0
```

Checksums must match and the drift count must be zero. Losing a term of student
collections is unrecoverable in a way that matters to real children — do the
drill.

## Retention, exports and erasure

**Exports** (educator, self-service — no request to you needed):

| What | Where |
| --- | --- |
| Room activity, filtered, as CSV | Activity log → Download CSV |
| Per-student summary as CSV | Room page → Download student summary |
| Everything about one student, as JSON | `GET /api/v1/students/:id/export` |

The student export is what answers a subject-access request or a parent asking
what the school stores. It is deliberately complete: a partial export is worse
than none, because it implies a completeness it does not have.

**Erasure** really deletes — rows are removed, not flagged. Both paths require
typing the exact name to confirm:

- `POST /api/v1/students/:id/delete` — one student and all their history. Held
  cards are returned to their rooms' decks first, so erasing a student never
  leaves a deck permanently short.
- `POST /api/v1/rooms/:roomId/delete` — an archived room. Student *accounts*
  survive; they may be in other rooms.

A deleted student may still exist in backups until those age out. Say so when
answering an erasure request.

**Nightly retention sweep** at `/api/v1/cron/retention` (same `CRON_SECRET`)
prunes expired sessions and rate-limit windows automatically, and *reports*
archived rooms past `RETENTION_DAYS` (default 548). Expired rooms are never
deleted automatically — a job that silently erases a term of student work is not
something to run unattended.

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

**Realtime.** `GET /api/v1/stream` is server-sent events, scoped to the
session. It is an optimisation, not a guarantee: notifications are database
rows, and clients poll `/notifications` every 20s after two failed reconnects.
The pub/sub behind it is in-process, so on more than one instance a push only
reaches clients on the emitting instance — the cost is a slower badge, never a
lost notification. Swap `publish`/`subscribe` in `src/server/events/bus.ts` for
Postgres LISTEN/NOTIFY when a second instance appears.

Note that long-lived SSE connections do not work on most serverless platforms.
On Vercel the stream will disconnect and clients will fall back to polling,
which is correct but slower; a long-running container (Railway, Fly, a VM) gets
the live behaviour.

**Nightly reconciliation.** `GET /api/v1/cron/reconcile` runs both integrity
checks — card-copy conservation and token-balance-vs-ledger — and returns 500
when either drifts. Point a scheduler at it and alert on a non-200:

```
0 3 * * *  curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://…/api/v1/cron/reconcile
```

It is disabled unless `CRON_SECRET` is set, because an unauthenticated endpoint
that enumerates every room's integrity state is not something to leave open.
Drift is never repaired automatically: it means a transaction boundary is
wrong, and patching the number would hide the bug that produced it.

**Login rate limits** count *failures*, not attempts. Schools sit behind one
public IP, so a whole class signing in at the start of a lesson is normal
traffic — an attempt-counting limit locked out the 31st student in testing. The
volume limit (600 per IP per 5 min) is only a flood guard; the failure limits
(50 per IP, 20 per identifier) and per-account lockout do the real work.

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
| `CRON_SECRET` | for the nightly jobs | Bearer token for `/api/v1/cron/*`. Unset disables those routes. |
| `RETENTION_DAYS` | no | Archived-room review window. Default 548 (18 months). |
| `STORAGE_DIR` / `S3_*` | card art | See "Where card art is stored". |

Secrets come from the environment only. Nothing sensitive belongs in the repo.
