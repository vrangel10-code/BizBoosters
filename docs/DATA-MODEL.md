# Data model

PostgreSQL. Every table below exists because some screen or rule in the brief
needs it; the "why" column is the justification.

## 1. Core concepts, and the distinction that matters most

Three different things are all called "a card" in casual conversation. Keeping
them separate is the single most important modelling decision:

| Concept | Table | Meaning |
| --- | --- | --- |
| **Card definition** | `cards` | "Cashflow Boost" — a name, art, rarity, effect text. Owned by the school, reusable across every room. |
| **Pool stock** | `room_cards` | "Room 7B has 10 copies of Cashflow Boost, 6 remaining." The finite shared deck. |
| **Owned copy** | `inventory_items` | "Aisha holds one Cashflow Boost, unused." One row per physical copy. |

The prototype has only the middle one, and fakes the third by computing
`maxPerType - remaining`. That is why it cannot support more than one player.

Note also that the prototype's cards have **no names** — they are bare image
URLs. Cards need identity (name, description, effect text) or your activity log
reads "student used a card" and your inventory is an unlabelled photo album.

## 2. Schema

```sql
-- ─── Tenancy ────────────────────────────────────────────────────────────────
CREATE TABLE schools (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  timezone      text NOT NULL DEFAULT 'UTC',   -- activity logs render in this
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ─── Identity ───────────────────────────────────────────────────────────────
CREATE TYPE user_role AS ENUM ('student','educator','school_admin','super_admin');

CREATE TABLE users (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id            uuid REFERENCES schools(id) ON DELETE CASCADE,
  role                 user_role NOT NULL,
  display_name         text NOT NULL,
  email                citext UNIQUE,          -- educators only
  login_id             citext UNIQUE,          -- students only, e.g. 'apex-4821'
  password_hash        text NOT NULL,
  must_change_password boolean NOT NULL DEFAULT false,
  is_active            boolean NOT NULL DEFAULT true,
  failed_login_count   int NOT NULL DEFAULT 0,
  locked_until         timestamptz,
  last_login_at        timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT identity_present CHECK (email IS NOT NULL OR login_id IS NOT NULL)
);

CREATE TABLE sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,            -- sha256 of the cookie value
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  user_agent  text,
  ip          inet,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON sessions (user_id) WHERE revoked_at IS NULL;

-- ─── Rooms ──────────────────────────────────────────────────────────────────
CREATE TYPE room_status AS ENUM ('draft','active','archived');

CREATE TABLE rooms (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id              uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name                   text NOT NULL,
  join_code              citext UNIQUE,        -- optional self-enrol code
  status                 room_status NOT NULL DEFAULT 'draft',

  -- economy + rules, per room (see MECHANICS.md)
  draw_cost_tokens       int  NOT NULL DEFAULT 20  CHECK (draw_cost_tokens > 0),
  trades_enabled         boolean NOT NULL DEFAULT true,
  trade_ratio            int  NOT NULL DEFAULT 3   CHECK (trade_ratio > 1),
  use_requires_approval  boolean NOT NULL DEFAULT true,
  used_card_returns_to_pool boolean NOT NULL DEFAULT false,
  students_see_odds      boolean NOT NULL DEFAULT true,
  leaderboard_enabled    boolean NOT NULL DEFAULT false,

  created_by             uuid NOT NULL REFERENCES users(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  archived_at            timestamptz
);

CREATE TYPE room_educator_role AS ENUM ('owner','assistant');
CREATE TABLE room_educators (
  room_id  uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role     room_educator_role NOT NULL DEFAULT 'assistant',
  PRIMARY KEY (room_id, user_id)
);

-- One row per (student, room). Tokens and inventory hang off THIS, not off the
-- user — a student in three rooms has three independent balances and decks.
CREATE TYPE enrollment_status AS ENUM ('active','removed');
CREATE TABLE enrollments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id        uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  student_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status         enrollment_status NOT NULL DEFAULT 'active',
  token_balance  int NOT NULL DEFAULT 0 CHECK (token_balance >= 0),
  seat_label     text,                          -- optional, e.g. group/table
  joined_at      timestamptz NOT NULL DEFAULT now(),
  removed_at     timestamptz,
  UNIQUE (room_id, student_id)
);
CREATE INDEX ON enrollments (student_id) WHERE status = 'active';

-- ─── Cards ──────────────────────────────────────────────────────────────────
CREATE TYPE rarity_code AS ENUM ('C','U','R','L');

-- Per-room presentation/labels for rarities. Keeps the enum stable while
-- letting a room rename "Legendary" to "Founder Tier" and restyle it.
CREATE TABLE room_rarities (
  room_id     uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  code        rarity_code NOT NULL,
  label       text NOT NULL,
  color_hex   text NOT NULL,
  sort_order  int  NOT NULL,
  PRIMARY KEY (room_id, code)
);

CREATE TABLE cards (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id    uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name         text NOT NULL,
  description  text,
  effect_text  text,          -- what the student actually gets when they use it
  rarity       rarity_code NOT NULL,
  image_key    text,          -- object-storage key, NOT a URL
  is_archived  boolean NOT NULL DEFAULT false,
  created_by   uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, name)
);

-- The finite shared deck for one room.
CREATE TABLE room_cards (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id           uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  card_id           uuid NOT NULL REFERENCES cards(id) ON DELETE RESTRICT,
  copies_total      int NOT NULL CHECK (copies_total >= 0),
  copies_remaining  int NOT NULL CHECK (copies_remaining >= 0),
  UNIQUE (room_id, card_id),
  CONSTRAINT remaining_lte_total CHECK (copies_remaining <= copies_total)
);
-- Hot path for the draw: "all rows in this room with stock left".
CREATE INDEX ON room_cards (room_id) INCLUDE (copies_remaining);

-- ─── Inventory ──────────────────────────────────────────────────────────────
-- One row per owned copy. The UI stacks by card_id for display.
CREATE TYPE item_state AS ENUM ('owned','use_pending','used','returned','revoked');
CREATE TYPE acquisition AS ENUM ('draw','trade','educator_grant','transfer');

CREATE TABLE inventory_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id  uuid NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  room_id        uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, -- denorm
  card_id        uuid NOT NULL REFERENCES cards(id),
  state          item_state NOT NULL DEFAULT 'owned',
  acquired_via   acquisition NOT NULL,
  acquired_at    timestamptz NOT NULL DEFAULT now(),
  used_at        timestamptz,
  returned_at    timestamptz,
  draw_id        uuid   -- FK added after `draws` exists; see ALTER below
);
-- ALTER TABLE inventory_items ADD CONSTRAINT inventory_items_draw_fk
--   FOREIGN KEY (draw_id) REFERENCES draws(id);
CREATE INDEX ON inventory_items (enrollment_id, state);
CREATE INDEX ON inventory_items (room_id, state);

-- ─── Draws ──────────────────────────────────────────────────────────────────
CREATE TYPE draw_kind AS ENUM ('token_draw','trade_upgrade');

CREATE TABLE draws (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id          uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  enrollment_id    uuid NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  kind             draw_kind NOT NULL,
  token_cost       int NOT NULL DEFAULT 0,
  result_card_id   uuid NOT NULL REFERENCES cards(id),
  result_rarity    rarity_code NOT NULL,
  -- provenance for dispute resolution: what the odds actually were
  pool_snapshot    jsonb NOT NULL,   -- {"C":58,"U":30,"R":10,"L":3}
  roll_value       double precision NOT NULL,
  idempotency_key  text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (enrollment_id, idempotency_key)
);
CREATE INDEX ON draws (room_id, created_at DESC);

CREATE TABLE trades (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draw_id         uuid NOT NULL REFERENCES draws(id) ON DELETE CASCADE,
  enrollment_id   uuid NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  from_rarity     rarity_code NOT NULL,
  to_rarity       rarity_code NOT NULL,
  consumed_items  uuid[] NOT NULL      -- inventory_items surrendered
);

-- ─── Token ledger ───────────────────────────────────────────────────────────
-- Append-only. enrollments.token_balance is a cache maintained in the same
-- transaction; SUM(delta) must always equal it (see the reconciliation job).
CREATE TYPE token_reason AS ENUM (
  'educator_award','educator_adjustment','draw_spend','draw_refund',
  'enrollment_transfer','system_correction'
);

CREATE TABLE token_transactions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id  uuid NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  delta          int NOT NULL CHECK (delta <> 0),
  balance_after  int NOT NULL,
  reason         token_reason NOT NULL,
  note           text,                          -- "Great pitch in week 4"
  actor_user_id  uuid REFERENCES users(id),     -- null for system
  related_type   text,                          -- 'draw' | 'trade' | ...
  related_id     uuid,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON token_transactions (enrollment_id, created_at DESC);

-- ─── Card use / redemption ──────────────────────────────────────────────────
CREATE TYPE use_status AS ENUM ('pending','approved','rejected','cancelled');

CREATE TABLE card_use_requests (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inventory_item_id  uuid NOT NULL UNIQUE REFERENCES inventory_items(id) ON DELETE CASCADE,
  enrollment_id      uuid NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  room_id            uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  status             use_status NOT NULL DEFAULT 'pending',
  student_note       text,
  educator_note      text,
  requested_at       timestamptz NOT NULL DEFAULT now(),
  resolved_at        timestamptz,
  resolved_by        uuid REFERENCES users(id)
);
CREATE INDEX ON card_use_requests (room_id, status);

-- ─── Activity + notifications ───────────────────────────────────────────────
-- The room's shared history. Every mutation writes exactly one row here.
CREATE TABLE activity_events (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id             uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  type                text NOT NULL,   -- see MECHANICS.md §7 for the vocabulary
  actor_user_id       uuid REFERENCES users(id),
  subject_enrollment_id uuid REFERENCES enrollments(id),
  payload             jsonb NOT NULL DEFAULT '{}',
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON activity_events (room_id, created_at DESC);
CREATE INDEX ON activity_events (subject_enrollment_id, created_at DESC);

-- Per-recipient delivery + read state. Derived from activity, stored separately
-- because "has Aisha read this" is not a property of the room's history.
CREATE TABLE notifications (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  room_id            uuid REFERENCES rooms(id) ON DELETE CASCADE,
  activity_event_id  uuid REFERENCES activity_events(id) ON DELETE CASCADE,
  type               text NOT NULL,
  payload            jsonb NOT NULL DEFAULT '{}',
  read_at            timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON notifications (recipient_user_id, created_at DESC)
  WHERE read_at IS NULL;

-- ─── Admin audit ────────────────────────────────────────────────────────────
-- Educator/admin actions on accounts (password resets, removals, role changes).
-- Separate from activity_events: that is game history students can see, this is
-- account history they cannot.
CREATE TABLE audit_log (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id  uuid REFERENCES users(id),
  target_user_id uuid REFERENCES users(id),
  action         text NOT NULL,
  payload        jsonb NOT NULL DEFAULT '{}',
  ip             inet,
  created_at     timestamptz NOT NULL DEFAULT now()
);
```

## 3. Invariants worth enforcing

Some can be DB constraints; the rest belong in a nightly reconciliation job that
alerts rather than silently repairs.

| Invariant | Enforced by |
| --- | --- |
| `token_balance >= 0` | CHECK constraint |
| `copies_remaining BETWEEN 0 AND copies_total` | CHECK constraint |
| `enrollments.token_balance = SUM(token_transactions.delta)` | nightly job + alert |
| copies of card X in room = `copies_remaining` + items in `owned`/`use_pending` (+ `used`, if `used_card_returns_to_pool = false`) | nightly job + alert |
| a student cannot hold an item for a card not in their room's pool | FK + service check |
| exactly one `pending` use request per item | UNIQUE on `inventory_item_id` |

The second-to-last one is the real integrity check on the whole economy: **card
copies are conserved**. Every copy is either in the deck, in someone's hand, or
spent. If that sum drifts, you have a bug in a transaction boundary and you want
to know the same night, not at the end of term.

## 4. Sizing

A room of 30 students over a 12-week term generates on the order of 1–2k
`activity_events`, a few hundred `draws`, and a few thousand
`token_transactions`. A school of 50 rooms is comfortably under a million rows a
year. There is no scaling problem here — design for correctness and for clear
queries, not for throughput.
