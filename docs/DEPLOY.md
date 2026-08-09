# Putting BizBoosters on the internet

BizBoosters is a **server-hosted web application**. Students open a URL in a
browser, sign in with the ID their teacher gave them, and play. There is no
install, no app store, and nothing works offline — every draw, every token and
every card lives on your server, which is the whole point: a shared deck cannot
be shared if it lives on thirty separate Chromebooks.

To make it reachable you need three things:

1. **A place to run the app** — a Node server
2. **A Postgres database**
3. **A domain name** with HTTPS

## Recommended: Railway

Railway runs long-lived containers, which matters here: the live badge and the
odds ticking up in real time use server-sent events, and serverless platforms
cut those connections. It also gives you Postgres in the same project, so the
database URL wires itself up.

Roughly £4–8/month for a school-sized deployment.

### Steps

**1. Push this repo to GitHub** (it already is, on your branch — merge to `main`
first).

**2. Create the project**

- railway.app → New Project → Deploy from GitHub repo → pick this repo
- Add a **PostgreSQL** service to the same project

**3. Set the environment variables** on the app service:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` — Railway substitutes it |
| `APP_URL` | `https://yourdomain.com` |
| `SESSION_COOKIE_NAME` | `bb_session` |
| `CRON_SECRET` | a long random string (`openssl rand -hex 32`) |
| `MAIL_TRANSPORT` | `console` to start; `smtp` once you have a provider |
| `S3_BUCKET` etc. | see "Card images" below |

**4. Deploy.** The `Dockerfile` is detected automatically. On boot the
entrypoint runs `prisma migrate deploy`, so the schema is created on the first
start — nothing to run by hand.

**5. Add your domain.** Railway → Settings → Networking → Custom Domain, then
add the CNAME it gives you at your registrar. HTTPS is automatic.

**6. Create the first administrator.** A fresh deployment has no way in until
you do. Run it against the production database — `railway run` injects the
service's own `DATABASE_URL`:

```bash
railway run pnpm admin:create \
  --school "Your School" \
  --email you@school.edu \
  --name "Your Name" \
  --password 'choose-one-here'
```

Omit `--password` and one is generated, printed once, and flagged for change at
first login. Supply your own and you can sign in with it straight away.

The account is created as **`school_admin`**, which is a superset of educator:
it can create rooms, add students, award tokens and build decks like any
teacher, *and* invite other teachers. There is no separate "admin + educator"
role because it would be the same set of permissions.

Do not put a real password in a script, a `.env` committed to git, or a chat
message you keep. Type it into the command once.

**7. Schedule the two cron jobs.** Railway → New → Cron:

```
0 3 * * *   curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://yourdomain.com/api/v1/cron/reconcile
0 4 * * *   curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://yourdomain.com/api/v1/cron/retention
```

The first is your integrity check — it returns 500 if card copies or token
balances ever stop adding up. Alert on that.

### If the Railway build fails

**`flag '--mount=type=cache,id=pnpm...' is missing the cacheKey prefix`** —
Railway's builder rejects BuildKit cache mounts with a bare id. Fixed: the
cache mount is gone.

**`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`** — pnpm 11 refuses packages
published in the last day or so, as a supply-chain precaution. It appeared
because `corepack enable` on its own installs whatever pnpm is newest, so the
container ran pnpm 11 against a lockfile written by pnpm 10. Fixed: the version
is pinned in `package.json`'s `packageManager` field, and the Dockerfile calls
`corepack prepare --activate` to honour it.

If you ever bump that field to pnpm 11, regenerate the lockfile at the same
time — and expect a build to fail if a dependency published something in the
previous 24 hours. That is the policy working, not a bug; wait a day or relax
`minimumReleaseAge` deliberately.

## Netlify

Netlify can run this, but it is not a natural fit and you should know what you
give up before committing to it. Netlify has no database and its functions time
out, so you supply the first and lose one feature to the second.

### Why a fresh deploy says "Site not found"

That message means Netlify has no successfully published deploy for the site.
For this repo there are three likely causes, in the order they bite:

**1. `output: 'standalone'` in `next.config.mjs`.** This was added for the
Docker image and it breaks Netlify's Next.js runtime: standalone writes a
self-contained server to `.next/standalone`, Netlify's adapter looks for the
normal `.next` output, finds nothing to publish, and you get "Site not found"
rather than a build error. **Fixed** — standalone is now opt-in via
`BUILD_STANDALONE=true`, which only the Dockerfile sets.

**2. No `DATABASE_URL` at build time.** `next build` imports every route module
to collect the route map, which used to construct a Prisma client — and a build
environment has no database because building does not need one. **Fixed** — the
client is now constructed on first use, so the build succeeds with no database
configured at all.

