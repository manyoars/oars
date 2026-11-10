# Changelog

`@manyoars/pool` is private (the hosted pool); this file records what changes for its callers.

## Unreleased

- Boards: per-account weekly counts (`account_weeks`, migration `0036`), private clubs joined by a code (`POST /v1/clubs`, `POST /v1/clubs/join`, `GET /v1/clubs/:id`, `DELETE /v1/clubs/:id/me`, `GET /v1/clubs/consent`), and a public open board (`GET /v1/board`) that lists an account after 90 days of standing or a hand grant (`npm run grant-standing`). Ranked by weeks rowing, then active days; tokens and cost are never held or ranked. See `docs/pool.md`, "Boards".
- Rights: the operator can give a confirmed requester their export and record their raw-consent withdrawal when the requester cannot use the client. `npm run erase -w packages/pool -- export --account <id> --out <folder> [--raw] [--local]` writes the same `account-export-NNNN.json` pages `oars pool export` returns (one shared page builder), and `erase withdraw --account <id> [--confirm] [--local]` runs the same update the route runs (`WITHDRAW_RAW_CONSENT`) and drops the account's staged raw parts. See `docs/pool-rights.md`.
