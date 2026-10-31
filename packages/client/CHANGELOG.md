# Changelog

All notable changes to `@manyoars/oars-client`. Versions follow semver.

## 0.1.2

- Types only: `CreateChargeInput` is now `CheckoutChargeInput` (`successUrl` required; `cancelUrl` optional, defaulting to the agent's public page when it is visible) or `OffSessionChargeInput`, told apart by `mode`.
- `BillingErrorCode` gains `SELLER_IDENTITY_CONFLICT`, `SELLER_UNAVAILABLE`, `PURCHASE_SELF_DEALING`, `PURCHASE_CAP_REACHED`, `PURCHASE_DECLINED`, and `PURCHASE_AUTHENTICATION_REQUIRED`; the error body gains `mode` and `remainingUsd`.
- Docs only: the `mode` description on the billing error body lists its error codes and the missing cap, card, or room with serial commas.