**3. No `netlify.toml`.** Added, pinning Node 22 and the Next.js plugin.

Pull the latest branch and redeploy. If it still fails, the Netlify deploy log
will now show a real error rather than an empty publish.

### What you still have to configure

**A database.** Netlify does not provide one. [Neon](https://neon.tech) has a
free tier and speaks plain Postgres — create a project, copy the pooled
connection string, and set it as `DATABASE_URL` in Netlify → Site configuration
→ Environment variables. Also set `APP_URL`, `SESSION_COOKIE_NAME` and
`CRON_SECRET`.

**Run the migrations yourself.** There is no entrypoint on Netlify, so nothing
creates the schema. Run it from your machine against the production database —
which is safer than migrating from a build container anyway, because you see
the output and it cannot run twice concurrently:

```bash
DATABASE_URL="postgresql://…neon…" pnpm prisma migrate deploy
DATABASE_URL="postgresql://…neon…" pnpm admin:create \
  --school "Your School" --email you@school.edu --name "Your Name"
```

Repeat the first command after any deploy that adds a migration.

**Object storage for card art.** Netlify has no persistent disk, so the local
storage driver would lose every image on each deploy. Configure R2 or S3 — see
"Card images" below.

**Scheduled functions for the cron jobs**, since Netlify has no cron service in
the way Railway does. Netlify Scheduled Functions can call the two endpoints, or
run them from any machine with `curl`.

### What does not work on Netlify

**Server-sent events.** Netlify Functions have an execution timeout measured in
seconds; the `/api/v1/stream` connection is meant to stay open for the whole
lesson. It will be cut, the client will fall back to polling, and the educator's
badge and everyone's live odds will update **every 20 seconds instead of
instantly**.

Nothing breaks and no data is lost — the fallback was built for exactly this —
but the moment where a classmate spends a Legendary and you watch your own
chances jump is gone. That moment is the best thing about the circulating deck,
which is why the recommendation above is a container host. Your call; it works
either way.

## Alternatives

| Host | Verdict |
| --- | --- |
| **Fly.io** | Equivalent to Railway. `fly launch` reads the Dockerfile; add Fly Postgres. Good if you want a server geographically near your school. |
| **Render** | Also fine. Web Service from Dockerfile + Render Postgres. |
| **A VPS** (Hetzner, DigitalOcean, ~£4/mo) | Cheapest and most control. You manage Postgres, backups, TLS and updates yourself. Only pick this if you are comfortable doing that. |
| **Vercel** | Works, but **SSE does not survive** — the live badge and live odds degrade to 20-second polling. Everything else is correct. Only choose it if you already know Vercel and can live without the realtime feel. |

## Card images

With no `S3_BUCKET` set, card art is written to local disk. On Railway and Fly
that disk is wiped on every deploy, so **the art would vanish each time you
push**. Use object storage:

Cloudflare R2 is the cheap option (free up to 10 GB). Create a bucket, make a
read-only public URL for it, then set:

```
S3_BUCKET=bizboosters-cards
S3_REGION=auto
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_PUBLIC_BASE_URL=https://cards.yourdomain.com
```

**Smoke-test one upload before a class uses it.** The S3 driver is implemented
and typed but has never been run against a real bucket.

## What students will see

Give them one thing: the URL, plus the login ID and password on their printed
slip. On first sign-in they are made to choose their own password before they
can reach anything else.

It works on any modern browser — school Chromebooks, iPads, phones. The layout
is responsive; the draw screen is designed for a phone in portrait.

## Before you let a class in

There is a full checklist in [LAUNCH.md](LAUNCH.md), but the three that actually
block you:

1. **Legal documents reviewed** — the drafts in `docs/legal/` are not reviewed,
   and you are processing children's data.
2. **Card art imported** — see [RUNBOOK.md](RUNBOOK.md).
3. **Restore drill run against production** — the procedure is in the runbook
   and has been verified against this schema, but not against your host.

## A caveat on the Dockerfile

The `Dockerfile` here has **not been built**, because Docker was unavailable in
the environment it was written in. What *has* been verified is the thing it
wraps: `output: 'standalone'` builds, and the standalone server boots, connects
to Postgres and serves both `/api/v1/health` and the login page.

So expect the app to work; if the first `docker build` fails, it will be
something mechanical — a missing file in a `COPY`, a platform-specific binary —
rather than a problem with the application. Build it locally once before
pointing a host at it:

```bash
docker build -t bizboosters .
docker run --rm -p 3000:3000 -e DATABASE_URL="postgresql://..." bizboosters
```
