-- The proof an acceptance carries. A row said who accepted which version and when; it did not say which text that person was shown. Each new row now names the SHA-256 of the text the client displayed (the pool checks it against the text it holds for the version), how the person answered (`typed`: they typed the phrase the screen states), and the client's name and version.
-- The columns are nullable because a row written before this migration has none of them: an acceptance by the old flag proves nothing, and NULL says so. The append-only triggers on the table are unchanged and cover the new columns, so a proof is never edited after the fact.
ALTER TABLE covenant_acceptances ADD COLUMN text_sha256 TEXT;
ALTER TABLE covenant_acceptances ADD COLUMN input TEXT;
ALTER TABLE covenant_acceptances ADD COLUMN client TEXT;
