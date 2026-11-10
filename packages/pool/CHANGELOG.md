# Changelog

`@manyoars/pool` is private (the hosted pool); this file records what changes for its callers.

## Unreleased

- Boards are braked and nicknames are plain (migration `0037`): per account, the 11th wrong club code in a rolling hour and the 6th club created in a rolling day are 429 `rate_limited` with `retry_after`; a nickname is NFKC-normalized, 2 to 24 letters, digits, space, `-`, `_`, or `.`, with no edge space, `@`, or web address, else 422 `nickname_invalid` (was `bad_nickname`). `npm run hide-nickname` lets the operator remove a member's nickname and records who and why (`club_hides`); the attempts and hides are in the account export and removed by `erase account`.
- Boards: per-account weekly counts (`account_weeks`, migration `0036`), private clubs joined by a code (`POST /v1/clubs`, `POST /v1/clubs/join`, `GET /v1/clubs/:id`, `DELETE /v1/clubs/:id/me`, `GET /v1/clubs/consent`), and a public open board (`GET /v1/board`) that lists an account after 90 days of standing or a hand grant (`npm run grant-standing`). Ranked by weeks rowing, then active days; tokens and cost are never held or ranked. See `docs/pool.md`, "Boards".
