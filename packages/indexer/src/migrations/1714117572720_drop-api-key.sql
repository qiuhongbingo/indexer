-- Up Migration
ALTER TABLE "payment_splits" ALTER COLUMN "api_key" DROP NOT NULL;

-- Down Migration