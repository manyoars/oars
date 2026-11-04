-- A fetch reads the same number of rows however many deposits and accounts the pool holds. The access check asks for an account's earliest counting date, which the primary key would find only by walking every one of its ledger rows; and the week's reset asks for the accounts whose count is from an earlier week, which would scan every account.
CREATE INDEX deposits_counted ON deposits (account, counted_at) WHERE counted_at IS NOT NULL AND tier <> 'none';
CREATE INDEX accounts_by_fetch_week ON accounts (fetch_week);
