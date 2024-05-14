-- Up Migration

ALTER TABLE "tokens" ADD "metadata_version" NUMERIC(78, 0);

-- Down Migration

ALTER TABLE "tokens" DROP COLUMN "metadata_version";
