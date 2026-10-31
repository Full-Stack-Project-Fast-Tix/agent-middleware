CREATE TABLE sign_in_throttle (
  throttle_key text PRIMARY KEY,
  attempts integer NOT NULL CHECK (attempts >= 0),
  reset_at timestamptz(3) NOT NULL
);

CREATE INDEX sign_in_throttle_reset_at_idx ON sign_in_throttle (reset_at);
