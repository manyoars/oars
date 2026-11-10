-- Where a request came from, and what the person said about where they are. An acceptance now stores the answer to "Are you in the EU, the EEA, or the UK?" (`yes` or `no`) and the two-letter country Cloudflare reported for the request; a deposit stores the country of its request. The country is NULL when Cloudflare gave none.
-- The columns are nullable because a row written before this migration has none of them. The append-only triggers on the acceptance table are unchanged and cover the new columns.
ALTER TABLE covenant_acceptances ADD COLUMN eu_eea_uk TEXT;
ALTER TABLE covenant_acceptances ADD COLUMN request_country TEXT;
ALTER TABLE deposits ADD COLUMN request_country TEXT;
