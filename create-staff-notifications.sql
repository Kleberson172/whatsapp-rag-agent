CREATE TABLE IF NOT EXISTS staff_notifications (
  notification_id TEXT PRIMARY KEY,
  customer_jid TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_staff_notifications_customer_jid
  ON staff_notifications (customer_jid);
