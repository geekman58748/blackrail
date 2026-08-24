-- Add webhook and notification settings to users
ALTER TABLE users ADD COLUMN webhook_url VARCHAR(500);
ALTER TABLE users ADD COLUMN webhook_secret VARCHAR(100);
ALTER TABLE users ADD COLUMN email_notifications BOOLEAN NOT NULL DEFAULT TRUE;
