# BizBoosters

A classroom trading-card / token-economy platform. Educators award tokens for
classroom achievement; students spend tokens to draw cards from a shared,
finite room deck; cards are redeemed for real-world classroom perks.

**Status: phase 0 complete** — identity, sessions, invitations and the
first-login flow are built and tested. Rooms, tokens, decks and the draw arrive
in phases 1–3. See [docs/ROADMAP.md](docs/ROADMAP.md).

## Quick start

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
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | Setup, migrations, first admin, operational tasks |

## What is built (phase 0)

- **Sessions** — opaque tokens, only their SHA-256 hash stored, server-side
  revocation, sliding expiry: 2 hours for students, 12 for educators.
- **Educator invitations** — single-use, 7-day, revocable, token rotated on
  resend. No signup route exists for any role.
- **Student accounts** — generated login IDs and one-time default passwords,
  shown to the educator once, with a first-login password change enforced in
  `requireAuth()` rather than in the UI.
- **Argon2id** password hashing at the OWASP baseline, per-account lockout and
  Postgres-backed rate limiting.
- **67 tests** against a real Postgres, including the concurrency case where one
  invitation link is submitted five times at once.

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
