# API surface

REST, JSON, versioned at `/api/v1`. Session cookie auth. All mutating requests
accept an `Idempotency-Key` header; it is **required** on draws and trades.

## Conventions

- Errors: `{ "error": { "code": "insufficient_tokens", "message": "…", "details": {} } }`
  with machine-readable `code`. The UI switches on `code`, never on `message`.
- Unauthorized access to a room returns **404**, not 403 — do not confirm that a
  room exists to someone who is not in it.
- Lists are cursor-paginated: `?cursor=&limit=` → `{ data: [], next_cursor }`.
- Timestamps are ISO-8601 UTC; the client renders in the school's timezone.

## Auth

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/auth/login` | `{ identifier, password }` — accepts an email or a student login ID. Returns the user and `must_change_password`. |
| POST | `/auth/logout` | Revokes the current session. |
| POST | `/auth/change-password` | `{ current_password, new_password }`. The **only** route reachable while `must_change_password` is set. Revokes all other sessions. |
| POST | `/auth/forgot-password` | Educators only (email). Students go through their educator. |
| GET | `/auth/me` | Session user + rooms + unread notification count. |

## Student

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/rooms` | Rooms this student is enrolled in, with token balance per room. |
| GET | `/rooms/:roomId` | Room detail: name, rules, live odds, deck totals. |
| GET | `/rooms/:roomId/inventory` | Owned copies, stacked by card, with states. |
| GET | `/rooms/:roomId/pool` | Live per-rarity counts and percentages, and — if `students_see_odds` — the full deck list (mirrors the prototype's "View Full Deck List"). |
| POST | `/rooms/:roomId/draws` | Spend tokens, draw one card. `Idempotency-Key` required. → `{ draw, card, new_balance, pool }` |
| POST | `/rooms/:roomId/trades` | `{ from_rarity, item_ids: [uuid × trade_ratio] }`. `Idempotency-Key` required. |
| POST | `/inventory/:itemId/use` | `{ note? }` → spends the card immediately, no approval. Returns the copy to the deck and notifies the room's educators. `Idempotency-Key` recommended. → `{ item, pool }` |
| POST | `/inventory/:itemId/return` | Give an unused copy back to the deck. |
| GET | `/rooms/:roomId/history` | This student's activity in this room. |
| GET | `/notifications` | `?unread=true` |
| POST | `/notifications/read` | `{ ids: [] }` or `{ all: true }` |

## Educator

| Method | Path | Notes |
| --- | --- | --- |
| GET/POST | `/rooms` | List owned rooms / create a room. |
| PATCH | `/rooms/:roomId` | Name, status, economy rules, `low_stock_threshold`. `If-Match` on room version. |
| POST | `/rooms/:roomId/archive` | Term end. |
| POST | `/rooms/:roomId/clone` | New room from this deck configuration. |
| GET | `/rooms/:roomId/students` | Roster with balances and inventory counts. |
| POST | `/rooms/:roomId/students` | Add existing students by ID, or create new ones. |
| POST | `/rooms/:roomId/students/import` | CSV upload → creates users, returns generated credentials **once**. |
| DELETE | `/rooms/:roomId/students/:enrollmentId` | Soft-remove; retains history. |
| POST | `/rooms/:roomId/students/:enrollmentId/reset-password` | Generates a new default password, sets `must_change_password`, revokes sessions. |
| GET | `/rooms/:roomId/students/:enrollmentId/inventory` | Educator drill-down into one student's cards. |
| POST | `/rooms/:roomId/tokens/award` | `{ enrollment_ids: [], amount, note }` — one ledger row per student. |
| POST | `/rooms/:roomId/tokens/adjust` | `{ enrollment_id, delta \| target_balance, note }` — note mandatory. |
| POST | `/token-transactions/:id/undo` | Writes the inverse row, linked to the original. |
| GET | `/rooms/:roomId/deck` | Every card with `copies_total`, `in_deck`, `held_by_students`. |
| PUT | `/rooms/:roomId/deck` | Bulk set the deck by **total** copies. `{ entries: [{ card_id, copies_total }] }`. The server derives `copies_remaining`; a total below the number currently held is capped and reported back in `details.capped`. |
| POST | `/rooms/:roomId/deck/reset` | **Reset Deck.** Revokes every student's inventory in the room and refills every card to `copies_total`, atomically. Destructive, educator-only, requires `{ confirm: "<room name>" }`; optional `{ reset_tokens: true }` also zeroes balances via ledger rows. |
| GET | `/rooms/:roomId/uses` | Recent card uses. `?acknowledged=false` is the educator's "perks I still owe" list. |
| POST | `/inventory/:itemId/acknowledge` | `{ note? }` — ticks off a use. Gates nothing; the card is already spent. |
| GET | `/rooms/:roomId/activity` | Full room log. `?type=&enrollment_id=&from=&to=` |
| GET | `/rooms/:roomId/activity/export` | CSV. |

## Card catalog (educator / school_admin)

| Method | Path | Notes |
| --- | --- | --- |
| GET/POST | `/cards` | School-wide catalog. |
| PATCH | `/cards/:id` | Rename, edit optional effect/description, set rarity (rarity locked once the card is in any live deck). Renaming affects future display only — past activity events keep the name they recorded. |
| POST | `/cards/:id/image` | Multipart upload → validated, resized, stored, returns `image_key`. |
| POST | `/cards/:id/archive` | Hide from new decks; existing decks unaffected. |

## Realtime

`GET /api/v1/stream` — SSE, scoped to the session, subscribed to every room the
user belongs to. Supports `Last-Event-ID` for gap-free reconnect.

```
event: notification
data: {"id":"…","type":"card.used","room_id":"…","payload":{…}}

event: room.pool_changed
data: {"room_id":"…","remaining":{"C":57,"U":30,"R":10,"L":3},
       "in_deck":100,"held":3,"total":103,"cause":"card.used"}

event: tokens.changed
data: {"room_id":"…","enrollment_id":"…","balance":40,"delta":20}

event: heartbeat
data: {"t":"2026-08-05T10:00:00Z"}
```

Heartbeat every 25 s to keep proxies from closing the stream. Client falls back
to polling `/notifications` and `/rooms/:id/pool` every 20 s after two failed
reconnects.

## Error codes

| Code | HTTP | Meaning |
| --- | --- | --- |
| `invalid_credentials` | 401 | |
| `account_locked` | 423 | Too many failed logins. |
| `password_change_required` | 403 | First-login gate. |
| `insufficient_tokens` | 409 | Includes `details.required` and `details.balance`. |
| `pool_empty` | 409 | No copies in the deck; tokens untouched. Includes `details.held_by_students` — with a circulating deck this is always the explanation. |
| `target_rarity_empty` | 409 | Trade target out of stock. |
| `invalid_trade_selection` | 422 | Wrong count, wrong rarity, or items not owned. |
| `item_not_owned` | 404 | |
| `item_state_conflict` | 409 | The copy already left `owned` — used, returned, or revoked. Also the safe outcome of a double-click on "use". |
| `room_archived` | 409 | No mutations on archived rooms. |
| `version_conflict` | 409 | Stale `If-Match` on room/deck edit. |
| `rate_limited` | 429 | With `Retry-After`. |
