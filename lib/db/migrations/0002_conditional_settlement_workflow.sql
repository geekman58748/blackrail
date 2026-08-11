ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS settlement_mode varchar(20) NOT NULL DEFAULT 'standard',
  ADD COLUMN IF NOT EXISTS settlement_step varchar(40) NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS intent_address varchar(100),
  ADD COLUMN IF NOT EXISTS intent_init_tx_hash varchar(100),
  ADD COLUMN IF NOT EXISTS intent_delegate_tx_hash varchar(100),
  ADD COLUMN IF NOT EXISTS release_tx_hash varchar(100);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sessions_settlement_mode_check'
  ) THEN
    ALTER TABLE sessions ADD CONSTRAINT sessions_settlement_mode_check
      CHECK (settlement_mode IN ('standard', 'conditional'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sessions_settlement_step_check'
  ) THEN
    ALTER TABLE sessions ADD CONSTRAINT sessions_settlement_step_check
      CHECK (settlement_step IN (
        'pending',
        'intent_initialized',
        'intent_delegated',
        'release_authorized',
        'settled',
        'failed'
      ));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS sessions_settlement_workflow_idx
  ON sessions(settlement_mode, settlement_step, settlement_started_at);