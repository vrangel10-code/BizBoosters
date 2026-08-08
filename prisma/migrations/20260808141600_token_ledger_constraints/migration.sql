-- Token balances can never go negative. The services check this and return a
-- clear error, but the constraint is what makes it true: any future code path
-- that debits without checking aborts its transaction instead of quietly
-- putting a student into debt.
ALTER TABLE "enrollments"
  ADD CONSTRAINT "enrollments_token_balance_non_negative"
  CHECK ("token_balance" >= 0);

ALTER TABLE "rooms"
  ADD CONSTRAINT "rooms_draw_cost_positive" CHECK ("draw_cost_tokens" > 0);
ALTER TABLE "rooms"
  ADD CONSTRAINT "rooms_trade_ratio_gt_one" CHECK ("trade_ratio" > 1);
ALTER TABLE "rooms"
  ADD CONSTRAINT "rooms_low_stock_threshold_non_negative"
  CHECK ("low_stock_threshold" >= 0);

-- A ledger row that moves nothing is noise that makes SUM(delta) reconciliation
-- harder to read and hides bugs in award/adjust arithmetic.
ALTER TABLE "token_transactions"
  ADD CONSTRAINT "token_transactions_delta_non_zero" CHECK ("delta" <> 0);

ALTER TABLE "token_transactions"
  ADD CONSTRAINT "token_transactions_balance_after_non_negative"
  CHECK ("balance_after" >= 0);

-- Only enrolled students hold balances, and only educators act on them. Both
-- are enforced in the services; these are the backstops.
ALTER TABLE "enrollments"
  ADD CONSTRAINT "enrollments_removed_at_matches_status"
  CHECK (
    (status = 'removed' AND "removed_at" IS NOT NULL)
    OR (status <> 'removed' AND "removed_at" IS NULL)
  );

ALTER TABLE "rooms"
  ADD CONSTRAINT "rooms_archived_at_matches_status"
  CHECK (
    (status = 'archived' AND "archived_at" IS NOT NULL)
    OR (status <> 'archived' AND "archived_at" IS NULL)
  );
