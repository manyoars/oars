# Changelog

All notable changes to `@manyoars/oars-client`. Versions follow semver.

## 0.1.2 (2026-11-10)

- Node floor lowered from 24 to 22.23.4, the `oars` CLI's floor, so installing the CLI on Node 22 prints no engine warning.
- Removes an exported helper and its types; `createOarsClient` and the generated types are the public surface.
- Types only: the public spec gains the API key operations `UserManagement_create` (`POST /me/api-keys`), `UserManagement_list` (`GET /me/api-keys`), `revokeApiKey` (`DELETE /me/api-keys/{keyId}`), and `rotate` (`POST /me/api-keys/{keyId}/rotate`). It also gains `patchWorkloadConfig` (`PATCH /agents/workloads/{workloadId}/config`). `CreateDeveloperApiKeyRequest` takes an optional `workloadId` that scopes the key to that one workload, and `DeveloperApiKeyResponse` returns it (absent on an ordinary key).
- A key scoped to a workload gets 404 `WORKLOAD_NOT_FOUND` on any other workload under `/agents/workloads`. On its own workload it gets 403 `WORKLOAD_NOT_OWNED` on deploy and on any config change other than `scheduleCron` (secrets included), and register is refused the same way. It can patch its own `scheduleCron`. The patch must send the service's other fields unchanged, except `imageRepository`, which it must omit, and cannot add or clear a schedule (403 `WORKLOAD_NOT_OWNED`), and a schedule that fires more often than the minimum interval gets 400 `MANIFEST_INVALID`.
- `POST /me/api-keys` answers 400 `API_KEY_WORKLOAD_SCOPE_EXCEEDS_CAP` when a key with a `workloadId` asks for more than `AGENT_OPERATE` and `AGENT_READ`.
- Types only: the public spec and the generated types now hold nine operations: workload register, read, config, and deploy; token exchange; and API key create, list, rotate, and revoke. Every other operation of 0.1.1 is gone with the schemas only it used, as are some response fields; the `oars` CLI uses none of them. `info.description` names what remains.
