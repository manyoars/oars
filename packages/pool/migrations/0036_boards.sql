-- Boards (t1083; virality loop 2, P100 (19) to (21)). Counts only, never a token, a cost, or a session: nothing here can rank by volume because nothing here holds it.
-- `account_weeks` is the account's own count per ISO week, written by ingest in the transaction that writes the deposit's cells. A week is the one the deposit first counted in (`deposits.counted_at`), so a resend never moves a session to another week.
-- `day_mask` has bit 0 for Monday through bit 6 for Sunday: the UTC weekdays with a counting deposit. `harnesses` is a sorted JSON array of the harness names. A resend that stops counting takes its sessions and steps back and leaves its day and harness marks (a union cannot be unmixed).
CREATE TABLE account_weeks (account TEXT NOT NULL REFERENCES accounts(id), week TEXT NOT NULL, sessions INTEGER NOT NULL, tool_steps INTEGER NOT NULL, failed_steps INTEGER NOT NULL, day_mask INTEGER NOT NULL, harnesses TEXT NOT NULL, PRIMARY KEY (account, week)) STRICT, WITHOUT ROWID;
-- A club is a board for people who hold its code. The code is stored as a SHA-256 only; `open` is the one reserved club (no code), whose members the public board lists once they have standing.
CREATE TABLE clubs (id TEXT PRIMARY KEY, name TEXT NOT NULL, code_hash TEXT UNIQUE, created_at INTEGER NOT NULL) STRICT, WITHOUT ROWID;
INSERT INTO clubs (id, name, code_hash, created_at) VALUES ('open', 'Open board', NULL, 0);
CREATE TABLE club_members (club TEXT NOT NULL REFERENCES clubs(id), account TEXT NOT NULL REFERENCES accounts(id), nickname TEXT NOT NULL, joined_at INTEGER NOT NULL, PRIMARY KEY (club, account)) STRICT, WITHOUT ROWID;
CREATE UNIQUE INDEX club_members_nickname ON club_members (club, nickname COLLATE NOCASE);
-- The consent a join records: the SHA-256 of the exact text the person was shown and when they said yes. It holds no nickname. Append-only like `covenant_acceptances`; a rejoin adds a row.
CREATE TABLE club_consents (id INTEGER PRIMARY KEY, account TEXT NOT NULL REFERENCES accounts(id), club TEXT NOT NULL REFERENCES clubs(id), text_sha256 TEXT NOT NULL, accepted_at INTEGER NOT NULL) STRICT;
CREATE TRIGGER club_consents_no_delete BEFORE DELETE ON club_consents BEGIN SELECT RAISE(ABORT, 'ledger rows are never deleted'); END;
CREATE TRIGGER club_consents_no_update BEFORE UPDATE ON club_consents BEGIN SELECT RAISE(ABORT, 'consent rows are never changed'); END;
-- Standing granted by hand to an account (the operator's own fleet). Written only by `scripts/grant-standing.ts`; no route writes it.
CREATE TABLE board_standing (account TEXT PRIMARY KEY REFERENCES accounts(id), granted_at INTEGER NOT NULL, granted_by TEXT NOT NULL, reason TEXT NOT NULL) STRICT, WITHOUT ROWID;
