# Build plan

Six phases. Each ends with something demonstrable, and the order is chosen so
the riskiest thing — the shared-deck draw transaction — is proven early.

## Phase 0 — Foundations ✅ complete
- Next.js + TypeScript + Prisma + Postgres, Docker Compose for local dev.
- Migrations for `schools`, `users`, `sessions`.
- Session auth: educator email/password, student login-ID/password, forced
  first-login password change, rate limiting, force-logout.
- `educator_invitations` + the admin invite/accept flow. No signup route.
- `pnpm admin:create` CLI to bootstrap the first school admin, documented in the
  runbook — without it a fresh deployment has no way in.
- CI: lint, typecheck, test, migrate-check.

**Done when:** an admin invites an educator by email, that educator redeems the
link and sets a password, and a student they create is forced to change theirs
before reaching anything else. ✅ Verified end to end; 67 tests green.

Delivered beyond the original list: a Postgres-backed rate limiter (in-memory
counters are useless on serverless), DB CHECK constraints enforcing identifier
normalization and per-role identity shape, and route-level tests that drive the
real handlers so the first-login gate is proven rather than asserted.

## Phase 1 — Rooms, rosters, tokens ✅ complete
- `rooms`, `room_educators`, `enrollments`, `token_transactions`,
  `activity_events`.
- Educator: create room, add students, CSV import with generated credentials,
  award tokens (single + bulk), adjust/undo with mandatory note.
- Student: room picker, token balance, personal history.

**Done when:** an educator awards 40 tokens to a class of 30 and every student
sees it in their own history with the reason attached. ✅ Verified end to end;
133 tests green.

Spec correction found while building: MECHANICS said a bulk award writes one
room-level activity event. The student history filters on
`subject_enrollment_id`, so that event would have been invisible to every
student it was about — exactly the acceptance case. It now writes one event per
student, sharing a `batch_id` so the educator's log still collapses to one line.

## Phase 2 — Cards and decks ✅ complete
- `cards`, `room_cards`, `room_rarities`; image upload to R2 + derivatives.
- Educator: card catalog CRUD (name required, effect text optional, rename any
  time), per-room deck builder editing **total** copies (never `remaining` —
  MECHANICS §3.1), bulk "set all Commons to 10", add/remove copies.
- Reset Deck: educator-only, atomic wipe-and-refill, typed confirmation.
- Low-stock alerting: edge-triggered `pool.low` at 20 + persistent banner.
- Seed importer for `seed/prototype-deck.json`, building the 103-copy deck.
- Live odds panel and full deck list, ported from the prototype.

**Done when:** an educator builds a room deck from scratch and both roles see
matching live odds. ✅ Verified end to end; 176 tests green. The rebuilt deck
reproduces the prototype's odds exactly: 58.3 / 29.1 / 9.7 / 2.9 %.

Card art could not be fetched from Google Drive in the build environment (the
network policy blocks it), so the download path is covered by the importer's
error handling and the local-file path was verified with generated
placeholders. Art still needs importing on a machine that can reach Drive, or
by dropping files into `seed/images/`.

## Phase 3 — The draw ✅ complete
- `draws`, `inventory_items`, the transactional draw service, idempotency keys.
- Student draw screen with the prototype's chest/shake/reveal animation and a
  `prefers-reduced-motion` path.
- Student inventory, stacked by card.
- **Concurrency test suite:** N parallel draws against a deck of 1 must produce
  exactly one winner and N−1 clean `pool_empty` errors, with tokens intact for
  the losers. Run it against real Postgres, not a mock.
- Nightly copy-conservation and balance-reconciliation jobs.

**Done when:** 30 simulated students hammer a 5-card deck and the ledger
balances exactly. ✅ Verified against a live server: 5 winners, 25 clean
`pool_empty`, 25 balances untouched, zero copy drift, zero balance drift.
218 tests green.

The acceptance run found a real production bug the unit tests could not: the
per-IP login limit counted *every* attempt, so a class of 30 behind one school
NAT locked out the 31st student. Login limits now count failures only.

## Phase 4 — Use, trades, notifications ✅ complete
- The item state machine and the use transaction: spend a card, return the copy
  to the deck, notify the educators. No approval gate.
- Educator "Recent uses" list with acknowledgement tick-boxes.
- 3-for-1 trades against real inventory; return-unused-to-deck.
- `notifications` + SSE stream + polling fallback + unread badges.
- `room.pool_changed` propagation on both draw **and** use, so odds visibly move
  in both directions.
- Room dashboard: "N of M copies held by students", with a per-student
  breakdown. This is the diagnostic for an empty circulating deck.

**Done when:** a student uses a card, the educator's badge increments within a
second, every other student's odds tick *up* in the same moment, and the
conservation check still balances. ✅ Verified against a live server: a student
holding the room's only Legendary spent it, the educator's badge went 0 → 1
with "Aisha Tan used Fortune Teller", and another student's Legendary chance
went **0.0% → 10.0%** in the same moment — then they actually drew it. Zero
copy drift, zero balance drift. 243 tests green.

SSE was confirmed end to end by holding an educator stream open while a student
used a card: `notification` and `room.pool_changed` both arrived on the wire.

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
| Integration | Every service against real Postgres in a transaction, including concurrent-draw races and concurrent draw-vs-use on the same card. |
| Conservation | Property test: a random sequence of draws, uses, trades, returns and deck edits must always end with `total = in_deck + held`, for every card. This is the one test that would catch a bad transaction boundary in the circulating-deck model. |
| E2E (Playwright) | Educator creates room → imports students → awards tokens → student logs in, changes password, draws, uses a card → educator approves → both logs correct. |
| Load | 50 concurrent draws in one room; assert conservation. |

The distribution test and the concurrency test are the two that actually matter.
Everything else is ordinary CRUD.
