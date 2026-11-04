-- The bundle route (t812): nothing is keyed by stack, so a deposit no longer records one.
ALTER TABLE deposits DROP COLUMN stacks;
