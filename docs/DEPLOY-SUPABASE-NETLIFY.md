# BizBoosters — Setup Guide (Supabase + Netlify)

This walks you through getting BizBoosters online: a live URL your students open
in a browser, a Postgres database that holds every room, token and card, and a
dashboard where you can query and export all of it.

**Time: about 90 minutes** the first time. **Cost: £0** on free tiers.

---

## Read this first — where this differs from the Capital Commander guide

The guide you sent was written for a single `index.html` file. That app had no
server: the browser talked straight to Supabase, Supabase Auth handled logins,
and deploying meant dragging one file onto Netlify. Thirty minutes, no terminal.

BizBoosters cannot work that way, and the reason is the whole point of the game.
The deck is **shared and finite** — when one student draws the last Legendary,
nobody else can draw it. A browser cannot be trusted to enforce that: whoever
holds the page holds the code, and thirty browsers all decrementing the same
counter will double-spend it within a lesson. So the draw happens on a server,
inside a database transaction that takes a lock on the room. That server is the
app, and it needs somewhere to run.

Practically, four things change:

| | Capital Commander | BizBoosters |
| --- | --- | --- |
| **What Supabase does** | Database **and** login **and** security rules | Database only — plain Postgres |
| **Logins** | Supabase Auth, students self-register with email | The app's own accounts; **you** create student IDs, no email needed |
| **Deploying** | Drag `index.html` onto Netlify | Connect the GitHub repo; Netlify builds it |
| **Setup tools** | A text editor | A terminal, for two commands, once |

The good news: because students never touch Supabase directly, there are no
Row-Level Security policies to get right, no anon key in your HTML, and no
`schema.sql` to paste — the schema is in the repo as migrations and one command
applies it.

