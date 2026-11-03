# Changelog

All notable changes to `@manyoars/oars-client`. Versions follow semver.

## Unreleased

- Types only: the public spec gains the API key operations `UserManagement_create` (`POST /me/api-keys`), `UserManagement_list` (`GET /me/api-keys`), and `revoke_1` (`DELETE /me/api-keys/{keyId}`). `CreateDeveloperApiKeyRequest` takes an optional `workloadId` that scopes the key to that one workload, and `DeveloperApiKeyResponse` returns it (absent on an ordinary key).
- A key scoped to a workload is refused as not found on any other workload, and on register, deploy, start, delete, SDK-key rotate, and secrets; it can patch its own `scheduleCron` and stop its own workload.

## 0.1.2

- Types only: `CreateChargeInput` is now `CheckoutChargeInput` (`successUrl` required; `cancelUrl` optional, defaulting to the agent's public page when it is visible) or `OffSessionChargeInput`, told apart by `mode`.
- `BillingErrorCode` gains `SELLER_IDENTITY_CONFLICT`, `SELLER_UNAVAILABLE`, `PURCHASE_SELF_DEALING`, `PURCHASE_CAP_REACHED`, `PURCHASE_DECLINED`, and `PURCHASE_AUTHENTICATION_REQUIRED`; the error body gains `mode` and `remainingUsd`.
- Docs only: the `mode` description on the billing error body lists its error codes and the missing cap, card, or room with serial commas.
