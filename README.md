# BizBoosters

A classroom trading-card / token-economy platform. Educators award tokens for
classroom achievement; students spend tokens to draw cards from a shared,
finite room deck; cards are redeemed for real-world classroom perks.

This repository currently contains the **design specification** for turning the
single-file prototype (`prototype/lootbox-prototype.html`) into a deployable
multi-user web application.

## Documents

| Doc | What it covers |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Stack choice, service layout, auth, realtime, deployment |
| [docs/DATA-MODEL.md](docs/DATA-MODEL.md) | Full Postgres schema, every table and why it exists |
| [docs/MECHANICS.md](docs/MECHANICS.md) | Draw algorithm, token economy, card lifecycle, trades, concurrency |
| [docs/API.md](docs/API.md) | REST surface, realtime events, error contracts |
| [docs/OPEN-QUESTIONS.md](docs/OPEN-QUESTIONS.md) | Decisions that must be made before build, and gaps in the current brief |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Phased build plan |

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
