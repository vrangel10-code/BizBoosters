# Mechanics

## 1. The token economy

Tokens are **scoped to an enrollment**, not to a student. A student in three
rooms has three balances that never mix. This falls directly out of your brief —
each room has its own deck and its own educator awarding tokens — and it is the
thing most likely to be got wrong by accident.

| Rule | Default | Configurable per room |
| --- | --- | --- |
| Draw cost | 20 tokens | yes (`rooms.draw_cost_tokens`) |
| Award granularity | any positive integer | — |
| Negative balance | not permitted | no |
| Deduction | allowed, floored at 0 | — |

### Awarding

Educators award from the roster screen: select one student, several, or the
whole room; enter an amount and an optional reason. A bulk award writes one
`token_transactions` row **per student** (never one shared row) so that each
student's history is complete on its own, plus one `activity_events` row for the
room.

### "Editing tokens achieved"

Your brief asks for educators to edit a student's tokens. Do **not** implement
this as an update to the balance. Implement it as:

- **Adjustment** — educator enters a new target balance or a delta; the system
  writes a compensating `token_transactions` row with
  `reason = 'educator_adjustment'` and a mandatory note.
- **Undo** — a one-click reversal of a specific past award within, say, 24h,
  which writes the inverse row and links to the original.

The balance is never mutated outside a ledger row. This is what lets you answer
"why do I have 40 tokens when I earned 60" three weeks later, and it is what
protects the educator when a student disputes a score.

Guardrail: if an adjustment would push the balance below zero (because the
student already spent the tokens), block it and tell the educator what happened.
Silently clamping to zero destroys the audit trail.

## 2. The draw

### 2.1 What the prototype does

```js
// rarity chosen by remaining copies
rand = Math.random() * totalRemaining
selectedRarity = C if rand < pool.C, else U if rand < C+U, ...

// card type chosen UNIFORMLY among types in that rarity with stock left
availableIndexes = detailedPool[rarity].filter(count > 0)
pickedIndex = availableIndexes[floor(random() * availableIndexes.length)]
```

Two-stage: rarity weighted by remaining copies, then card type uniform among
in-stock types. This has a subtle consequence — within a rarity, a card with 1
copy left is exactly as likely as one with 10 copies left. A near-exhausted card
becomes *more* likely per remaining copy, and the last copy of each type sticks
around longer than a physical deck would suggest.

### 2.2 What to do instead

**Pick one copy uniformly at random from every copy remaining in the room.**

```
total = SUM(copies_remaining) over the room
roll  = crypto random in [0, total)
walk the rows in a stable order, subtracting copies_remaining, until roll < 0
```

This is the physical-deck model: 103 cards in a box, pull one. It produces the
same rarity distribution the prototype advertises in its odds panel (because
those percentages are already computed as `pool[r] / total`), and it removes the
within-rarity distortion. It is also one loop instead of two, which matters when
you are doing it inside a transaction.

Behavioural difference to be aware of before you ship it: low-stock card types
get rarer as they deplete instead of holding steady. That is what students
expect from "cards left in the deck", and your odds panel is already telling
them that story.

### 2.3 Randomness

Use `crypto.randomInt` / `crypto.getRandomValues` on the **server**. Never
`Math.random()`, never the client. Persist `roll_value` and `pool_snapshot` on
the `draws` row so that "the game cheated me" is an answerable question.

### 2.4 The draw transaction

This is the heart of the application. Thirty students clicking simultaneously on
the last Legendary must produce exactly one winner.

```sql
BEGIN;

-- 0. Serialize all deck mutations for this room. A room is a classroom, so
--    contention is trivial and a coarse lock is the right trade.
SELECT pg_advisory_xact_lock(hashtextextended(room_id::text, 0));

-- 1. Idempotency: has this exact client request already succeeded?
SELECT * FROM draws WHERE enrollment_id = $e AND idempotency_key = $k;
--    if found → COMMIT and replay the stored result

-- 2. Lock the wallet and check funds
SELECT token_balance FROM enrollments WHERE id = $e FOR UPDATE;
--    if balance < room.draw_cost_tokens → ROLLBACK, 409 insufficient_tokens

-- 3. Read remaining stock
SELECT id, card_id, copies_remaining
  FROM room_cards WHERE room_id = $r AND copies_remaining > 0
  ORDER BY id;
--    if empty → ROLLBACK, 409 pool_empty  (tokens are NOT debited)

-- 4. Pick a copy (§2.2) and consume it
UPDATE room_cards SET copies_remaining = copies_remaining - 1
  WHERE id = $picked AND copies_remaining > 0;
--    0 rows affected → ROLLBACK (defence in depth; the lock should prevent it)

-- 5. Debit
UPDATE enrollments SET token_balance = token_balance - $cost WHERE id = $e;
INSERT INTO token_transactions (..., delta = -$cost, reason = 'draw_spend');

-- 6. Grant
INSERT INTO draws (...);
INSERT INTO inventory_items (..., state = 'owned', acquired_via = 'draw');

-- 7. Record + notify
INSERT INTO activity_events (type = 'card.drawn', ...);
INSERT INTO notifications (...) for each room educator;

COMMIT;
-- after commit only: publish SSE `notification` + `room.pool_changed`
```

