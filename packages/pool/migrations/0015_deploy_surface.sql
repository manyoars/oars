-- The state the pool's own bounds need, held because the Worker's WAF rate rule is not the only line (t956; census S6, S7).
-- `login_polls` is one row per login handle, keyed by the handle's SHA-256 (the handle itself is never stored): `next_at` is the earliest epoch ms the pool will call the provider's token route for it again, `interval_sec` the provider's interval plus every `slow_down` it has asked for, `expires_at` when the device code dies and the row may go.
CREATE TABLE login_polls (handle_hash TEXT PRIMARY KEY, next_at INTEGER NOT NULL, interval_sec INTEGER NOT NULL, expires_at INTEGER NOT NULL);
-- `login_starts` counts the device-code requests one client has caused in one hour (`slot` is the hour as epoch ms / 3600000). `client` is an HMAC of the address under `PSEUDONYM_KEY`, so no address is kept.
CREATE TABLE login_starts (client TEXT NOT NULL, slot INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (client, slot));
-- `telemetry_quota` counts the batches one install id has sent on one UTC day.
CREATE TABLE telemetry_quota (install TEXT NOT NULL, day TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (install, day));
