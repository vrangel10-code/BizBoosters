-- An item's timestamps must agree with its state, so a row cannot claim to be
-- 'used' while carrying no used_at — which is what makes the reporting split
-- between "spent" and "given back" trustworthy.
ALTER TABLE "inventory_items"
  ADD CONSTRAINT "inventory_items_used_at_matches_state"
  CHECK (
    (state = 'used' AND "used_at" IS NOT NULL)
    OR (state <> 'used' AND "used_at" IS NULL)
  );

-- Every terminal state has released its copy back to the deck, so all three
-- carry a returned_at. Only 'owned' holds a copy.
ALTER TABLE "inventory_items"
  ADD CONSTRAINT "inventory_items_returned_at_matches_state"
  CHECK (
    (state = 'owned' AND "returned_at" IS NULL)
    OR (state <> 'owned' AND "returned_at" IS NOT NULL)
  );

ALTER TABLE "draws"
  ADD CONSTRAINT "draws_token_cost_non_negative" CHECK ("token_cost" >= 0);

-- The roll must have been inside the deck it was rolled against. A stored roll
-- outside [0, pool_size) would mean the recorded provenance is fiction.
ALTER TABLE "draws"
  ADD CONSTRAINT "draws_roll_within_pool"
  CHECK ("pool_size" > 0 AND "roll_value" >= 0 AND "roll_value" < "pool_size");

-- The hot path for the draw: the room's remaining stock, in a stable order.
CREATE INDEX "room_cards_room_remaining_idx"
  ON "room_cards" ("room_id", "id") WHERE "copies_remaining" > 0;
