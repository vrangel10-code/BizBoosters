# BizBoosters

A classroom trading-card / token-economy platform. Educators award tokens for
classroom achievement; students spend tokens to draw cards from a shared,
finite room deck; cards are redeemed for real-world classroom perks.

**Status: all five build phases complete** — identity, rooms, tokens, decks,
the draw, card use, trades, live notifications, exports and retention. 265 tests
against a real Postgres.

Three things still stand between this and a real class: the legal documents need
a lawyer, the card art needs importing, and the restore drill needs running
against your production database. See **[docs/LAUNCH.md](docs/LAUNCH.md)**.

BizBoosters is a **hosted web app**, not an offline one: students open a URL,
sign in with the ID their teacher gave them, and play. The shared deck only
works because state lives on a server. See [docs/DEPLOY.md](docs/DEPLOY.md) to
put it on a public URL.

## Quick start (local)

```bash
cp .env.example .env
docker compose up -d
pnpm install && pnpm prisma migrate deploy
pnpm admin:create --school "Your School" --email you@school.edu --name "Your Name"
pnpm dev
```

Full instructions, including how to read invitation emails in development, are
in [docs/RUNBOOK.md](docs/RUNBOOK.md).

## Documents

| Doc | What it covers |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Stack choice, service layout, auth, realtime, deployment |
| [docs/DATA-MODEL.md](docs/DATA-MODEL.md) | Full Postgres schema, every table and why it exists |
| [docs/MECHANICS.md](docs/MECHANICS.md) | Draw algorithm, token economy, card lifecycle, trades, concurrency |
| [docs/API.md](docs/API.md) | REST surface, realtime events, error contracts |
| [docs/OPEN-QUESTIONS.md](docs/OPEN-QUESTIONS.md) | Every design decision made, with its reasoning |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Phased build plan |
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | Setup, migrations, first admin, backups, retention |
| [docs/DEPLOY.md](docs/DEPLOY.md) | Getting it onto a public URL students can reach |
| [docs/LAUNCH.md](docs/LAUNCH.md) | What is left before a real class uses it, and known gaps |
| [docs/legal/](docs/legal/) | Privacy notice and terms — **drafts, need legal review** |

## What is built

**Accounts** — educators by admin invitation only (no signup route exists);
students by roster creation with generated login IDs and one-time passwords.
Argon2id, server-side sessions, forced first-login password change enforced in
the guard rather than the UI.

**Rooms and tokens** — per-enrolment balances, CSV roster import, bulk awards,
adjust and undo. The balance is a cache; an append-only ledger is the truth, and
they move together in one locked transaction.

**Cards and decks** — school-wide catalog, per-room decks edited by *total*
copies, live odds identical for both roles, Reset Deck, low-stock alerting.

**The draw** — one transaction under a per-room advisory lock, idempotency keys,
server-side CSPRNG, stored roll and pool snapshot so a disputed draw is
answerable. Verified with 30 students against a 5-card deck.

**Use and trades** — spending a card returns the copy to the deck immediately,
so everyone's odds tick up; 3-for-1 trades against real inventory; live
notifications over SSE with a polling fallback.

**Operations** — CSV and JSON exports, real erasure, room cloning, retention
sweep, nightly integrity reconciliation, structured logging, verified
backup/restore drill.

## What the prototype does today

`prototype/lootbox-prototype.html` is a single-player, client-side lootbox:

- Four rarities — Common, Uncommon, Rare, Legendary — with per-card-type copy
  limits of 10 / 5 / 2 / 1 and 6 / 6 / 5 / 3 distinct card images, for a
  starting deck of **103 copies** (58.3% / 29.1% / 9.7% / 2.9% at full stock).
- Drop rates are **live** — they are derived from what is left in the deck, so
  odds shift as the deck depletes.
- A 3-for-1 "marketplace" upgrade: return 3 copies of a rarity to the deck,
  draw 1 of the next rarity up.
- A claim/return screen that pushes copies back into the deck.
- State persisted to `localStorage` with an optional anonymous-auth Firestore
  mirror.

## Decisions locked in

| Question | Decision |
| --- | --- |
| Does using a card need educator approval? | **No.** The student spends it; the educator is notified after the fact and ticks it off once honoured. |
| Does a used card return to the deck? | **Yes, immediately.** The deck is a circulating population of copies, not a depleting consumable. |
| Do held cards expire? | **No.** Hoarding resolves at the semester boundary, via Reset Deck. |
| Cooldown between drawing and using? | **None.** |
| Who can reset the deck? | **Educators only.** Reset wipes every student inventory in the room and refills the deck, atomically. |
| What happens when the deck runs low? | **Alert at 20 copies left**; the educator decides whether to add more. The system never restocks itself. |
| What identifies a card? | **Its power-up name** (required, editable). Effect text is optional — the art states the effect. |
| Does reset clear token balances? | **No, never.** Tokens are earned recognition; only cards reset. |
| Who creates educator accounts? | **Admin invitation only.** No public signup route exists for any role. |
| Do students see each other's activity? | **No.** Own history plus room-wide events. Aggregate deck state is shared; who holds what is educator-only. |

The circulating-deck decision has the widest blast radius: card copies become
strictly conserved (`total = in deck + held`), the odds panel becomes a two-way
indicator, hoarding rather than consumption becomes the source of scarcity, and
refilling the deck is only ever safe when paired with clearing every hand — which
is precisely what Reset Deck does. See
[docs/MECHANICS.md §3.1](docs/MECHANICS.md).

## What has to change

Three things in the prototype do not survive contact with multiple users, and
they drive most of the design:

1. **There is no inventory.** The prototype infers "cards you own" from what is
   missing from the deck (`maxPerType - remaining`). With many students sharing
   one deck that inference is meaningless — real per-student inventory rows are
   required.
2. **All logic and randomness run in the browser.** Any student can open
   DevTools and mint a Legendary. Every state change must move server-side.
3. **There are no tokens, no accounts, and no shared deck.** Those are the whole
   product.

See [docs/MECHANICS.md](docs/MECHANICS.md) for how each prototype mechanic is
carried over.
