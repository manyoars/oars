# Changelog

All notable changes to `@manyoars/oars-client`. Versions follow semver.

## 0.1.2

- Types only: `CreateChargeInput` is now `CheckoutChargeInput` (`successUrl` and `cancelUrl` required) or `OffSessionChargeInput`, told apart by `mode`.
- `BillingErrorCode` gains `SELLER_IDENTITY_CONFLICT`, `SELLER_UNAVAILABLE`, `PURCHASE_SELF_DEALING`, `PURCHASE_CAP_REACHED`, `PURCHASE_DECLINED`, and `PURCHASE_AUTHENTICATION_REQUIRED`; the error body gains `mode` and `remainingUsd`.
