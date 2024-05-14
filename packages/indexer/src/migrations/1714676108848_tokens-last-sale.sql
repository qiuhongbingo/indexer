-- Up Migration

ALTER TABLE "tokens" ADD "last_sale_timestamp" INT;
ALTER TABLE "tokens" ADD "last_sale_value" NUMERIC(78, 0);

-- Down Migration

ALTER TABLE "tokens" DROP COLUMN "last_sale_timestamp";
ALTER TABLE "tokens" DROP COLUMN "last_sale_value";
