-- The `joined_at` of the seating a hide removed (milliseconds, the Worker's clock). The hide script writes it so that it records one hide per seating by comparing two Worker-side times, not the operator's clock with the Worker's. Null on a hide recorded before this column existed.
ALTER TABLE club_hides ADD COLUMN seated_at INTEGER;
