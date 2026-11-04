-- The pool's accounts and deposits. An account is a pseudonym only: no email, login, or provider id is ever stored.
CREATE TABLE accounts (id TEXT PRIMARY KEY, covenant TEXT, reads_served INTEGER NOT NULL DEFAULT 0) STRICT;
CREATE TABLE tokens (hash TEXT PRIMARY KEY, account TEXT NOT NULL REFERENCES accounts(id), expires_at INTEGER NOT NULL) STRICT;
CREATE TABLE deposits (account TEXT NOT NULL REFERENCES accounts(id), id TEXT NOT NULL, stacks TEXT NOT NULL, skeleton TEXT NOT NULL, PRIMARY KEY (account, id)) STRICT;
