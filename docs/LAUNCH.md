# Launch checklist

The five build phases are done. This is what stands between the code and a real
class using it, split honestly into what the software does, what it does not,
and what only you can do.

## Blocking — a real class should not use it until these are true

**1. The legal documents need a lawyer.**
`docs/legal/PRIVACY.md` and `docs/legal/TERMS.md` are accurate descriptions of
what the software does, written so an adviser has something concrete to review.
They are **drafts**, they contain `[BRACKETS]`, and they are not reviewed. You
will also need a Data Processing Agreement, and in the US a FERPA school-official
designation. Neither is drafted here — both are jurisdiction-specific.

**2. Card art has to be imported.**
The deck works without it, but a card game with no pictures is a spreadsheet.
Drop the images into `seed/images/` and run `pnpm deck:import` — see
[RUNBOOK.md](RUNBOOK.md). Google Drive was unreachable from the build
environment, so the download path is covered by error handling rather than by a
successful run; the local-file path is verified.

**3. Do the restore drill on your production database.**
The drill in the runbook has been performed against this schema, but not against
your hosting. An untested backup is not a backup, and losing a term of student
collections is unrecoverable.

## Deployment

Step-by-step instructions are in [DEPLOY.md](DEPLOY.md). The decisions below are
the ones that change behaviour.

## Deployment decisions you have to make

**Pick a host that supports long-lived connections.** SSE is how the educator's
badge and everyone's live odds update within a second. On Vercel and most
serverless platforms the stream disconnects and clients fall back to 20-second
polling — correct, but the live feel is gone. A container host (Railway, Fly, a
small VM) gets the real behaviour.

**Configure object storage.** With no `S3_BUCKET`, card art is written to local
disk, which is wrong anywhere the filesystem is ephemeral: every deploy would
lose the art. Cloudflare R2 is the cheap option. **The S3 driver is implemented
and typed but has never run against a real bucket** — smoke-test one upload
before a class does.

**Set `CRON_SECRET` and schedule two jobs.** Without the secret both cron routes
are disabled, which means no integrity checking and no session sweeping:

```
0 3 * * *  curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://…/api/v1/cron/reconcile
0 4 * * *  curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://…/api/v1/cron/retention
```

Alert on a non-200 from `reconcile`. It returns 500 on integrity drift, which is
your only early warning for a transaction-boundary bug.

**Run `pnpm admin:create` once.** A fresh deployment has no way in until you do.

## Known gaps, stated plainly

| Gap | Why it is acceptable for now |
| --- | --- |
| **No error-reporting vendor wired in** | Everything funnels through `reportError()` in `src/server/observability.ts`. Pointing it at Sentry is a change in one function. Adding an SDK that needs a DSN to do anything would have been untestable here. |
| **No Playwright end-to-end suite** | 265 tests cover services and route handlers against real Postgres, and every phase was verified against a live HTTP server. Browser-level tests would add confidence in the UI wiring specifically. |
| **No email transport** | `MAIL_TRANSPORT=console` prints invitations to the log. Fine for a single school you onboard yourself; wire SMTP before you invite educators you cannot phone. |
| **Design is functional, not designed** | Readable, responsive, keyboard-operable, reduced-motion aware. It has not had a designer near it. |
| **No co-teacher UI** | `addRoomEducator` exists in the service and schema; there is no screen for it yet. |
| **Accessibility not audited** | Skip link, landmarks, focus rings, labelled controls, `aria-live` on results, no colour-only rarity encoding. Not tested with a real screen reader or against WCAG by a specialist. |

## Before the first lesson

- [ ] Legal documents reviewed and published
- [ ] Card art imported and visible in a room
- [ ] Restore drill run against production
- [ ] `CRON_SECRET` set; both cron jobs scheduled; alerting on reconcile
- [ ] Object storage configured and one upload smoke-tested
- [ ] `pnpm admin:create` run; first educator invited and able to sign in
- [ ] One room built end to end: deck, roster, credentials printed
- [ ] Sat with one class for one lesson before letting it run unattended

## The one thing to watch in week one

**Hoarding.** With a circulating deck, the only way the deck runs dry is
students collecting and never spending. The room page shows "N held by
students", and the low-stock alert fires at 20 cards left. If a class sits on
its collection, the deck empties and drawing stops being fun.

You decided against expiry, which is the right call to start with — it is much
easier to add a rule once you have seen whether the problem is real than to take
one away. Watch the held count for a term and decide then.
