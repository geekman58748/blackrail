-- Migration 0005: Liquidity Layer for NGN settlements
-- Adds: merchant_bank_accounts, liquidity_pool, naira_settlements

-- MERCHANT BANK ACCOUNTS (Nigerian)
CREATE TABLE IF NOT EXISTS merchant_bank_accounts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  bank_name VARCHAR(100) NOT NULL,
  bank_code VARCHAR(10) NOT NULL,
  account_number VARCHAR(20) NOT NULL,
  account_name VARCHAR(200) NOT NULL,
  flutterwave_recipient_id VARCHAR(50),
  is_default BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS merchant_bank_user_unique ON merchant_bank_accounts(user_id);

-- LIQUIDITY POOL (NGN)
CREATE TABLE IF NOT EXISTS liquidity_pool (
  id SERIAL PRIMARY KEY,
  pool_name VARCHAR(100) NOT NULL DEFAULT 'main',
  balance_ngn NUMERIC(20, 2) NOT NULL DEFAULT 0,
  seeded_ngn NUMERIC(20, 2) NOT NULL DEFAULT 0,
  total_disbursed_ngn NUMERIC(20, 2) NOT NULL DEFAULT 0,
  usdc_rate NUMERIC(10, 2) NOT NULL DEFAULT 1360,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMP DEFAULT NOW() NOT NULL,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL
);

-- NAIRA SETTLEMENTS
CREATE TABLE IF NOT EXISTS naira_settlements (
  id SERIAL PRIMARY KEY,
  session_id VARCHAR(100) NOT NULL,
  merchant_user_id INTEGER NOT NULL REFERENCES users(id),
  usdc_amount NUMERIC(10, 6) NOT NULL,
  naira_amount NUMERIC(14, 2) NOT NULL,
  exchange_rate NUMERIC(10, 2) NOT NULL,
  bank_name VARCHAR(100),
  account_number VARCHAR(20),
  account_name VARCHAR(200),
  flutterwave_transfer_id VARCHAR(100),
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  status_message TEXT,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  completed_at TIMESTAMP
);
