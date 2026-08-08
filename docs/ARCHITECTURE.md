# Architecture

## 1. Recommended stack

One recommendation, not a survey. This is a classroom tool with maybe a few
hundred concurrent users at peak, run by one or two people, and it must be cheap
and boring to operate.

| Layer | Choice | Why |
| --- | --- | --- |
| App | **Next.js (App Router, TypeScript)** | One deployable unit serving both the educator and student SPAs plus the API. No CORS, no separate frontend deploy. |
| API | **Next.js Route Handlers** under `/api/v1/*` | Plain REST. Keep business logic in `src/server/services/*`, not in route files, so it is testable and reusable from jobs/scripts. |
| DB | **PostgreSQL** (Neon or Supabase) | The core mechanic is "decrement a shared counter and hand out an item, exactly once." That is a transaction. Do not use a document store for the deck. |
| ORM | **Prisma** | Migrations, typed queries. Drop to raw SQL for the draw transaction. |
| Auth | **Custom session cookies** (Argon2id + server-side session table) | Students log in with an assigned ID, not an email. Off-the-shelf auth libraries fight you on that, and you need educator-initiated password resets and force-logout. |
| Realtime | **SSE** (`/api/v1/stream`) with polling fallback | Notifications are server→client only. SSE is one endpoint and survives proxies; WebSockets buy nothing here. |
| Images | **Cloudflare R2 or S3 + CDN** | See §6. Google Drive links must go. |
| Hosting | **Vercel** (app) + **Neon** (Postgres) + **R2** (images) | Or a single Railway/Fly container if you prefer one bill. |
| Jobs | A single cron route (`/api/v1/cron/*`) | Digest emails, session cleanup, archive sweeps. |

**Alternative worth considering:** Supabase gives Postgres + storage + realtime
+ row-level security in one product, and its Realtime subscriptions would let
the student deck view update live with little code. The cost is that you inherit
its auth model, which does not fit assigned-ID student logins without work. If
you want the least infrastructure, take Supabase for DB + storage + realtime and
still run your own auth on top of it.

**Do not** build this on Firestore the way the prototype does. Firestore has no
multi-document transaction ergonomics that make "decrement the shared deck and
grant the card" pleasant, and its security rules cannot express your
authorization rules (is this student enrolled in this room, does this educator
own this room) without a lot of denormalized duplication.

## 2. Application shape

```
bizboosters/
├─ src/
│  ├─ app/
│  │  ├─ (public)/login/            # role-detecting login
│  │  ├─ (student)/
│  │  │  ├─ rooms/                  # room picker
│  │  │  └─ rooms/[roomId]/
│  │  │     ├─ page.tsx             # overview: tokens, live odds
│  │  │     ├─ inventory/
│  │  │     ├─ draw/                # the lootbox, ported from the prototype
│  │  │     └─ history/
│  │  ├─ (educator)/
│  │  │  ├─ rooms/                  # room list + create
│  │  │  └─ rooms/[roomId]/
│  │  │     ├─ students/            # roster, token award, inventory drill-down
│  │  │     ├─ deck/                # card pool configuration
│  │  │     ├─ uses/               # recent card uses + acknowledgement ticks
│  │  │     └─ activity/            # room activity log
│  │  ├─ (admin)/cards/             # school-wide card catalog
│  │  └─ api/v1/…
│  ├─ server/
│  │  ├─ services/                  # draw.ts, tokens.ts, cards.ts, rooms.ts …
│  │  ├─ repositories/              # Prisma/SQL access
│  │  ├─ auth/                      # session, password, guards
│  │  └─ events/                    # activity log + notification fan-out
│  ├─ components/                   # shared UI (card art, rarity chrome, modals)
│  └─ lib/
├─ prisma/schema.prisma
└─ tests/
```

**Layering rule:** route handler → service → repository. Route handlers do
authn/authz, input validation (zod), and serialization. Nothing else. Every
mutation goes through a service that owns its transaction and emits its activity
event, so there is exactly one place that can change the deck.

## 3. Roles and authorization

Four roles:

- **student** — belongs to a school, enrolled in 0..n rooms.
- **educator** — owns/co-teaches 0..n rooms, manages rosters and the card
  catalog for their school.
- **school_admin** — manages educators, sees all rooms, owns the shared card
  catalog. In a single-teacher deployment this is the same person as the
  educator; keep the role anyway so you never have to retrofit it.
- **super_admin** — you. Cross-school support and maintenance.

Authorization is enforced in one place, on every request, from three questions:

1. Is there a valid session? (else 401)
2. Does the actor have a relationship to the **room** in the path — an active
   enrollment, or an entry in `room_educators`? (else 404, not 403 — do not leak
   room existence)
3. Does the action's role requirement hold? (else 403)

Never accept `studentId` from a student's request body. The acting enrollment is
derived from the session plus the room in the path.

## 4. Authentication

### Educators — invitation only
**There is no public signup route.** `POST /auth/signup` does not exist, for any
role. A `school_admin` invites an educator by email; the invitation carries a
single-use token, and the invitee sets their own password when redeeming it.
Email + password thereafter (Argon2id, `memoryCost` ≥ 19 MiB, per OWASP), with
self-service reset by emailed token.

Invitation rules:

- Single-use, expiring (default 7 days), revocable before acceptance, and
  resendable — which rotates the token rather than re-mailing the old one.
- Redeeming proves control of the mailbox, so it doubles as email verification.
  No separate verification step.
- Only a `school_admin` may invite, and only within their own school. An
  educator cannot invite a peer; that is the point of the decision.
- Accepting binds the new user to the inviting school. The email on the
  invitation is authoritative — the invitee cannot substitute a different one.

