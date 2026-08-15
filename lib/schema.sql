-- FOUNDRY schema. Idempotent: safe to re-run on every deploy.
-- Two tables are append-only by construction: ledger_entries and decisions.
-- Append-only is enforced in the database, not just in application code, so a
-- bug in the agent cannot rewrite its own financial or reasoning history.

CREATE TABLE IF NOT EXISTS hypotheses (
  id              TEXT PRIMARY KEY,
  niche           TEXT        NOT NULL,
  thesis          TEXT        NOT NULL,
  target_customer TEXT        NOT NULL DEFAULT '',
  offer           TEXT        NOT NULL DEFAULT '',
  price_cents     INTEGER     NOT NULL DEFAULT 0,
  confidence      REAL        NOT NULL DEFAULT 0.5,
  reasoning       TEXT        NOT NULL DEFAULT '',
  source          TEXT        NOT NULL DEFAULT 'agent',
  business_id     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS businesses (
  id            TEXT PRIMARY KEY,
  slug          TEXT        NOT NULL UNIQUE,
  name          TEXT        NOT NULL,
  niche         TEXT        NOT NULL,
  tagline       TEXT        NOT NULL DEFAULT '',
  hypothesis_id TEXT REFERENCES hypotheses (id),
  url           TEXT        NOT NULL DEFAULT '',
  price_cents   INTEGER     NOT NULL DEFAULT 2900,
  currency      TEXT        NOT NULL DEFAULT 'usd',
  -- TESTING -> the default on spawn; SCALING once it converts; KILLED when the
  -- kill thresholds trip.
  status        TEXT        NOT NULL DEFAULT 'TESTING'
                 CHECK (status IN ('TESTING', 'SCALING', 'KILLED')),
  visitors      INTEGER     NOT NULL DEFAULT 0,
  conversions   INTEGER     NOT NULL DEFAULT 0,
  -- Integration-test fixtures are real rows against the real database, but they
  -- are excluded from the portfolio and the P&L so a test run never moves the
  -- numbers a judge is looking at.
  is_fixture    BOOLEAN     NOT NULL DEFAULT false,
  kill_reason   TEXT,
  killed_at     TIMESTAMPTZ,
  meta          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The P&L. Positive amounts are money in, negative are money out.
-- `kind` splits COGS (bought human labor) from OPEX (infrastructure, traffic)
-- so the dashboard can break COGS out of the running P&L.
CREATE TABLE IF NOT EXISTS ledger_entries (
  id          TEXT PRIMARY KEY,
  business_id TEXT,
  kind        TEXT        NOT NULL
               CHECK (kind IN ('REVENUE', 'REFUND', 'COGS', 'OPEX')),
  amount_cents BIGINT     NOT NULL,
  currency    TEXT        NOT NULL DEFAULT 'usd',
  description TEXT        NOT NULL DEFAULT '',
  source      TEXT        NOT NULL DEFAULT 'foundry',
  -- Stripe event / session id, Terac opportunity id, … . Unique so a replayed
  -- webhook can never double-book revenue.
  external_id TEXT UNIQUE,
  meta        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ledger_entries_business_idx ON ledger_entries (business_id);
CREATE INDEX IF NOT EXISTS ledger_entries_created_idx  ON ledger_entries (created_at DESC);

-- Append-only record of every judgement the agent made, with its real reasoning.
CREATE TABLE IF NOT EXISTS decisions (
  id           TEXT PRIMARY KEY,
  cycle_id     TEXT        NOT NULL,
  business_id  TEXT,
  action       TEXT        NOT NULL,
  reasoning    TEXT        NOT NULL,
  confidence   REAL        NOT NULL DEFAULT 0.5,
  model        TEXT        NOT NULL DEFAULT '',
  inputs       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  outputs      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS decisions_created_idx ON decisions (created_at DESC);
CREATE INDEX IF NOT EXISTS decisions_cycle_idx   ON decisions (cycle_id);

CREATE TABLE IF NOT EXISTS escalations (
  id                TEXT PRIMARY KEY,
  business_id       TEXT,
  question          TEXT        NOT NULL,
  expert_profile    TEXT        NOT NULL DEFAULT '',
  confidence        REAL        NOT NULL DEFAULT 0,
  provider          TEXT        NOT NULL DEFAULT 'stub',
  quote_id          TEXT,
  quote_total_cents BIGINT      NOT NULL DEFAULT 0,
  -- 'purchased' | 'declined'. A decline is a first-class outcome, not an error.
  decision          TEXT        NOT NULL DEFAULT 'declined',
  reason            TEXT        NOT NULL DEFAULT '',
  opportunity_id    TEXT,
  answer            TEXT,
  status            TEXT        NOT NULL DEFAULT 'open',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS escalations_business_idx ON escalations (business_id);

CREATE TABLE IF NOT EXISTS labor_quotes (
  id                       TEXT PRIMARY KEY,
  escalation_id            TEXT REFERENCES escalations (id),
  business_id              TEXT,
  provider                 TEXT        NOT NULL,
  provider_quote_id        TEXT        NOT NULL,
  total_cost_cents         BIGINT      NOT NULL,
  cost_per_participant_cents BIGINT    NOT NULL DEFAULT 0,
  timeline_hours           REAL        NOT NULL DEFAULT 0,
  submission_count         INTEGER     NOT NULL DEFAULT 1,
  expires_at               TIMESTAMPTZ,
  reasoning                TEXT        NOT NULL DEFAULT '',
  raw                      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Real pageviews on spawned businesses. This is what "traffic" means here:
-- a beacon fired by the deployed page, not a number the agent invents.
CREATE TABLE IF NOT EXISTS visits (
  id          TEXT PRIMARY KEY,
  business_id TEXT        NOT NULL,
  path        TEXT        NOT NULL DEFAULT '/',
  referrer    TEXT        NOT NULL DEFAULT '',
  source      TEXT        NOT NULL DEFAULT 'organic',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS visits_business_idx ON visits (business_id);

-- Postgres implementation of the coordination bus (FOUNDRY_BUS_PROVIDER=postgres).
CREATE TABLE IF NOT EXISTS bus_messages (
  id           TEXT PRIMARY KEY,
  topic        TEXT        NOT NULL,
  payload      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  status       TEXT        NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'claimed', 'done')),
  claimed_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bus_messages_topic_idx ON bus_messages (topic, status);

-- Single-row kill switch the circuit breaker latches. Once tripped, no code
-- path that spends money will run until it is explicitly reset.
CREATE TABLE IF NOT EXISTS circuit_breaker (
  id         INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  tripped    BOOLEAN     NOT NULL DEFAULT false,
  reason     TEXT        NOT NULL DEFAULT '',
  tripped_at TIMESTAMPTZ
);

INSERT INTO circuit_breaker (id, tripped) VALUES (1, false)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Forward migrations for databases created by an earlier revision.
-- ---------------------------------------------------------------------------

ALTER TABLE businesses     ADD COLUMN IF NOT EXISTS is_fixture BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE businesses     ADD COLUMN IF NOT EXISTS tagline    TEXT    NOT NULL DEFAULT '';
ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS source     TEXT    NOT NULL DEFAULT 'foundry';
ALTER TABLE escalations    ADD COLUMN IF NOT EXISTS answer     TEXT;

-- ---------------------------------------------------------------------------
-- Append-only enforcement.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION foundry_append_only() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'append-only table %: % is not permitted', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ledger_entries_append_only ON ledger_entries;
CREATE TRIGGER ledger_entries_append_only
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION foundry_append_only();

DROP TRIGGER IF EXISTS decisions_append_only ON decisions;
CREATE TRIGGER decisions_append_only
  BEFORE UPDATE OR DELETE ON decisions
  FOR EACH ROW EXECUTE FUNCTION foundry_append_only();
