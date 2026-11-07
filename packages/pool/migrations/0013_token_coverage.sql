-- Served cells carry the coverage of their `tokens` sum (t921). `token_sessions` is how many of the cell's sessions recorded input and `token_prompts` how many of its prompts (or steps) did, summed like `sessions`.
-- Both are NULL on a row written before this migration: its coverage was never held, so a read says it is unknown instead of taking the whole cell to be covered. A NULL stays NULL when later batches add to it (NULL + n is NULL), because a sum with an unknown part has an unknown coverage.
ALTER TABLE cells ADD COLUMN token_sessions INTEGER;
ALTER TABLE cells ADD COLUMN token_prompts INTEGER;
