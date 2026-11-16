# Changelog

All notable changes to `@manyoars/pack-seller`.

## Unreleased

- A new seller server: pack pages, an offer route that records the recipient and license version and returns the `customerRef` once, a per-caller rate limit on offers, a balance route, and reserve, commit, and release calls over the platform's billing for the download route.
- Pricing and delivery: a pack maps to a `CREDIT_PACK` price with the amount from configuration, the catalog and the offer record live on the operator's disk, and `POST /packs/{packId}/download` builds the pack under the buyer's key, streams it, spends one credit, and appends a delivery record.
