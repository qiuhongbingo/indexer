-- Up Migration

ALTER TABLE "api_keys" ADD COLUMN "orderbook_fees" JSONB NOT NULL DEFAULT '{}'::JSONB;
ALTER TABLE "api_keys" ADD COLUMN "disable_orderbook_fees" BOOLEAN DEFAULT FALSE;

-- Down Migration

ALTER TABLE "api_keys" DROP COLUMN "orderbook_fees";