**Bootstrapping:** the first `school_admin` of a school cannot be invited by
anyone, so it is created out-of-band by a CLI command (`pnpm admin:create`)
run by you against the target environment. Name this explicitly in the runbook;
it is the one account that exists outside the invitation flow, and forgetting it
is how you end up with an unreachable production deployment.

Optional Google OAuth later — most teachers already have a Google Workspace
account, and it removes a password from your threat surface. It would sit behind
the same invitation gate: the invitation is what authorizes the account, OAuth
only replaces the password.

### Students
Students get an assigned **login ID** (e.g. `apex-4821` or the school's student
number — configurable per school) and a **randomly generated default password**.
Design points that matter in practice:

- The default password is generated per student, shown to the educator **once**
  at roster creation, and available as a printable/CSV slip. Never a shared
  constant like `bizboosters123` — one leaked slip would compromise the class.
- `users.must_change_password = true` on creation. The session is created on
  first login but **every API route except `POST /auth/change-password` returns
  `403 password_change_required`** until it is cleared. Gating this in the UI
  only is not enough.
- Educators can reset a student's password, which regenerates a default and
  re-sets the flag. Students *will* forget passwords weekly; make this two
  clicks.
- No email required for students. This keeps you out of a large amount of
  child-privacy scope (see §8).
- Password rules for students: minimum 8 characters, blocklist the default and
  the student's own login ID, and nothing else. Complexity rules on 12-year-olds
  produce sticky notes.

### Sessions
Server-side session table, opaque 256-bit token, `httpOnly; Secure; SameSite=Lax`
cookie. Rationale over JWTs: educators need to force-logout a student from a
shared Chromebook, and you need to invalidate every session on password reset.

- Educator idle timeout: 12 hours. Student idle timeout: **2 hours**, no
  "remember me" — student devices are shared.
- Rate limit `POST /auth/login` per IP and per login ID; lock after 10 failures
  with educator-side unlock.

## 5. Realtime and notifications

Notifications are **rows first, transport second**. Every notification is
persisted in `notifications` inside the same transaction as the action that
caused it. Delivery is best-effort on top.

```
Student draws a card
  └─ draw service (single tx)
       ├─ decrement room_cards
       ├─ debit tokens + ledger row
       ├─ insert inventory_item
       ├─ insert activity_event(room)
       └─ insert notification(each room educator)
  └─ after commit: publish to SSE bus
```

- `GET /api/v1/stream` — an SSE stream scoped to the session. Sends
  `notification`, `room.pool_changed`, and `heartbeat` events.
- The client keeps an unread badge from `GET /notifications?unread=true` and
  reconciles on reconnect using `Last-Event-ID`, so a dropped connection cannot
  lose a notification.
- Fallback: if `EventSource` fails twice, poll `GET /notifications` every 20s.
- Single-instance in-process pub/sub is fine to start. If you scale past one
  instance, put Postgres `LISTEN/NOTIFY` (not Redis — you already have Postgres)
  behind the same interface.

`room.pool_changed` is what makes "the deck is shared" visible: when any student
draws, everyone else's odds panel updates live. That is the single most
motivating piece of realtime in the product — prioritize it over the
notification toasts.

## 6. Card images

The prototype hotlinks Google Drive and rewrites URLs to
`drive.google.com/thumbnail?id=…`. That has to go: Drive throttles, blocks
hotlinking unpredictably (hence the `onerror` "Image Blocked by Drive"
placeholder already in the code), serves no cache headers you control, and makes
every card image a public URL forever.

Replace with: educator uploads → server validates (MIME sniff, max 5 MB, images
only) → store original in R2/S3 → generate 3 derivatives (thumb 160w, card 400w,
full 800w) via `sharp` → serve through the CDN with long cache TTLs and a
content-hashed key. Store `image_key` in the DB, not a URL, so you can move
buckets without a data migration.

## 7. Deployment

- **Environments:** `dev` (local Docker Postgres), `staging`, `production`.
  Staging matters here because a bad migration on a live classroom deck destroys
  student inventories mid-lesson.
- **Migrations:** Prisma Migrate, forward-only, run in CI before the app rolls.
- **Backups:** daily automated Postgres backup with 30-day retention, plus a
  pre-migration snapshot. Test a restore once before you go live.
- **Config:** all secrets from env (`DATABASE_URL`, `SESSION_SECRET`,
  `R2_*`, `SMTP_*`). Nothing in the repo.
- **Observability:** Sentry for errors; structured request logs with
  `request_id`, `user_id`, `room_id`; an alert on failed draw transactions,
  which is your canary for pool corruption.
- **Rate limits:** global per-IP, plus per-user limits on draw (10/min), login,
  and password change.
- **Health:** `GET /api/v1/health` checking DB connectivity for the platform's
  probe.

## 8. Privacy and compliance

Your users are minors. This is not optional polish; it constrains the schema.

- **Data minimization.** Store display name, login ID, and room membership.
  Nothing else. No student email, no DOB, no photos, no free-text profile.
- **US:** FERPA (the school is the data controller; you are a school official
  acting under its direction — you will need a DPA) and COPPA (under-13; consent
  is obtained by the school, which requires you not to use the data for
  anything but the service — so no analytics SDKs on student pages, no ads,
  ever).
- **EU/UK:** GDPR Article 8. **Singapore:** PDPA. Same practical answer:
  minimize, document, delete on request.
- **Retention:** archive rooms at term end; hard-delete archived rooms and their
  inventories after a configurable period (default 18 months). Provide an
  educator-triggered export (CSV/JSON) and a school-level delete.
- **No leaderboards across students by default.** Public token rankings for
  minors are a safeguarding conversation, not a feature toggle you turn on
  without asking. Make it opt-in per room and off by default.
- **Audit log** of every educator action on a student (token award/adjustment,
  password reset, removal) — this protects the educator as much as the student.
