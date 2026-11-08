-- Staging is bounded (t958, S12). `staged_at` is when the pool received a part (epoch ms), so the pool can sweep an unfinished batch that was never completed: a batch's age is its oldest part's. `deposit_parts` is outside the ledger, so a sweep deletes nothing the never-delete triggers guard.
-- A part staged before this migration has no time and counts as old, so an unfinished batch left by an earlier version is swept by its account's next staging write.
ALTER TABLE deposit_parts ADD COLUMN staged_at INTEGER;
