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

**Decided:** using a card needs no educator approval, and a used copy returns to
the deck immediately. Both are fixed product rules, not room settings.

```
              ┌──────────────────────────────────────────────┐
              │                                              │
              ▼                                              │
        ┌───────────┐    draw (20 tokens)      ┌───────┐      │
        │  IN DECK  │─────────────────────────▶│ OWNED │      │
        │           │    trade upgrade         │       │      │
        └───────────┘                          └───┬───┘      │
              ▲                                    │          │
              │                          ┌─────────┴────────┐ │
              │  return unused           │ student uses it  │ │
              │  (state='returned')      │ (state='used')   │ │
              └──────────────────────────┴──────────────────┴─┘
                        the copy is back in the deck, instantly
```

Only `owned` holds a copy out of the deck. `used`, `returned`, and `revoked` are
terminal history rows whose copy is already back in circulation.

**The use transaction** (no approval gate, so it is short):

```sql
BEGIN;
SELECT pg_advisory_xact_lock(hashtextextended(room_id::text, 0));

UPDATE inventory_items
   SET state = 'used', used_at = now(), returned_at = now(), student_note = $n
 WHERE id = $i AND enrollment_id = $e AND state = 'owned';
-- 0 rows → ROLLBACK, 409 item_state_conflict (double-click or already spent)

UPDATE room_cards SET copies_remaining = copies_remaining + 1
 WHERE room_id = $r AND card_id = $c AND copies_remaining < copies_total;
-- the CHECK guard is the backstop against a double-return inflating the deck

INSERT INTO activity_events (type = 'card.used', ...);
INSERT INTO notifications (...) for each room educator;
COMMIT;
-- after commit: SSE `notification` + `room.pool_changed`
```

The same advisory lock as the draw, for the same reason: it is a deck mutation.
The `state = 'owned'` predicate in the `UPDATE` is what makes a double-click
idempotent — the second one matches zero rows and returns cleanly instead of
returning the copy to the deck twice.

### What "no approval" means for the educator's workflow

The educator still has to actually honour the perk in the real world, and the
brief's notification is how they find out. What the removal of approval takes
away is any *record of what they still owe*. Replace it with the lightest
possible thing: a **Recent uses** list on the educator's room page, where each
entry has a tick-box writing a `card_use_acknowledgements` row.

It gates nothing. The student's card is already spent and already back in the
deck. It exists so a teacher who gets six "homework pass" notifications during a
lesson can tell which ones they have honoured. Unread notification state alone
would half-work, but reading a notification and honouring a perk are different
events, and conflating them loses the teacher's place.

### 3.1 The circulating deck — consequences of the return rule

Returning used copies to the deck changes what the deck *is*. It is no longer a
term-long consumable that drains toward empty; it is a fixed population of
copies circulating between the deck and students' hands. Total copies in
existence never changes except when an educator deliberately adds or removes
some. Several things follow, and they are mostly good:

**Scarcity is now driven by hoarding, not consumption.** The only reason a card
is unavailable is that someone is holding it. A student sitting on the room's
single Legendary is denying it to twenty-nine others; the moment they spend it,
it is back in the pool and everyone can chase it again. That is a far more
interesting classroom dynamic than a deck that only ever empties, and it makes
*using* cards pro-social rather than merely self-interested.

**The odds panel now moves in both directions.** In the prototype, live odds
were a one-way ratchet toward zero. Now a Legendary being spent visibly restores
everyone's chance at it. Pair the `card.used` event with `room.pool_changed` on
the SSE stream so the whole room sees the odds tick back up in real time — it is
the best feedback moment in the game and it costs nothing extra to build.

**Restock and reset are different operations.** The prototype's "Reset Deck"
sets every count back to maximum. Refilling the deck *on its own*, while
students are holding copies, would mint cards from nothing — the held copies
come back later and the deck ends up permanently over-full. But refilling
**paired with clearing every student inventory, in one transaction**, is exactly
consistent: afterwards `held = 0` and `remaining = total` for every card, so
conservation holds by construction. That pairing is the semester reset.

