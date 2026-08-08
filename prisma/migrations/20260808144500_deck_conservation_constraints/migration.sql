-- Card copies are conserved: every copy is either in the deck or in exactly one
-- student's hand. `copies_remaining` can therefore never exceed `copies_total`
-- nor fall below zero.
--
-- These are the constraints that make the circulating-deck model safe. Without
-- them a double-return would silently inflate the deck and the drift would only
-- surface at the end of term, unrecoverable.
ALTER TABLE "room_cards"
  ADD CONSTRAINT "room_cards_copies_total_non_negative"
  CHECK ("copies_total" >= 0);

ALTER TABLE "room_cards"
  ADD CONSTRAINT "room_cards_remaining_non_negative"
  CHECK ("copies_remaining" >= 0);

ALTER TABLE "room_cards"
  ADD CONSTRAINT "room_cards_remaining_within_total"
  CHECK ("copies_remaining" <= "copies_total");

-- Card names are what the activity log displays; a blank one makes the log
-- unreadable, which is the whole reason names are required.
ALTER TABLE "cards"
  ADD CONSTRAINT "cards_name_not_blank" CHECK (btrim("name") <> '');
