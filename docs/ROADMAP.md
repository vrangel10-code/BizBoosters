# Build plan

Six phases. Each ends with something demonstrable, and the order is chosen so
the riskiest thing — the shared-deck draw transaction — is proven early.

## Phase 0 — Foundations (≈1 week)
- Next.js + TypeScript + Prisma + Postgres, Docker Compose for local dev.
- Migrations for `schools`, `users`, `sessions`.
- Session auth: educator email/password, student login-ID/password, forced
  first-login password change, rate limiting, force-logout.
- CI: lint, typecheck, test, migrate-check.

**Done when:** an educator and a student can log in, and the student is forced
to change their password before reaching anything else.

## Phase 1 — Rooms, rosters, tokens (≈1.5 weeks)
- `rooms`, `room_educators`, `enrollments`, `token_transactions`,
  `activity_events`.
- Educator: create room, add students, CSV import with generated credentials,
  award tokens (single + bulk), adjust/undo with mandatory note.
- Student: room picker, token balance, personal history.

**Done when:** an educator awards 40 tokens to a class of 30 and every student
sees it in their own history with the reason attached.

## Phase 2 — Cards and decks (≈1.5 weeks)
- `cards`, `room_cards`, `room_rarities`; image upload to R2 + derivatives.
- Educator: card catalog CRUD, per-room deck builder with per-card copy counts,
  bulk "set all Commons to 10", restock/reset with confirmation.
- Seed script for the prototype's 103-card deck.
- Live odds panel and full deck list, ported from the prototype.

**Done when:** an educator builds a room deck from scratch and both roles see
matching live odds.

## Phase 3 — The draw (≈1.5 weeks) — highest risk
- `draws`, `inventory_items`, the transactional draw service, idempotency keys.
- Student draw screen with the prototype's chest/shake/reveal animation and a
  `prefers-reduced-motion` path.
- Student inventory, stacked by card.
- **Concurrency test suite:** N parallel draws against a deck of 1 must produce
  exactly one winner and N−1 clean `pool_empty` errors, with tokens intact for
  the losers. Run it against real Postgres, not a mock.
- Nightly copy-conservation and balance-reconciliation jobs.

**Done when:** 30 simulated students hammer a 5-card deck and the ledger
balances exactly.

## Phase 4 — Use, trades, notifications (≈1.5 weeks)
- `card_use_requests`, the item state machine, educator Requests queue.
- 3-for-1 trades against real inventory.
- Return-to-pool.
- `notifications` + SSE stream + polling fallback + unread badges.
- `room.pool_changed` live odds propagation.

**Done when:** a student uses a card, the educator's badge increments within a
second, approval resolves it, and both histories agree.

## Phase 5 — Logs, exports, polish, launch (≈1.5 weeks)
- Educator room activity log with filters and CSV export.
- Student history view.
- Empty/error states, mobile layout, accessibility pass.
- Archive/clone room, retention and delete-my-data.
- Backups verified by an actual restore drill; Sentry; health checks; ToS and
  privacy policy.

**Done when:** a real class runs a full lesson on it without you in the room.

## Testing strategy

| Layer | What |
| --- | --- |
| Unit | Draw selection distribution (χ² over 100k rolls against expected odds), token arithmetic, state-machine transitions. |
| Integration | Every service against real Postgres in a transaction, including concurrent-draw races. |
| E2E (Playwright) | Educator creates room → imports students → awards tokens → student logs in, changes password, draws, uses a card → educator approves → both logs correct. |
| Load | 50 concurrent draws in one room; assert conservation. |

The distribution test and the concurrency test are the two that actually matter.
Everything else is ordinary CRUD.
