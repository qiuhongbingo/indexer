-- Up Migration

ALTER TABLE "contracts" ADD COLUMN "updated_at" TIMESTAMPTZ;

-- Down Migration