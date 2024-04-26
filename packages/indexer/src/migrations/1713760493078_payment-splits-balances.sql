-- Up Migration

CREATE TABLE "payment_splits_balances" (
  "payment_split_address" BYTEA NOT NULL,
  "currency" BYTEA NOT NULL,
  "balance" NUMERIC(78, 0),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE "payment_splits_balances"
  ADD CONSTRAINT "payment_splits_balances_pk"
  PRIMARY KEY ("payment_split_address", "currency");

-- Down Migration

DROP TABLE "payment_splits_balances";