| Action | Meaning | Safe? |
| --- | --- | --- |
| **Add copies** | raise `copies_total` and `copies_remaining` by the same N | always |
| **Remove copies** | lower both by N, floored at `copies_remaining ≥ 0` | always |
| **Reset Deck** | revoke every `owned` item **and** set `remaining = total` for every card, atomically | conservation-safe; destroys student inventories, so educator-only with typed confirmation |
| Refill without clearing hands | — | never; this is the conservation bug the pairing avoids |

Day-to-day, the educator deck screen shows per card
`total = in deck + held by students` and edits **total**; `remaining` is a
system-owned number they never touch directly. Reset Deck is the one exception,
and it is a semester-boundary action, not a mid-term tool.

**The deck can still hit empty — by hoarding.** If every copy is in someone's
hand, a draw fails with `pool_empty` and tokens are untouched (§8). Give the
educator the number that explains it: **"84 of 103 copies held by students"** on
the room dashboard, with a per-student breakdown. Without it, "the deck is
empty" looks like a bug rather than a class that is sitting on its cards.

**A student can redraw a card they just used.** Expected and thematically fine —
the copy went back in the box. Do not special-case it.

**Deferred question:** should held cards expire, so hoarding self-corrects? A
term-long hold is not obviously wrong, and expiry is a punitive mechanic to
introduce sight-unseen. Ship without it, watch one term, and use the "copies
held" metric to decide. See [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md) Q11.

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

Rules for editing a live deck (see §3.1 — the educator edits **total**, and the
system derives **remaining**):

- **Adding copies** is always safe: `total += N`, `remaining += N`.
- **Reducing copies** takes them out of the deck only: `total -= N`,
  `remaining -= N`, floored at `remaining ≥ 0`. It never reaches into a
  student's hand, so `total` cannot drop below the number currently held. If the
  educator asks for more than that, cap it and say so.
- **Removing a card entirely** is permitted only when no student holds one.
  Otherwise offer "set remaining to 0" — the card stops dropping, and copies
  still in hands quietly leave circulation as they are used.
- **Reset Deck** is the semester-boundary action, and the only one that destroys
  student inventory. In one transaction it revokes every `owned` item in the
  room and sets `copies_remaining = copies_total` for every card. Never offered
  as a plain refill (§3.1) — the two halves together are what keep it
  consistent.

### 5a. Reset Deck

Educator-only, and worth designing defensively because it is irreversible:

- **Never available to students.** Enforced server-side by the room-educator
  check, not merely by hiding the button.
- **Typed confirmation** — the educator types the room name, not "OK". A
  misfired reset in week six wipes a term of student collections.
- **Blocked on archived rooms.**
- Emits one `pool.reset` activity event and notifies **every student in the
  room**, so nobody is left thinking their inventory vanished into a bug.
- The event payload records what was destroyed (per-student counts), so the
  history explains the discontinuity even though the items themselves are gone.
- **Tokens are never touched.** Reset Deck clears inventories and refills the
  deck; balances survive untouched, with no option to include them. Tokens are
  earned recognition and cards are the spendable resource — a semester reset of
  the deck is not a reason to erase what a student earned. An educator who does
  want to zero a balance has the adjustment tool (§1), which leaves a ledger row
  and a reason.

### 5b. Low-stock alerts

Because the deck circulates, "running low" is a condition that can arrive, clear
itself as students spend cards, and arrive again. That needs two mechanisms, not
one:

**The alert (an event).** When the room's total in-deck copies crosses **down**
to `rooms.low_stock_threshold` (default **20**, per-room configurable), emit
`pool.low` and notify every room educator — *"Room 7B is down to 20 cards in the
deck; 83 are held by students"* — linking to the deck editor to add copies.

It must be **edge-triggered**. Evaluating it on every draw would send a
notification per draw for a room sitting near the threshold. Keep a
`low_stock_alerted` boolean on the room:

- fires once, when `in_deck` crosses from `> threshold` to `≤ threshold`
- rearms only when `in_deck` climbs back above `threshold + hysteresis`
  (default +5) — which happens naturally as students use cards
- `pool.empty` at zero is separate and always fires

**The banner (a state).** While `in_deck ≤ threshold`, the educator's room page
shows a persistent banner with the same numbers and the same call to action.
Notifications get read and forgotten; the condition persists. Deriving the
banner from current state rather than from the event is what stops a dismissed
notification from hiding an empty deck.

