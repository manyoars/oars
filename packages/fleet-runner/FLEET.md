# Fleet deposit: what the owner does, and in what order

This package is private. Nothing here has been run against the real pool. A step marked **OWNER** can only be done by the owner: it needs a person, a sign-in, or a decision.

## Before a deposit

Each side and arm has its own store folder, and each store folder is its own config root: `<out>/<order id>.stores/<folder>/`. The `oars` command reads its store, its sign-in file, and its exclusion terms from there when the child's environment points there. In the steps below, "config root" means that folder, and "set the environment" means: on Windows set `APPDATA` to the config root, elsewhere set `XDG_CONFIG_HOME` to it, and in both cases set `CLAUDE_CONFIG_DIR` to `<config root>/claude`. Do it in a fresh shell for each store, and close that shell after.

Step 1 and step 6 are once. Steps 2 to 4 are done for each order's store folders: the folders are made by the order's run, so do them after the run and before the dry run. Step 5 is once per account, after the 6-hour wait.

1. **OWNER** Pick the operator account (one account, one GitHub identity). Put its pool account id in the order file as `account`. The run book records it.
2. **OWNER** Sign in once per store. Set the environment, then run `oars pool login`. It is a device flow and needs a person. It writes `<config root>/oars/sessions/pool-accounts.json`.
3. **OWNER** Write the exclusion terms once per store: a text file with one term per line at `<config root>/claude/session-commons/exclusion-terms.txt`. With no terms, every session stays out of the outbox.
4. **OWNER** Give raw consent once per store: with the environment set, run `oars pool raw --consent yes`. Without it no raw copy is queued.
5. **OWNER** Accept the covenant once for the account. With the environment set for any one store, run `oars pool deposit` (builds the batches), then `oars pool outbox` (shows them), then `oars pool deposit --send <hash>` at a terminal, and type the phrase it asks for. It cannot be scripted: a flag or a non-terminal stdin is refused. It really sends that one batch, and `--send-all` then skips it. One acceptance covers every store under the same account.
6. **OWNER** Make the company's run-book key and post the public key and the allowed-signers line on manyoars.com before the first form is sent.

`deposit-fleet` checks steps 2 and 3 for you (it refuses and names the missing file). It does not check steps 4 and 5.

## Mark the account as the fleet

7. **OWNER** After the account exists in the pool, set its source so its sessions feed the cells but drop out of the four counts. Run the dry run first, then the same line with `--confirm`, and keep the printed audit line with the run book:

   `npm run set-source -w packages/pool -- --account <operator-fleet account id> --source operator-fleet --by owner --reason "commissioned-run fleet"`

   The script refuses an account the pool has not seen yet. If it does before the first deposit, run it right after the first deposit.

## Order of commands, from run to deposit

1. Run the order. The run writes the run book (unsigned), the store folders, and the rows. Today only the fake adapter exists: `npm run run-fake -w packages/fleet-runner`.
   Then, for this order's store folders, do **OWNER** steps 2, 3, and 4 of "Before a deposit" (sign in, exclusion terms, raw consent). They need the folders the run just made.
2. **OWNER** Sign the run book: `npm run sign -w packages/fleet-runner -- <run book> <key path>`. Only a `complete` run book is signed.
3. Check it: `npm run verify-run-book -w packages/fleet-runner -- <run book> <allowed-signers file>`.
4. Wait 6 hours after the newest run ended. This is a fixed rule of `oars` (`SESSION_IDLE_HOURS` is a constant in the CLI): a session is sent only once its transcript has not grown for 6 hours. `deposit-fleet` refuses sooner and prints the earliest time.
5. Dry run (needs steps 2 and 3 done): `npm run deposit-fleet -w packages/fleet-runner -- <run book> --allowed-signers <file> --oars <path to oars>`. It prints, per store, the config root, the pool row ids it expects, and three command lines. It runs nothing.
   Then, once per account and after the 6-hour wait, do **OWNER** step 5 of "Before a deposit" (the covenant). It sends that one batch by hand.
6. **OWNER** Send: the same line with `--confirm`. Per store, with that store's environment, it runs three commands in order and stops that store at the first one that exits non-zero: (1) `oars pool deposit` builds the batches; (2) `oars pool outbox` shows them, which marks each batch shown, and `--send-all` sends only shown batches; (3) `oars pool deposit --send-all` sends them. `--send-all` never accepts a covenant: if the account has not accepted it (step 5 of "Before a deposit"), command 3 fails and `deposit-fleet` says to run `oars pool deposit --send <hash>` by hand. A store that fails is recorded and the others still run; the command then exits non-zero.
7. Read `<order id>.deposit-record.jsonl` beside the run book: one line per store with the time, the exit code of each command it ran, and the row ids expected. The signed run book is never edited.

`--oars` can be the `oars` binary, a `.cmd` or `.bat` file (Windows), or a `.js`, `.mjs`, or `.cjs` file, which this node runs.

## What a deposit does not do

- A void run is in no store and has no row id; it is never sent.
- The pool row id of a valid run is `contentHash([account, harness session id])`, the same call the `oars` deposit makes. The run book lists it before anything is sent.
