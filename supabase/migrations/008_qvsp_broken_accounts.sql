-- Records accounts qvsp sold us that failed our automated login verification.
-- Each row is a candidate for a qvsp replacement ticket — the proof_video_url
-- is a 30-day signed Supabase Storage URL that staff pastes into the claim.

CREATE TABLE IF NOT EXISTS qvsp_broken_accounts (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  order_id        UUID         NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  qvsp_id         TEXT         NOT NULL,
  qvsp_order_id   TEXT         NULL,
  reason          TEXT         NOT NULL,            -- 'login_invalid' | 'login_timeout' | …
  proof_video_url TEXT         NULL,                -- 30-day signed URL from qvsp-proofs bucket
  claimed_at      TIMESTAMPTZ  NULL,                -- when staff filed with qvsp
  claim_notes     TEXT         NULL,                -- free-form staff note (ticket id, outcome)
  resolved_at     TIMESTAMPTZ  NULL                 -- when qvsp granted the replacement or refund
);

CREATE INDEX IF NOT EXISTS qvsp_broken_accounts_order_idx    ON qvsp_broken_accounts (order_id);
CREATE INDEX IF NOT EXISTS qvsp_broken_accounts_open_idx     ON qvsp_broken_accounts (created_at DESC) WHERE claimed_at IS NULL;
CREATE INDEX IF NOT EXISTS qvsp_broken_accounts_unclaimed_idx ON qvsp_broken_accounts (resolved_at) WHERE resolved_at IS NULL;

COMMENT ON TABLE qvsp_broken_accounts IS
  'Pre-delivery verification failures. Each row is proof that a qvsp-sourced account''s credentials did not log in. Staff files replacement tickets using proof_video_url.';
