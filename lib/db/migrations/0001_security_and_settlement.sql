UPDATE sessions SET merchant_id = 'legacy-unowned' WHERE merchant_id IS NULL;
UPDATE payments SET merchant_id = 'legacy-unowned' WHERE merchant_id IS NULL;
ALTER TABLE sessions ALTER COLUMN merchant_id SET NOT NULL;
ALTER TABLE payments ALTER COLUMN merchant_id SET NOT NULL;
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS checkout_token_hash varchar(64),
  ADD COLUMN IF NOT EXISTS settlement_tx_hash varchar(100),
  ADD COLUMN IF NOT EXISTS settlement_private boolean,
  ADD COLUMN IF NOT EXISTS settlement_error text,
  ADD COLUMN IF NOT EXISTS settlement_started_at timestamp,
  ADD COLUMN IF NOT EXISTS settled_at timestamp,
  ADD COLUMN IF NOT EXISTS received_amount numeric(20, 6);
DELETE FROM payments a USING payments b
WHERE a.session_id IS NOT NULL AND a.session_id = b.session_id AND a.id < b.id;
CREATE UNIQUE INDEX IF NOT EXISTS payments_session_id_unique ON payments(session_id) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS sessions_merchant_status_idx ON sessions(merchant_id, status);
CREATE INDEX IF NOT EXISTS payments_merchant_created_idx ON payments(merchant_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS api_keys_key_hash_unique ON api_keys(key_hash);