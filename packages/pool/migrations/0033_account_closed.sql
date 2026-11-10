-- When the operator closed an account (covenant 6.1, 7.2(a)): the start of the retention clock 7.2(a) names, and what sign-in, enrollment, and activation refuse on (t1063). Null while the account is open. Closing deletes nothing a Deposit holds; erasure (0027) is a separate request.
ALTER TABLE accounts ADD COLUMN closed_at INTEGER;
