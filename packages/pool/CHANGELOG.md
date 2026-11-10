# Changelog

`@manyoars/pool` is private (the hosted pool); this file records what changes for its callers.

## Unreleased

- Boards are braked (migration `0037`): per account, the 11th wrong club code in a rolling hour and the 6th club created in a rolling day are 429 `rate_limited` with `retry_after`, and a parallel burst cannot pass either limit. The attempts are in the account export and removed by `erase account`.
- A nickname is NFKC-normalized, 2 to 24 letters (combining marks included), digits, space, `-`, `_`, or `.`, with no edge space, `@`, or web address, else 422 `nickname_invalid` (was `bad_nickname`).
- `npm run hide-nickname` lets the operator remove a member's nickname and records who and why (`club_hides`, in the account export and removed by `erase account`).
- Boards: per-account weekly counts (`account_weeks`, migration `0036`), private clubs joined by a code (`POST /v1/clubs`, `POST /v1/clubs/join`, `GET /v1/clubs/:id`, `DELETE /v1/clubs/:id/me`, `GET /v1/clubs/consent`), and a public open board (`GET /v1/board`) that lists an account after 90 days of standing or a hand grant (`npm run grant-standing`). Ranked by weeks rowing, then active days; tokens and cost are never held or ranked. See `docs/pool.md`, "Boards".
- Rights: the operator can give a confirmed requester their export and record their raw-consent withdrawal when the requester cannot use the client. `npm run erase -w packages/pool -- export --account <id> --out <folder> [--raw] [--local]` writes the same `account-export-NNNN.json` pages `oars pool export` returns (one shared page builder), and `erase withdraw --account <id> [--confirm] [--local]` runs the same update the route runs (`WITHDRAW_RAW_CONSENT`) and drops the account's staged raw parts. See `docs/pool-rights.md`.
- The pool deploys itself: `.github/workflows/deploy-pool.yml` applies every unapplied D1 migration and deploys the Worker after each passing `ci` run on `main`, tags the Worker version with the commit, and reads the live pool as a smoke check. `docs/pool.md` says where to read the deployed commit.