Notes on this:

- **Idempotency key** is a client-generated UUID sent in a header, held for the
  lifetime of the button press. It is what makes a double-click, a flaky mobile
  connection, or a user-initiated retry safe. Without it, a request that
  succeeds but whose response is lost costs the student 20 tokens for nothing.
- **Order matters**: charge only after stock is confirmed. Never debit-then-draw.
- **Publish after commit**, never inside the transaction — an SSE broadcast for
  a rolled-back draw is a ghost card in everyone's UI.
- The advisory lock is per room, so different rooms never block each other.

### 2.5 Animation

The prototype has a 1200 ms shake before the reveal, and it decides the result
*before* the animation. Keep that shape: the client calls
`POST /rooms/:id/draws`, gets the result immediately, then plays the animation
and reveals. If the request fails, abort the animation and show the error —
never play the chest opening and then apologise.

## 3. Card lifecycle

```
                    ┌────────── educator adds copies ──────────┐
                    ▼                                          │
              ┌───────────┐   draw / trade    ┌───────┐         │
              │  IN POOL  │──────────────────▶│ OWNED │         │
              └───────────┘                   └───┬───┘         │
                    ▲                             │             │
                    │  return / trade-in          │ student     │
                    │                             │ "use"       │
                    │                        ┌────▼───────┐     │
                    │                        │USE_PENDING │     │
                    │                        └────┬───────┘     │
                    │             educator rejects│ approves    │
                    └─────────────◀───────────────┤             │
                                                  ▼             │
                                              ┌──────┐          │
                                              │ USED │──────────┘
                                              └──────┘   (only if
                                                          used_card_returns_to_pool)
```

Your brief says a student "uses" a card and the educator is notified. That
leaves two mechanics undefined, and both need a decision (see
[OPEN-QUESTIONS.md](OPEN-QUESTIONS.md) Q1–Q2):

1. **Is use a request or a fait accompli?** Modelled here as
   `rooms.use_requires_approval`. With approval on, the item goes to
   `use_pending`, the educator sees it in a Requests queue, and approve/reject
   resolves it — a rejected card goes back to `owned`, not to the pool. With
   approval off, the item goes straight to `used` and the educator gets a
   notification only. Approval-on is the safer default for a real classroom
   perk ("skip one homework"), because the educator has to actually honour it.
2. **Does a used copy return to the deck?** `rooms.used_card_returns_to_pool`.
   Off means the deck is a consumable term-long resource that depletes and needs
   an educator restock. On means the deck recycles and cards circulate forever.
   Off is the better default — scarcity is what makes the Legendary matter.

## 4. Trades (the prototype's marketplace)

`trade_ratio` (default 3) copies of rarity X, surrendered from the student's own
inventory, return to the room deck and immediately draw 1 copy of rarity X+1
from that deck. No token cost, matching the prototype.

Changes from the prototype:

- The cards surrendered are **specific `inventory_items` the student owns**,
  selected by ID. The prototype's "Missing: N" counter — which infers your
  holdings from gaps in the pool — disappears entirely; it was a single-player
  fiction.
- The trade is a `draws` row with `kind = 'trade_upgrade'`, so upgrades appear in
  history alongside ordinary draws.
- If the target rarity has zero stock in the room, the button is disabled and
  the API returns `409 target_rarity_empty` — matching the prototype's "Out of
  Stock" state.
- Same advisory lock, same transaction, same idempotency key as a draw.

**Economics to be aware of:** chained trades convert `3³ = 27` Commons into 1
Legendary at zero token cost. At 20 tokens a draw that is 540 tokens of input,
which is probably fine — but it is a guaranteed path to the rarest card, which
straight drawing is not. Surface the ratio and the `trades_enabled` switch in
room settings so an educator can tune or disable it.

