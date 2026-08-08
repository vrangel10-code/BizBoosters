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
you do:

```bash
railway run pnpm admin:create --school "Your School" --email you@school.edu --name "Your Name"
```

It prints a one-time password. Sign in at `https://yourdomain.com`, change it,
then invite your teachers from the admin area.

**7. Schedule the two cron jobs.** Railway → New → Cron:

```
0 3 * * *   curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://yourdomain.com/api/v1/cron/reconcile
0 4 * * *   curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://yourdomain.com/api/v1/cron/retention
```

The first is your integrity check — it returns 500 if card copies or token
balances ever stop adding up. Alert on that.

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