Students see the deck count and the `held` figure (§6) but get no alert —
restocking is not their action to take.

## 6. Live odds

Both roles see the same panel the prototype has: per-rarity count and
percentage, plus `N in deck / M total`. Percentages are derived, never stored:
`copies_remaining(rarity) / total_in_deck`. Pushed to every connected client in
the room on `room.pool_changed`.

Because the deck circulates (§3.1), this panel is now a **two-way** indicator: a
Legendary being pulled drops everyone's odds, and that same Legendary being
spent restores them, live, for the whole room. Show the direction of the change
— a brief green/red tick on the affected rarity — because the moment a rare card
comes back into circulation is the most motivating event in the game, and it is
invisible if the number just quietly changes.

Add one number the prototype has no concept of: **`held: N`**, the copies
currently in students' hands. For students it explains why the deck looks thin;
for educators it is the diagnostic for an empty deck.

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
| `card.used` | student uses a card (copy returns to deck) | ✓ | own | ✓ |
| `card.use_acknowledged` | educator ticks off a use | ✓ | own | — |
| `card.returned` | student returns an unused copy to the deck | ✓ | own | ✓ |
| `pool.updated` | educator adds/removes copies | ✓ | ✓ | — |
| `pool.low` | deck crosses below the low-stock threshold | ✓ | — | ✓ |
| `pool.empty` | last copy leaves the deck | ✓ | ✓ | ✓ |
| `pool.reset` | educator resets the deck (wipes inventories) | ✓ | ✓ | — |

Every card-related event payload carries `{ card_id, card_name, rarity }`, so a
log line reads **"Aisha used Cashflow Boost (Rare)"** rather than "Aisha used a
card". Store the name **on the event** as well as referencing the card, so a
later rename in the catalog does not silently rewrite history.
| `enrollment.added` / `enrollment.removed` | roster change | ✓ | own | — |
| `room.settings_changed` | economy rules edited | ✓ | ✓ | — |

Educator log view: whole room, filterable by student, type, and date, exportable
to CSV. Student log view: the same table filtered to `subject_enrollment_id =
me`, plus room-wide events (`pool.updated`, `pool.empty`, `pool.reset`,
`room.settings_changed`).

**Fixed rule: students never see another student's draws, uses, or token
awards** — not by name, not anonymised, and not behind a room setting. A student
sees their own activity plus room-wide events. There is no public feed.

What students *do* still see is the aggregate state of the deck: remaining
counts, live odds, and the total `held` figure (§6). That is deliberately not
the same thing — it says how many copies are out in the room, never who has
them. The per-student breakdown of who holds what is educator-only.

This has an implementation consequence worth stating, because it is easy to get
wrong: the student history endpoint filters on `subject_enrollment_id = me`
**server-side**. Never send the room's full event list and filter in the client.

## 8. Failure modes to design for

| Situation | Behaviour |
| --- | --- |
| Deck empty on draw | Reject before debiting. Educator gets a `pool.empty` notification naming how many copies are held by whom — with a circulating deck, empty means hoarded, not exhausted. |
| Deck empties mid-lesson | Draw button disables live via `room.pool_changed`, and re-enables the moment anyone uses a card. |
| Student double-clicks draw | Idempotency key replays the same result. |
| Student double-clicks "use" | The `state = 'owned'` predicate matches zero rows on the second attempt → `409 item_state_conflict`, and the copy is returned to the deck exactly once. |
| Student uses a card while the educator is editing that card's copies | Both take the room advisory lock, so they serialize. Whichever runs second sees the other's numbers. |
| Network drops after draw | Same. On reconnect the client re-sends the same key and gets the original card. |
| Educator removes a student mid-term | Enrollment → `removed`; history is retained, and their held copies are `revoked` back into the deck in the same transaction. A departed student must not hold the room's Legendary hostage for the rest of term. |
| Student moved between rooms | Not a transfer. New enrollment, fresh balance, fresh inventory. If you need to carry tokens across, do it as two explicit ledger rows. |
| Two educators edit the deck at once | Advisory lock plus optimistic concurrency (`If-Match` on a room version) → second write gets 409 and re-reads. |
| Term rollover | Archive the room; offer "clone deck configuration into a new room" so setup is not repeated. |
