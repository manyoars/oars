# Changelog

All notable changes to `@manyoars/oars-client`. Versions follow semver.

## Unreleased

- Types only: the public spec gains the API key operations `UserManagement_create` (`POST /me/api-keys`), `UserManagement_list` (`GET /me/api-keys`), `revokeApiKey` (`DELETE /me/api-keys/{keyId}`, formerly `revoke_1`), and `rotate` (`POST /me/api-keys/{keyId}/rotate`). It also gains `patchWorkloadConfig` (`PATCH /agents/workloads/{workloadId}/config`). `CreateDeveloperApiKeyRequest` takes an optional `workloadId` that scopes the key to that one workload, and `DeveloperApiKeyResponse` returns it (absent on an ordinary key).
- A key scoped to a workload gets 404 `WORKLOAD_NOT_FOUND` on any other workload under `/agents/workloads`. Every `/billing/agents/{workloadId}` route refuses it with a 403 on any workload, its own included, because its authorities stop at `AGENT_OPERATE` and `AGENT_READ`. On its own workload it gets 403 `WORKLOAD_NOT_OWNED` on deploy, start, delete, SDK-key rotate, and any config change other than `scheduleCron` (secrets included), and register is refused the same way. It can patch its own `scheduleCron` and stop its own workload. The patch must send the service's other fields unchanged, except `imageRepository`, which it must omit, and cannot add or clear a schedule (403 `WORKLOAD_NOT_OWNED`), and a schedule that fires more often than the minimum interval gets 400 `MANIFEST_INVALID`.
- `POST /me/api-keys` answers 400 `API_KEY_WORKLOAD_SCOPE_EXCEEDS_CAP` when a key with a `workloadId` asks for more than `AGENT_OPERATE` and `AGENT_READ`.

## 0.1.2

- Types only: `CreateChargeInput` is now `CheckoutChargeInput` (`successUrl` required; `cancelUrl` optional, defaulting to the agent's public page when it is visible) or `OffSessionChargeInput`, told apart by `mode`.
- `BillingErrorCode` gains `SELLER_IDENTITY_CONFLICT`, `SELLER_UNAVAILABLE`, `PURCHASE_SELF_DEALING`, `PURCHASE_CAP_REACHED`, `PURCHASE_DECLINED`, and `PURCHASE_AUTHENTICATION_REQUIRED`; the error body gains `mode` and `remainingUsd`.
- Docs only: the `mode` description on the billing error body lists its error codes and the missing cap, card, or room with serial commas.