### Return to pool
The prototype's "Claim / Return Cards" becomes a student action: surrender an
owned copy back to the deck for nothing. Keep it — it lets a student who drew a
duplicate put it back in circulation, and it is a nice pro-social gesture in a
classroom. Log it as `card.returned`.

## 5. The deck, per room

Educators configure a room's deck by picking cards from the school catalog and
setting copies for each. The prototype's implicit structure — "every card of a
rarity has the same copy count" (10/5/2/1) — becomes an explicit **per-card copy
count** with a bulk "set all Commons to 10" helper, because that is what you
actually want at setup time and per-card control is what you want in week six.

The prototype's default deck, for seeding: 6 Commons ×10, 6 Uncommons ×5, 5
Rares ×2, 3 Legendaries ×1 = **103 copies**, starting odds 58.3 / 29.1 / 9.7 /
2.9 %.

Rules for editing a live deck:

- **Adding copies** is always safe.
- **Reducing copies** may only reduce `copies_remaining`, never below zero, and
  never retroactively take a card out of a student's hand. `copies_total` cannot
  drop below the number of copies already distributed.
- **Removing a card entirely** is only permitted when no student holds one;
  otherwise offer "set remaining to 0" (stop it dropping) instead.
- **Restock / reset** (the prototype's "Reset Deck") must be an educator-only,
  explicitly confirmed action, and must state whether it wipes student
  inventories. Default: it refills the deck and leaves inventories alone, which
  means copies in circulation are *added* to the total in existence. Say this in
  the confirm dialog — it is the one action that can break copy conservation on
  purpose.

## 6. Live odds

Both roles see the same panel the prototype has: per-rarity remaining count and
percentage, plus `N / M cards remaining`. Percentages are derived, never stored:
`copies_remaining(rarity) / total_remaining`. Pushed to every connected client in
the room on `room.pool_changed`, so a Legendary being pulled visibly moves
everyone's odds. That shared-scarcity feedback is the best part of the game
design you already have — make it prominent.

`rooms.students_see_odds` exists for educators who would rather not show them.

## 7. Activity event vocabulary

One shared vocabulary drives the room log, the student history, and
notifications. Every mutation emits exactly one:

| Type | Emitted when | Room log | Student sees | Educator notified |
| --- | --- | --- | --- | --- |
| `tokens.awarded` | educator awards | ✓ | own | — |
| `tokens.adjusted` | educator edits/undoes | ✓ | own | — |
| `card.drawn` | student draws | ✓ | own | ✓ |
| `card.traded` | trade upgrade | ✓ | own | ✓ |
| `card.use_requested` | student requests use | ✓ | own | ✓ |
| `card.use_approved` / `card.use_rejected` | educator resolves | ✓ | own | — |
| `card.used` | use completes (no-approval mode) | ✓ | own | ✓ |
| `card.returned` | student returns to pool | ✓ | own | ✓ |
| `pool.restocked` | educator restocks/edits deck | ✓ | ✓ | — |
| `enrollment.added` / `enrollment.removed` | roster change | ✓ | own | — |
| `room.settings_changed` | economy rules edited | ✓ | ✓ | — |

Educator log view: whole room, filterable by student, type, and date, exportable
to CSV. Student log view: the same table filtered to `subject_enrollment_id =
me`, plus room-wide events (`pool.restocked`, `room.settings_changed`).

**Deliberate omission:** students do not see other students' draws by name in
their own log. Reconsider only if the room wants a public feed — it is a nice
social feature and a mild privacy decision, so it belongs behind a room setting.

## 8. Failure modes to design for

| Situation | Behaviour |
| --- | --- |
| Deck empty on draw | Reject before debiting. Educator gets a `pool.empty` notification so they know to restock. |
| Deck empties mid-lesson | Draw button disables live via `room.pool_changed`. |
| Student double-clicks draw | Idempotency key replays the same result. |
| Network drops after draw | Same. On reconnect the client re-sends the same key and gets the original card. |
| Educator removes a student mid-term | Enrollment → `removed`; inventory and history are retained, held copies stay out of the deck until an educator explicitly reclaims them. |
| Student moved between rooms | Not a transfer. New enrollment, fresh balance, fresh inventory. If you need to carry tokens across, do it as two explicit ledger rows. |
| Two educators edit the deck at once | Advisory lock plus optimistic concurrency (`If-Match` on a room version) → second write gets 409 and re-reads. |
| Term rollover | Archive the room; offer "clone deck configuration into a new room" so setup is not repeated. |
