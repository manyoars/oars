set windows-shell := ["powershell.exe", "-NoLogo", "-Command"]

default:
    @just --list

# Lint, typecheck and unit tests (including the generated-types staleness test). CI and the orchestration gate run this.
check:
    npm run check

# Rebuild openapi/public.json from aor-platform's committed api-specs/openapi.json, then the client types from it.
openapi-refresh source:
    node scripts/openapi-public.mjs "{{source}}"
    npm run generate -w packages/client
