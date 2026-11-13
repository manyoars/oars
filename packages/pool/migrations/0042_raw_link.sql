-- A Raw Copy records which deposit it belongs to and where in that deposit it sits (t1252). `deposit` is the session key the client sets (the skeleton `id`, `deposits.id`), `place` its place among the session's transcripts (0 is the main one).
-- Both are null for a row stored before this column, or by a client that sent no link; the pack builder then recomputes the link (docs/pool-deposit-title.md section 2). The ledger row stays never deleted (0011).
ALTER TABLE raw_objects ADD COLUMN deposit TEXT;
ALTER TABLE raw_objects ADD COLUMN place INTEGER;
