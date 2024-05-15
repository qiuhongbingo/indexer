-- Up Migration

CREATE TABLE "rate_limit_rules" (
  id SERIAL PRIMARY KEY,
  route TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT '',
  tier INT,
  api_key TEXT NOT NULL DEFAULT '',
  options JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Down Migration

DROP TABLE "rate_limit_rules";