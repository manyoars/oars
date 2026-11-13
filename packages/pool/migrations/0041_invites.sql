-- Founding crew and vouch codes (t1229; supply move M2). `accounts.crew_number` is the founding crew number (1 to 100) the operator's `scripts/grant-crew.ts` hands the first counting accounts, and its presence is the founding mark. Written only by that script; no route writes it.
ALTER TABLE accounts ADD COLUMN crew_number INTEGER CHECK (crew_number BETWEEN 1 AND 100);
CREATE UNIQUE INDEX accounts_crew_number ON accounts (crew_number) WHERE crew_number IS NOT NULL;
-- An invite code a founding or standing account made. The code is stored as a SHA-256 only, shown once at creation. `used_by` and `used_at` are null while the code is open; one conditional update sets both, so a code works once.
CREATE TABLE invites (id INTEGER PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, inviter TEXT NOT NULL REFERENCES accounts(id), created_at INTEGER NOT NULL, used_by TEXT REFERENCES accounts(id), used_at INTEGER) STRICT;
CREATE INDEX invites_by_inviter ON invites (inviter);
-- A vouch: who invited whom, when the code was used. Append-only (never changed); an account is vouched for at most once. Erasure of either account removes the edge (GDPR Art. 17).
CREATE TABLE vouch_edges (id INTEGER PRIMARY KEY, inviter TEXT NOT NULL REFERENCES accounts(id), invitee TEXT NOT NULL UNIQUE REFERENCES accounts(id), at INTEGER NOT NULL) STRICT;
CREATE INDEX vouch_edges_by_inviter ON vouch_edges (inviter);
CREATE TRIGGER vouch_edges_no_update BEFORE UPDATE ON vouch_edges BEGIN SELECT RAISE(ABORT, 'vouch edges are never changed'); END;
