-- ============================================================
-- BLACKRAIL FULL DATABASE SETUP
-- Run this in Neon SQL editor on a fresh database
-- ============================================================

-- USERS
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL
);

-- WALLETS
CREATE TABLE IF NOT EXISTS wallets (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  public_key VARCHAR(100) NOT NULL,
  encrypted_private_key TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS wallets_user_id_unique ON wallets(user_id);

-- MAGIC LINKS
CREATE TABLE IF NOT EXISTS magic_links (
  id SERIAL PRIMARY KEY,
  token VARCHAR(64) NOT NULL UNIQUE,
  email VARCHAR(255) NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  used BOOLEAN DEFAULT FALSE NOT NULL,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL
);
CREATE INDEX IF NOT EXISTS magic_links_token_idx ON magic_links(token);

-- LOGIN SESSIONS
CREATE TABLE IF NOT EXISTS login_sessions (
  id SERIAL PRIMARY KEY,
  token VARCHAR(64) NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL
);
CREATE INDEX IF NOT EXISTS login_sessions_token_idx ON login_sessions(token);

-- PAYMENTS
CREATE TABLE IF NOT EXISTS payments (
  id SERIAL PRIMARY KEY,
  amount NUMERIC(10,2) NOT NULL,
  currency VARCHAR(10) DEFAULT 'USDC' NOT NULL,
  facade_address VARCHAR(100) NOT NULL,
  session_id VARCHAR(100),
  tx_hash VARCHAR(100),
  merchant_id VARCHAR(100) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS payments_session_id_unique ON payments(session_id) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS payments_merchant_created_idx ON payments(merchant_id, created_at DESC);

-- SESSIONS (checkout sessions)
CREATE TABLE IF NOT EXISTS sessions (
  id VARCHAR(100) PRIMARY KEY,
  facade_address VARCHAR(100) NOT NULL,
  label TEXT NOT NULL,
  expiry_minutes INTEGER DEFAULT 15 NOT NULL,
  amount NUMERIC(10,2),
  currency VARCHAR(10) DEFAULT 'USDC' NOT NULL,
  merchant_id VARCHAR(100) NOT NULL,
  status VARCHAR(20) DEFAULT 'active' NOT NULL,
  facade_keypair_b58 TEXT,
  checkout_token_hash VARCHAR(64),
  settlement_tx_hash VARCHAR(100),
  settlement_private BOOLEAN,
  settlement_error TEXT,
  settlement_started_at TIMESTAMP,
  settled_at TIMESTAMP,
  received_amount NUMERIC(20,6),
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  expires_at TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_merchant_status_idx ON sessions(merchant_id, status);

-- API KEYS
CREATE TABLE IF NOT EXISTS api_keys (
  id SERIAL PRIMARY KEY,
  merchant_id VARCHAR(100) NOT NULL,
  key_hash VARCHAR(200) NOT NULL,
  key_prefix VARCHAR(24) NOT NULL,
  label TEXT DEFAULT 'Default' NOT NULL,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  last_used_at TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS api_keys_key_hash_unique ON api_keys(key_hash);
