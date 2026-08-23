-- Add purpose column to magic_links to distinguish login vs reveal tokens
-- Prevents reveal tokens from being used as alternate login paths
ALTER TABLE magic_links ADD COLUMN purpose VARCHAR(20) NOT NULL DEFAULT 'login';

-- Existing tokens are all login tokens, default handles them
-- New reveal tokens will be inserted with purpose = 'reveal'