The one thing you give up by choosing Netlify is covered in
[What you lose on Netlify](#what-you-lose-on-netlify). Read that section before
you start, not after.

### What you need before you begin

- A **GitHub account**, with this repository pushed to it (it already is).
- **Node 22** and **pnpm** on your own laptop —
  [nodejs.org](https://nodejs.org), then `npm install -g pnpm`. You need these
  for two commands: creating the database tables, and creating your own admin
  account. After that you never need a terminal again.
- About 90 minutes, uninterrupted, ideally not the morning of a class.

---

## The stack

| Component | Tool | Free tier |
| --- | --- | --- |
| Database | **Supabase** (Postgres 15+) | 500 MB, 2 projects |
| Hosting | **Netlify** (Next.js runtime) | 100 GB bandwidth, 125k function calls/mo |
| Card art | **Supabase Storage** | 1 GB |
| Nightly jobs | **Netlify Scheduled Functions** | included |

Everything you need is inside two accounts. There is no third bill.

---

## Part 1 — Supabase (the database)

### Step 1.1 — Create the project

1. Go to **[supabase.com](https://supabase.com)** and sign up (GitHub is fastest).
2. Click **New project**.
3. Fill in:
   - **Name:** `bizboosters`
   - **Database password:** generate a strong one and **save it in your password
     manager now**. Unlike the guide's app, you *will* need this — it is part of
     every connection string below. Supabase will not show it again.
   - **Region:** the one closest to your students —
     `Southeast Asia (Singapore)` for Malaysia.
4. Click **Create new project** and wait ~2 minutes.

> **Pick the region deliberately.** Every draw is a round trip from Netlify's
> function to this database. A database in Virginia and students in Kuala Lumpur
> adds ~250 ms to every click, which is the difference between the draw feeling
> instant and feeling broken. Also see the Netlify region note in Step 3.2.

### Step 1.2 — Collect the three connection strings

In the project, click **Connect** (top bar). You will see three strings. They
are **not interchangeable**, and choosing the wrong one is the single most
common way this deployment fails.

| String | Port | Use it for |
| --- | --- | --- |
| **Transaction pooler** | 6543 | The app running on Netlify |
| **Session pooler** | 5432 | Migrations and admin scripts from your laptop |
| **Direct connection** | 5432 | Nothing here — it is IPv6-only and most home and campus networks are not |

Copy both pooler strings into a scratch file and replace `[YOUR-PASSWORD]` with
the password from Step 1.1. Then **append this to the transaction pooler one**:

```
?pgbouncer=true&connection_limit=1
```

So you end up with two strings shaped like this (yours will differ — always
copy the real hostname from the dashboard, never retype it from here):

```
# For Netlify — the app
postgresql://postgres.YOUR-PROJECT-REF:YOUR-PASSWORD@aws-0-YOUR-REGION.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1

# For your laptop — migrations and admin
postgresql://postgres.YOUR-PROJECT-REF:YOUR-PASSWORD@aws-0-YOUR-REGION.pooler.supabase.com:5432/postgres
```

**Why two.** A Netlify function is short-lived and there may be forty of them at
once, so the app connects through the transaction pooler, which multiplexes
hundreds of clients onto a few real connections. That pooler cannot support the
session-level commands `prisma migrate` issues, so schema changes go through the
session pooler instead. `pgbouncer=true` tells Prisma to stop sending prepared
statements, which the transaction pooler cannot keep track of; leave it off and
the app works in testing and then throws
`prepared statement "s0" already exists` the moment a second student clicks
draw.

> A note on `connection_limit=1`: each function instance keeps a pool of one
> connection. That sounds tiny and is correct — the concurrency comes from
> having many function instances, and a larger per-instance pool just exhausts
> the pooler faster.

### Step 1.3 — Create the tables

> **Never used a terminal?** Do
> [Appendix A](#appendix-a--the-terminal-part-for-people-who-have-never-used-one)
> instead — it is this step written out click by click, and it also covers
> Part 4. Come back here when the tables exist.

Do **not** paste SQL into the SQL Editor. The schema is 19 tables with 12
integrity constraints, and it lives in the repo as versioned migrations so that
future changes apply cleanly instead of needing you to spot the difference.

On your laptop:

```bash
git clone https://github.com/vrangel10-code/bizboosters.git
cd bizboosters
git checkout claude/bizboosters-app-build-i1tzmb
pnpm install

# Use the SESSION pooler string here (port 5432)
DATABASE_URL="postgresql://postgres.YOUR-PROJECT-REF:YOUR-PASSWORD@aws-0-YOUR-REGION.pooler.supabase.com:5432/postgres" \
  pnpm prisma migrate deploy
```

You should see each migration listed and `All migrations have been successfully
applied.`

Check it landed: Supabase → **Table Editor**. You should see `schools`, `users`,
`rooms`, `enrollments`, `cards`, `room_cards`, `inventory_items`, `draws`,
`token_transactions`, `activity_events`, `notifications` and the rest.

**Run this command again after any deploy that adds a migration.** Netlify does
not run migrations for you, deliberately: a build container that migrates can
run twice at once, and you would never see the output.

### Step 1.4 — What you do *not* need to do

The guide's Steps 1.3 (disable email confirmation) and 1.4 (grab the anon key)
have no equivalent here, and skipping them is correct:

- **No Supabase Auth.** Students do not have email addresses in this system.
  You create their accounts in the educator UI and hand out printed slips with a
  login ID and a temporary password; the app forces each student to choose their
  own password at first sign-in. Nobody self-registers, which means nobody can
  join a room they were not put in.
- **No anon key, no RLS.** The browser never talks to Supabase. All database
  access is from the server, using the connection string above, and the app's
  own permission checks decide who sees what. Keep the anon key and the
  `service_role` key where they are — you will not use either.

---

## Part 2 — Card art storage (Supabase Storage)

Netlify's filesystem is wiped on every deploy, so card images must live in a
bucket. Supabase Storage speaks the S3 protocol, so the app needs no new code.

1. Supabase → **Storage** → **New bucket**.
   - Name: `card-art`
   - **Public bucket: ON.** Card faces are not secrets, and a public bucket lets
     the CDN serve them straight to students instead of proxying every image
     through a function.
2. Supabase → **Storage** → **S3 Connection**. Note the **endpoint** and
   **region** shown there, then click **New access key** and copy the access key
   ID and secret. The secret is shown once.

Keep these five values for Step 3.2:

```
S3_BUCKET=card-art
S3_REGION=<the region shown on the S3 Connection page, e.g. ap-southeast-1>
S3_ENDPOINT=https://<your-ref>.storage.supabase.co/storage/v1/s3
S3_ACCESS_KEY_ID=<from the access key you just made>
S3_SECRET_ACCESS_KEY=<from the access key you just made>
S3_PUBLIC_BASE_URL=https://<your-ref>.supabase.co/storage/v1/object/public/card-art
```

> **This path has not been run against a real bucket.** The S3 driver is written
> and typed and its logic is covered by tests against an in-memory double, but
> no Supabase bucket existed to point it at. Treat the first image upload as a
> test, not as a routine step — [Step 6.4](#step-64--upload-one-image) is
> exactly that, and it comes before you import 20 cards' worth of art.

---

## Part 3 — Netlify (hosting)

### Step 3.1 — Connect the repository

There is no drag-and-drop path here; the app has to be built.

1. Go to **[app.netlify.com](https://app.netlify.com)** → **Add new site** →
   **Import an existing project** → **GitHub**, and authorise it.
2. Pick the `bizboosters` repository.
3. Set **Branch to deploy** to `claude/bizboosters-app-build-i1tzmb` (or `main`,
   once you have merged).
4. Leave the build command and publish directory alone — `netlify.toml` in the
   repo already sets them (`pnpm prisma generate && pnpm build`, publishing
   `.next`).
5. Deploy. You can set the environment variables before or after: the build does
   not read them, so it will go green either way. What it will not do is *work*
   until Step 3.2 is done and you have redeployed.

### Step 3.2 — Set the environment variables

Site configuration → **Environment variables** → **Add a variable**. Set each
one to **All scopes** and **All deploy contexts**; the scheduled functions in
Part 5 read `APP_URL` and `CRON_SECRET`, and a variable scoped to builds only is
invisible to them.

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | The **transaction pooler** string from Step 1.2, ending in `?pgbouncer=true&connection_limit=1` |
| `APP_URL` | `https://<your-site>.netlify.app` — come back and fix this after Step 3.3 |
| `SESSION_COOKIE_NAME` | `bb_session` |
| `CRON_SECRET` | A long random string. Generate with `openssl rand -hex 32` |
| `MAIL_TRANSPORT` | `console` (see [Inviting other teachers](#inviting-other-teachers)) |
| `S3_BUCKET` | `card-art` |
| `S3_REGION` | From Step 2 |
| `S3_ENDPOINT` | From Step 2 |
| `S3_ACCESS_KEY_ID` | From Step 2 |
| `S3_SECRET_ACCESS_KEY` | From Step 2 |
| `S3_PUBLIC_BASE_URL` | From Step 2 |

Optional: `RETENTION_DAYS` (default `548`, i.e. 18 months) controls when the
nightly job starts *reporting* old rooms as reviewable. It never deletes
anything by itself.

> **Region.** Netlify → Site configuration → Build & deploy → you can pick the
> functions region on paid plans. On the free plan functions run in
> `us-east-1`, so a Singapore database means every draw crosses the Pacific
> twice. It works — expect ~400 ms per draw rather than ~50 ms. If that feels
> slow in class, the fix is to move the *database* to `us-east-1` too, not to
> move Netlify.

### Step 3.3 — Deploy, and name the site

1. **Deploys** → **Trigger deploy** → **Deploy site**. The first build takes
   3–5 minutes (it installs dependencies, generates the Prisma client and builds
   Next.js).
2. When it is green, click **Site configuration** → **Change site name** and
   pick something students can type: `bizboosters-sunway`, say. Your URL becomes
   `https://bizboosters-sunway.netlify.app`.
3. **Go back to the environment variables and set `APP_URL` to that exact URL**,
   then redeploy. It is used to build invitation links and by the nightly jobs;
   if it is wrong, both point at the wrong place.

Visit `https://<your-site>.netlify.app/api/v1/health`. You want:

```json
{"status":"ok","checks":{"database":{"ok":true,"latency_ms":42}}}
```

That single response proves the build succeeded, the function runs, and the
connection string reaches Supabase. If it errors, go to
[Troubleshooting](#troubleshooting) — do not carry on until it is green.

### Step 3.4 — A custom domain (optional)

Netlify → Domain management → Add a domain, then add the CNAME it gives you at
your registrar. HTTPS is issued automatically. Update `APP_URL` afterwards.

---

## Part 4 — Your admin account

A fresh deployment has no accounts at all, and no sign-up page — so there is
exactly one way in, and you create it from your laptop:

```bash
# SESSION pooler string again (port 5432)
DATABASE_URL="postgresql://postgres.YOUR-PROJECT-REF:YOUR-PASSWORD@aws-0-YOUR-REGION.pooler.supabase.com:5432/postgres" \
  pnpm admin:create \
    --school "Sunway University" \
    --email vincentr@sunway.edu.my \
    --name "Your Name"
```

Leave `--password` off and the script generates one, prints it once, and marks
the account to change it at first login. That is the safer route: a password
typed into a shell ends up in your shell history, and a password sent in a chat
message is already public.

**Change the password you shared in this conversation.** It has been through a
chat log, so treat it as compromised — sign in with the generated one and set
something new on the first-login screen.

The account is created as **`school_admin`**, which is a superset of educator:
it creates rooms, adds students, awards tokens and builds decks like any
teacher, *and* it is the only role that can invite other teachers. There is no
separate "admin + educator" account to create — one login does both.

Sign in at `https://<your-site>.netlify.app`.

---

## Part 5 — The two nightly jobs

These are already in the repo as Netlify Scheduled Functions
(`netlify/functions/cron-reconcile.mjs` and `cron-retention.mjs`) and deploy
themselves. You do not have to configure anything, but you should know what they
are:

- **03:00 UTC — reconciliation.** Recounts every room: card copies in the deck
  plus copies in students' hands must equal copies that exist, and every token
  balance must equal the sum of its ledger. It answers 500 if anything has
  drifted, which shows as a failed invocation in Netlify.
- **04:00 UTC — housekeeping.** Sweeps expired sessions and rate-limit windows,
  and *reports* rooms past their retention window without touching them.

**Verify they exist** after your first deploy: Netlify → **Logs** →
**Functions** → you should see `cron-reconcile` and `cron-retention` listed.

**Watch the reconciliation one.** Netlify → Site configuration →
**Notifications** → add an email notification for function errors. It is the
alarm that tells you the game's arithmetic has broken — and it should never
fire.

To run one on demand: `curl -fsS -H "Authorization: Bearer $CRON_SECRET"
https://<your-site>.netlify.app/api/v1/cron/reconcile`

---

## Part 6 — Before a class touches it

Work through this in order. Each step is a thing that has gone wrong for someone.

### Step 6.1 — Sign in and change your password

At `https://<your-site>.netlify.app`. You should be forced onto the change-password
screen and be unable to reach anything else until you have.

### Step 6.2 — Create a test room

Rooms → New room. Note the defaults it gives you, all editable per room:

| Setting | Default |
| --- | --- |
| Draw cost | 20 tokens |
| Trade ratio | 3 cards of one rarity → 1 of the next |
| Low-stock alert | when the deck drops to 20 cards |
| Students see odds | on |

### Step 6.3 — Import the deck

The 20 prototype cards and their 103 copies are in `seed/prototype-deck.json`.
Get the school ID and room ID from the URL bar in the educator UI, then:

```bash
DATABASE_URL="<session pooler string>" \
  pnpm deck:import --school <school-id> --room <room-id>
```

You can also build a deck entirely in the educator UI; the script just saves
typing for the first one.

### Step 6.4 — Upload one image

This is the storage smoke test. In the educator UI, open any card and upload a
PNG or JPEG.

**Then check three things:**
1. Supabase → Storage → `card-art` → a `cards/<id>/...webp` object appeared.
2. The card thumbnail renders in the educator UI.
3. Right-click the image → Copy image address. It should start with your
   `S3_PUBLIC_BASE_URL`, not with `/api/v1/images/`. If it starts with the
   latter, `S3_PUBLIC_BASE_URL` is unset or wrong — it works, but every image
   burns a function call.

If the upload fails, see
[Card image upload fails](#card-image-upload-fails) before importing the rest of
the art.

### Step 6.5 — Add two test students and play a round

Add two students. Award tokens to one. As that student: draw a card, use it, and
confirm from the educator side that (a) the notification arrived, (b) the used
card went straight back into the deck, and (c) the room's history log shows all
three events.

Then delete the test room. It has served its purpose and a room full of test
data is a room you will one day confuse for a real one.

### Step 6.6 — Take a backup and prove you can restore it

Supabase takes daily backups on the free tier, but an untested backup is a
rumour. The procedure is in [RUNBOOK.md](RUNBOOK.md) and has been run
end-to-end against this schema (dump → drop → restore → checksums matched), but
**not against your Supabase project**. Do it once, before real student data
exists and losing it costs nothing.

### Step 6.7 — The rest of the checklist

[LAUNCH.md](LAUNCH.md) has the full list. The one that genuinely blocks you:
**the documents in `docs/legal/` are unreviewed drafts** and you are about to
process children's data. Have whoever owns data protection at your institution
read them.

---

## Part 7 — Using your data

Everything the guide's Part 4 describes works here, with different table names.

### The dashboard

Supabase → **Table Editor**. The tables you will actually open:

| Table | What is in it |
| --- | --- |
| `enrollments` | One row per student per room, including `token_balance` |
| `activity_events` | The full history log — every draw, award, use and trade |
| `token_transactions` | The append-only ledger behind every balance |
| `room_cards` | The live deck: `copies_total` vs `copies_remaining` |
| `inventory_items` | Which cards are in which student's hand right now |
| `draws` | Every draw, with what came out |

**Filter by room:** click **Filter** → `room_id` → equals → paste the room's ID
from the educator UI's URL bar.

**Export as CSV:** in any table view, **Export** → **Download CSV**. Opens in
Excel or Sheets.

### Useful SQL

Supabase → **SQL Editor** → **New query**.

```sql
-- Class standings: tokens held and cards in hand, one room
select u.display_name,
       u.login_id,
       e.token_balance,
       count(i.id) filter (where i.state = 'owned') as cards_held
from enrollments e
join users u on u.id = e.student_id
left join inventory_items i on i.enrollment_id = e.id
where e.room_id = 'PASTE-ROOM-ID'
  and e.status = 'active'
group by u.display_name, u.login_id, e.token_balance
order by e.token_balance desc;
```

```sql
-- Which cards are actually being drawn?
select c.name, c.rarity, count(*) as times_drawn
from draws d
join cards c on c.id = d.card_id
where d.room_id = 'PASTE-ROOM-ID'
group by c.name, c.rarity
order by times_drawn desc;
```

```sql
-- Deck health: how much of each card is still in the pool
select c.name,
       c.rarity,
       rc.copies_total,
       rc.copies_remaining,
       rc.copies_total - rc.copies_remaining as in_student_hands
from room_cards rc
join cards c on c.id = rc.card_id
where rc.room_id = 'PASTE-ROOM-ID'
order by rc.copies_remaining asc;
```

```sql
-- Participation: who has never drawn?
select u.display_name, u.login_id, e.token_balance
from enrollments e
join users u on u.id = e.student_id
where e.room_id = 'PASTE-ROOM-ID'
  and e.status = 'active'
  and not exists (select 1 from draws d where d.enrollment_id = e.id)
order by u.display_name;
```

**Read, don't write.** The Table Editor lets you edit cells, and you should not.
Token balances are a cache of the ledger and card counts are a conservation
invariant; changing either by hand will make the 03:00 reconciliation fail, and
correctly so. Every legitimate change has a button in the educator UI.

---

## What you lose on Netlify

**Live updates become 20-second updates.**

The app pushes changes over server-sent events: a long-lived connection held
open for the whole lesson. When a classmate spends a Legendary and it returns to
the deck, everyone else's odds move *as it happens* — that shared, visible
scarcity is the best thing about a circulating deck.

Netlify functions have a hard execution timeout measured in seconds. That
connection will be cut. The client detects it and falls back to polling every 20
seconds, which was built for exactly this case: **no data is lost, no draw is
missed, no notification disappears.** The educator's badge and everyone's odds
simply update on a 20-second tick instead of instantly.

If that matters more to you than staying on Netlify, a container host (Railway,
Fly.io, Render) keeps the live feel — [DEPLOY.md](DEPLOY.md) covers those, and
the repo's Dockerfile is for exactly that. If it does not, Netlify is a
perfectly good home for this app and everything else behaves identically.

### Inviting other teachers

There is no email transport wired up — `MAIL_TRANSPORT=console` prints
invitation emails to the log rather than sending them. So when you invite a
colleague:

1. Admin → Invitations → invite their email.
2. Netlify → **Logs** → **Functions**, and find the block beginning
   `─── email ───`. The invitation link is in it.
3. Send them that link yourself.

The link is a single-use token that expires. Do not post it in a group chat —
whoever opens it becomes that educator.

If you will do this often, wiring an SMTP provider into `src/server/mailer.ts`
is a small, self-contained change behind an interface that already exists.

---

## Privacy & safety

- **Passwords** are hashed with Argon2id (the current OWASP recommendation).
  You cannot see a student's password and neither can anyone with database
  access — the reset flow issues a new temporary one.
- **No keys in the browser.** Unlike the guide's app, there is no Supabase key
  in any page students load. Your `service_role` key is never used at all; keep
  it unused.
- **Sessions** are opaque tokens stored as hashes, 2 hours for students and 12
  for educators, sliding on use.
- **Data residency.** Supabase stores data on AWS in the region you chose in
  Step 1.1. Choose it to match your institution's policy; it cannot be changed
  later without recreating the project.
- **Erasure requests.** Do **not** delete rows by hand — a student holding three
  cards would take them out of circulation permanently and break the deck's
  arithmetic. Use the erasure flow in [RUNBOOK.md](RUNBOOK.md), which returns
  their held cards to the pool first, then removes them.
- **Children's data.** `docs/legal/PRIVACY.md` and `TERMS.md` are drafts written
  against FERPA, COPPA, GDPR and PDPA, and they have not been reviewed by a
  lawyer. Get them reviewed.

---

## Free tier limits

**Supabase:**
- 500 MB database. A draw is roughly 300 bytes of rows; a class of 100 students
  drawing 50 times each is about 1.5 MB. You are not going to run out.
- 1 GB storage. Twenty cards at three sizes each is a few MB.
- **Projects pause after 7 days with no activity.** This is the one that will
  bite you: pause it over a term break and the first student to open the app on
  Monday gets an error. Visit the Supabase dashboard to wake it, which takes a
  minute or two. **Check the app on the Friday before teaching resumes.**

**Netlify:**
- 100 GB bandwidth and 125,000 function calls per month. Every page view and
  every draw is a function call; a class of 100 playing weekly is in the low
  thousands.
- 300 build minutes. Each deploy is 3–5.

Neither free tier is a constraint for a classroom. The pause is an operational
hazard, not a capacity one.

---

## Troubleshooting

| Problem | Likely fix |
| --- | --- |
| Build succeeds but every page errors | The build genuinely does not need `DATABASE_URL` — nothing connects until a request arrives. A green build proves nothing about your variables; the health check in Step 3.3 is what proves them |
| Build fails: `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` | `packageManager` in `package.json` pins pnpm 10 for this reason. If you have bumped it to 11, regenerate the lockfile in the same commit |
| Site loads but says "Site not found" | A build published nothing. Check that nobody set `BUILD_STANDALONE` in Netlify's environment — that flag is for the Docker image only and breaks Netlify's runtime |
| `/api/v1/health` returns a database error | Wrong connection string. Ports matter: **6543** for the app, and the string must end in `?pgbouncer=true&connection_limit=1` |
| `prepared statement "s0" already exists` | `pgbouncer=true` is missing from `DATABASE_URL` |
| `Can't reach database server` from your laptop | You used the **direct** connection (IPv6-only). Use the session pooler string, port 5432 |
| `prisma migrate deploy` hangs or errors about advisory locks | You pointed it at the transaction pooler (6543). Migrations need the session pooler (5432) |
| `Timed out fetching a new connection from the connection pool` | Raise `connection_limit` to 3 and add `&pool_timeout=20`. If it persists, the database is asleep — see the pause note above |
| `Query engine ... rhel-openssl-3.0.x could not be found` | The Prisma engine did not get bundled. `binaryTargets` in `prisma/schema.prisma` should include `rhel-openssl-3.0.x`; if it does, clear the Netlify build cache and redeploy |
| Everything works, then breaks after a holiday | The Supabase project paused. Open the dashboard to wake it |
| Card image upload fails | See below |
| Live odds only move every 20 seconds | Expected on Netlify — see [What you lose on Netlify](#what-you-lose-on-netlify) |
| Student can't log in, says locked | 10 failed attempts locks an account briefly. Reset their password from the educator UI |

### Card image upload fails

The likely causes, in order:

1. **`S3_ENDPOINT` is wrong.** It must be the S3 endpoint
   (`https://<ref>.storage.supabase.co/storage/v1/s3`), not the project URL.
2. **The access key is a project API key.** Storage S3 access keys are made
   separately, under Storage → S3 Connection → New access key.
3. **The bucket name does not match `S3_BUCKET` exactly**, including case.
4. **`S3_REGION` does not match** the region on the S3 Connection page.

Netlify → Logs → Functions will have the actual error. This is the one path in
this guide that has never been exercised against a live bucket, so if it fails
in a way none of the above explains, that is worth reporting rather than working
around.

---

## What to give your students

One line:

> **https://bizboosters-sunway.netlify.app** — your login ID and password are on
> your slip. You'll be asked to choose a new password the first time.

Nothing to install. It works on school Chromebooks, iPads and phones; the draw
screen was designed for a phone held in portrait.

---

## What has and has not been verified

Being straight about this so you know where to be careful:

**Verified:** the schema and its 12 constraints; the draw under real concurrency
(30 students against a 5-card deck yields exactly 5 winners, 25 clean
"pool empty" responses and zero token drift); the circulating-deck conservation
invariant; backup and restore against this schema; 265 automated tests covering
auth, tokens, decks, draws, card actions and retention.

**Not verified:** anything Supabase-specific in this document, because no
Supabase project existed to test against — the connection-string guidance
follows Prisma's and Supabase's documented requirements rather than a run I
watched. Also unverified: the S3 storage driver against a real bucket, and the
Dockerfile (Docker was unavailable), which does not matter unless you leave
Netlify.

Step 3.3's health check and Step 6.4's image upload are where the unverified
parts show up first. That is why they are separate, early steps rather than
things you discover during a lesson.

---

## Appendix A — the terminal part, for people who have never used one

There are exactly two commands in this whole deployment that you have to run
yourself: one creates the database tables (Step 1.3), one creates your admin
account (Part 4). Everything else is clicking in a browser.

This appendix sets your laptop up once and then runs both. **Budget 30 minutes**,
most of it waiting for downloads. You do not need to understand any of it, and
nothing here can damage your computer or your database — the worst outcome is an
error message, and every error I have seen is in the table at the end.

Do this on the same laptop you will use for the rest of setup.

### A.0 — First, check your database password

Open the note where you saved your Supabase database password from Step 1.1.

**If it contains anything other than letters and numbers** — `@ # / ? & % : $`
and so on — change it now. The password gets embedded in a web-address-shaped
string, and those characters mean something special inside an address, so the
connection silently breaks in a way that looks like a wrong password.

To change it: Supabase → **Project Settings** → **Database** → **Reset database
password**. Generate a new one, and if it has symbols, replace it with a long
one you type yourself — 20+ letters and numbers, no symbols. Something like
`Rk48mTqzWvb3Np7xLd91` is far stronger than a short one with punctuation.

Save it in your password manager.

### A.1 — Install Node.js

Node.js is the thing that runs the app's code. Installing it is a normal
installer, like installing Zoom.

1. Go to **[nodejs.org](https://nodejs.org)**.
2. Click the big green button labelled **LTS**. ("LTS" means the stable one.)
3. Open the downloaded file and click Next / Continue / Agree through the
   installer, accepting every default.
4. Restart your computer if it asks. If it doesn't, you still need to **close
   any terminal window you already have open** — new software is only visible to
   windows opened afterwards.

### A.2 — Open a terminal

A terminal is a window where you type commands instead of clicking. It looks
alarming and is not.

**On a Mac:** press `Cmd` + `Space`, type `Terminal`, press Enter.

**On Windows:** press the Start button, type `PowerShell`, click **Windows
PowerShell**.

You'll get a mostly-empty window with a blinking cursor. Type this and press
Enter:

```
node -v
```

You should see a version number like `v22.14.0` or `v24.3.0`. **Anything
starting with v20.11 or higher is fine.**

If instead you see "command not found" or "is not recognized", Node didn't
install or the terminal was open before you installed it. Close the terminal,
open a new one, and try again. If it still fails, run the installer again.

### A.3 — Install pnpm

pnpm fetches the code libraries the app depends on. Type this and press Enter:

```
npm install -g pnpm@10.33.0
```

Wait for it to finish (10–30 seconds). Then check:

```
pnpm -v
```

You should see `10.33.0`.

> **Type that version number exactly.** Newer pnpm refuses to install packages
> published in the last day, which turns an unrelated release by a library
> author into a failed setup. Pinning the version avoids the whole subject.

**Windows only, if you see a red error mentioning "running scripts is
disabled":** paste this, press Enter, type `Y`, press Enter, then run
`pnpm -v` again.

```
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

### A.4 — Download the code

1. Go to
   **https://github.com/vrangel10-code/BizBoosters/tree/claude/bizboosters-app-build-i1tzmb**
2. Click the green **Code** button → **Download ZIP**.
3. Find the ZIP in your Downloads folder and unzip it — double-click on a Mac,
   or right-click → Extract All on Windows.
4. You now have a folder named something like
   `BizBoosters-claude-bizboosters-app-build-i1tzmb`. **Move it to your Desktop**
   so it is easy to find.
5. Open it and check you can see a file called `package.json` and a folder
   called `prisma`. If you instead see a single folder with the same name again,
   go into that one — that's the real one.

### A.5 — Point the terminal at that folder

The terminal is always "in" some folder, and it needs to be in this one.

Type `cd` — that's c, d, then **a space** — and then **drag the folder from your
Desktop onto the terminal window and let go.** The path fills itself in. Press
Enter.

```
cd /Users/you/Desktop/BizBoosters-claude-bizboosters-app-build-i1tzmb
```

Check you're in the right place:

**On a Mac:** type `ls` and press Enter.
**On Windows:** type `dir` and press Enter.

You should see `package.json` and `prisma` in the list. If you don't, you're in
the wrong folder — repeat the drag.

### A.6 — Create the settings file

The app needs to know your database address. It reads it from a file called
`.env` (the dot at the front is deliberate).

**On a Mac**, type these two lines, pressing Enter after each:

```
touch .env
open -e .env
```

**On Windows**, type this and press Enter, then click **Yes** when it offers to
create the file:

```
notepad .env
```

Either way, an empty text editor opens. Into it, type `DATABASE_URL=` and then
paste your **session pooler** connection string from Step 1.2 in quotes, so the
whole file is one line:

```
DATABASE_URL="postgresql://postgres.YOUR-PROJECT-REF:YOUR-PASSWORD@aws-0-YOUR-REGION.pooler.supabase.com:5432/postgres"
```

Three things people get wrong here:

- It must be the **session pooler** string, the one ending in **`:5432/postgres`**.
  The 6543 one is for Netlify and will not work for this.
- `[YOUR-PASSWORD]` must be replaced with your actual password, **and the square
  brackets deleted**.
- Keep the straight quotes `"` at both ends.

Save and close: **Mac** `Cmd`+`S` then `Cmd`+`W`. **Windows** `Ctrl`+`S` then
close the window.

### A.7 — Install the app's dependencies

Back in the terminal:

```
pnpm install
```

This downloads a few hundred libraries and takes **2–5 minutes**. You'll see
scrolling text and a progress bar. It ends with something like
`Done in 2m 14s`. Yellow warnings are normal; only red errors matter.

Installing also builds the database client the next two commands need. If you
ever see **`@prisma/client did not initialize yet`**, that build did not happen
— run this once and carry on:

```
pnpm prisma generate
```

### A.8 — Create the tables (this is Step 1.3)

```
pnpm prisma migrate deploy
```

This is the moment. You should see:

```
Datasource "db": PostgreSQL database "postgres"

10 migrations found in prisma/migrations

Applying migration `20260808133204_phase0_identity`
Applying migration `20260808133500_identifier_lowercase_checks`
...
All migrations have been successfully applied.
```

**Check it worked in the browser:** Supabase → **Table Editor** → the dropdown
at the top left set to `public`. You should see a list of about 19 tables —
`schools`, `users`, `rooms`, `enrollments`, `cards`, `room_cards`, `draws`,
`inventory_items`, `token_transactions`, `activity_events`, `notifications` and
so on. They are all empty. That is correct — there is no data yet.

**Step 1.3 is done.** Go back to Part 2 of the main guide.

### A.9 — Later, for Part 4

When you reach Part 4, come back to this same terminal window in this same
folder and run this, with your own school name, email and name in the quotes:

```
pnpm admin:create --school "Sunway University" --email vincentr@sunway.edu.my --name "Your Name"
```

It reads the same `.env` file, so there is nothing else to set up. It prints a
generated password **once** — copy it somewhere before closing the window. That
is what you sign in with, and the app will make you change it immediately.

### A.10 — Keep the folder

Don't delete it. When a future update adds a database change, you'll download a
fresh ZIP over it and run `pnpm install` and `pnpm prisma migrate deploy` again.
That is the entire maintenance routine.

### When something goes wrong

| What you see | What it means | What to do |
| --- | --- | --- |
| `command not found: node` / `'node' is not recognized` | Node isn't installed, or the terminal predates it | Close the terminal, open a new one. If still failing, reinstall from nodejs.org |
| `command not found: pnpm` | A.3 didn't finish | Re-run `npm install -g pnpm@10.33.0` and watch for red text |
| `running scripts is disabled on this system` | Windows blocks new commands by default | Run the `Set-ExecutionPolicy` line in A.3 |
| `no such file or directory: package.json` | The terminal is in the wrong folder | Redo A.5, dragging the folder that contains `package.json` |
| `Environment variable not found: DATABASE_URL` | The `.env` file is missing, misnamed, or in the wrong folder | It must be called exactly `.env`, in the same folder as `package.json`. On Windows, check Notepad didn't save it as `.env.txt` |
| `@prisma/client did not initialize yet` | The database client was never built from the schema | Run `pnpm prisma generate`, then repeat the command that failed |
| `Can't reach database server` | Wrong host, or the project is asleep | Open the Supabase dashboard to wake the project, then retry. Check you pasted the whole string |
| `password authentication failed` | Wrong password, or it has symbols | Redo A.0 — reset to a letters-and-numbers password and update `.env` |
| `Error: P1010` / permission denied | You used the wrong connection string | It must be the session pooler, port **5432** |
| `prepared statement "s0" already exists` | You used the app's string (port 6543) here | Swap to the 5432 one in `.env` |
| It printed migration names then `All migrations have been successfully applied` | Nothing. It worked | Carry on to Part 2 |

If you get an error that isn't in this table, copy the **whole** message — not a
summary of it — and ask. The exact wording is what identifies the cause.

---

## Appendix B — Parts 3 to 6, click by click

Appendix A got the tables into Supabase. This one takes you from there to a
working website, in the same style: every button named, every value spelled out.

**Budget 45 minutes**, most of it waiting for two builds.

The order here differs slightly from Part 3 above, on purpose. The build does
not read your settings, so it goes green whether or not you have configured
anything — which means "the build worked" tells you nothing. Deploying **first**
gets you your web address, so you can then enter every setting once, correctly,
instead of entering a guess and coming back to fix it.

### B.1 — Make a Netlify account

1. Go to **[app.netlify.com](https://app.netlify.com)**.
2. Click **Sign up** → **GitHub**, and use the same GitHub account the code is
   in. Signing up with GitHub rather than email saves a linking step later.
3. Netlify asks a few onboarding questions. Answer or skip them; none matter.

### B.2 — Connect the code

1. Click **Add new site** (or **Add new project** — Netlify has used both) →
   **Import an existing project**.
2. Click **GitHub**. A GitHub window pops up asking to authorise Netlify —
   click **Authorize**.
3. GitHub may then ask which repositories Netlify can see. Choose **Only select
   repositories** → pick **BizBoosters** → **Install**. (**All repositories**
   also works; the narrower option is just tidier.)
4. Back in Netlify you get a list of your repositories. Click **BizBoosters**.

### B.3 — Choose the branch, and only the branch

You now see a settings page before deploying. **Change exactly one thing on it.**

- **Branch to deploy:** click the dropdown and choose
  `claude/bizboosters-app-build-i1tzmb`.

Leave everything else alone. Build command and publish directory are already
filled in from the `netlify.toml` file in the repo — if the boxes look empty or
say something odd, that is fine, the file wins.

Ignore the "Add environment variables" section for now. Click **Deploy**
(sometimes **Deploy BizBoosters**).

### B.4 — Wait for the first build

You land on a page showing the build running. Click into it to watch the log
scroll if you like — it installs dependencies, generates the database client and
builds the app.

**This takes 3 to 6 minutes.** Wait for it.

- **Green, "Published"** → carry on.
- **Red, "Failed"** → scroll to the bottom of the log, copy the last 20 lines,
  and check them against the troubleshooting table in the main guide.

At this point the site exists but **does not work yet** — it has no idea where
your database is. That is expected. Don't open it and panic.

### B.5 — Give the site a name you can say out loud

Netlify has named it something like `serene-pastry-a1b2c3`.

1. In the left sidebar: **Site configuration** → **General** → find **Site
   information** → **Change site name**.
2. Type something students can type: `bizboosters-sunway`, for example. Lowercase
   letters, numbers and hyphens only.
3. Save.

**Write down your full address** — it is `https://` then the name then
`.netlify.app`:

```
https://bizboosters-sunway.netlify.app
```

You need it in the next step, exactly, with no trailing slash.

### B.6 — Make a CRON_SECRET

One of the settings is a long random password that only your site and its
nightly jobs know. Generate it rather than inventing one.

Go back to your terminal from Appendix A and run:

```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

It prints 64 random characters. Copy them. That is your `CRON_SECRET`.

### B.7 — Write out all your settings in a text editor

This is the step to take slowly. Open a plain text editor — TextEdit on Mac,
Notepad on Windows — and build up the block below, replacing every `PASTE...`
with your real value. Do not add spaces around the `=` signs.

```
DATABASE_URL=PASTE THE TRANSACTION POOLER STRING (PORT 6543) WITH ?pgbouncer=true&connection_limit=1 ON THE END
APP_URL=PASTE YOUR https://...netlify.app ADDRESS FROM B.5
SESSION_COOKIE_NAME=bb_session
CRON_SECRET=PASTE THE 64 CHARACTERS FROM B.6
MAIL_TRANSPORT=console
S3_BUCKET=card-art
S3_REGION=PASTE THE REGION FROM PART 2
S3_ENDPOINT=PASTE THE S3 ENDPOINT FROM PART 2
S3_ACCESS_KEY_ID=PASTE FROM PART 2
S3_SECRET_ACCESS_KEY=PASTE FROM PART 2
S3_PUBLIC_BASE_URL=PASTE FROM PART 2
```

Where each one comes from:

| Setting | Where you got it |
| --- | --- |
| `DATABASE_URL` | Step 1.2 — the **6543** one. **Not** the 5432 one in your `.env` file |
| `APP_URL` | B.5, above. No slash on the end |
| `SESSION_COOKIE_NAME` | Type `bb_session` exactly |
| `CRON_SECRET` | B.6, above |
| `MAIL_TRANSPORT` | Type `console` exactly |
| The six `S3_` lines | Part 2. If you have not done Part 2 yet, **delete those six lines** and do the rest now — everything works except card pictures, and you can add them later |

Two mistakes worth checking for before you move on:

- **`DATABASE_URL` is the 6543 string here.** Appendix A used the 5432 one. They
  look nearly identical and swapping them is the most common failure in this
  whole guide.
- **No quote marks.** Your `.env` file on your laptop had `"` around the value.
  Netlify does not want them — the quotes would become part of the value.

### B.8 — Paste them into Netlify

Netlify can take the whole block at once, which is far less error-prone than
typing eleven settings by hand.

1. Left sidebar → **Site configuration** → **Environment variables**.
2. Click **Add a variable** → choose **Import from a .env file**.
3. Paste your whole block into the box.
4. Leave the scopes setting as **All scopes** if you are offered it. This
   matters: the nightly jobs read `APP_URL` and `CRON_SECRET`, and a setting
   scoped to builds only is invisible to them.
5. Click **Import variables**.

You should now see all eleven listed. Values are hidden behind dots — that is
normal. Click one open and check for stray spaces or quote marks.

> If you cannot find "Import from a .env file", use **Add a single variable**
> eleven times instead: key on the left, value on the right, scope **All
> scopes**, and **Same value for all deploy contexts**.

### B.9 — Redeploy so the settings take effect

Settings only reach the site on the next build.

1. Left sidebar → **Deploys**.
2. Top right → **Trigger deploy** → **Deploy site**.
3. Wait 3–6 minutes for green.

### B.10 — The moment of truth

In your browser, go to your address with `/api/v1/health` on the end:

```
https://bizboosters-sunway.netlify.app/api/v1/health
```

You want to see, as plain text on a white page:

```json
{"status":"ok","checks":{"database":{"ok":true,"latency_ms":42}}}
```

**That one line proves everything**: the site is up, the app is running, and it
can reach your Supabase database. A different number after `latency_ms` is fine.

**Do not continue until you see it.**

| What you see instead | What it means |
| --- | --- |
| `"error"` mentioning the database, or a 500 page | `DATABASE_URL` is wrong. Nine times in ten it is the 5432 string where the 6543 one belongs, or `?pgbouncer=true&connection_limit=1` is missing from the end |
| "Page not found" | The build did not publish. Check **Deploys** — the newest one should say Published |
| It hangs, then errors | The Supabase project is asleep. Open the Supabase dashboard, wait a minute, reload |

Now open the site's home page. You should get the BizBoosters **login screen**.
You have no account yet — that is Part 4, and Appendix A section A.9 has the
command. Do that now, then come back here.

### B.11 — Check the nightly jobs exist (Part 5)

Nothing to configure; just confirm they arrived.

Left sidebar → **Logs** → **Functions**. You should see `cron-reconcile` and
`cron-retention` in the list. They will not have run yet — they fire at 03:00
and 04:00 UTC.

**Turn on the alarm while you are here:** **Site configuration** →
**Notifications** → **Add notification** → **Deploy failed** and, if offered,
**Function error** → your email. The 03:00 job is the one that checks the game's
arithmetic still adds up; it should never fail, so if it emails you, read it.

### B.12 — Test it like a student (Part 6)

Do this now, not on the morning of a class. Sign in as the admin account you
made in Part 4.

1. **Change your password** when it forces you to. Confirm it will not let you
   go anywhere else first.
2. **Create a room.** Rooms → New room. Accept the defaults (20 tokens per
   draw, low-stock alert at 20 cards).
3. **Add the cards.** Either build a deck in the interface, or run the import
   command from your Appendix A terminal — you need the school ID and room ID,
   which are the long codes in your browser's address bar when viewing the room:
   ```
   pnpm deck:import --school PASTE-SCHOOL-ID --room PASTE-ROOM-ID
   ```
4. **Upload one card picture.** Open any card, upload a PNG or JPEG. Then check
   Supabase → Storage → `card-art` and confirm a file appeared. **This is the
   one part of the whole setup that has never been tested against a real
   bucket** — if it fails, see "Card image upload fails" in the main guide, and
   do not import all your art until one image works.
5. **Add two test students**, award tokens to one, then sign in as that student
   in a **private/incognito window** (so you stay signed in as yourself in the
   normal one). Draw a card. Use it.
6. **Check from the educator side** that the notification arrived, the used card
   went back into the deck, and the room history shows all three events.
7. **Delete the test room.** A room full of test data is a room you will one day
   mistake for a real one.

### B.13 — Before real students

Two things left, both in [LAUNCH.md](LAUNCH.md):

- **Have someone review `docs/legal/`.** Those are unreviewed drafts and you
  will be processing children's data. This is the one item that genuinely
  blocks you.
- **Run a backup restore once**, following [RUNBOOK.md](RUNBOOK.md), while
  losing the data would cost nothing.

Then hand out the URL.
