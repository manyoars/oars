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

# The Keycloak the live login runs against: the image aor-platform pins (KeycloakVersionContractTest), so a bump there means a bump here.
keycloak_image := "quay.io/keycloak/keycloak:26.8.0"

# Opt-in live login (design §6): the real CLI's device flow against a running Keycloak holding T67's realm, with Playwright approving the
# code on the verification page. Needs OARS_LIVE_USERNAME and OARS_LIVE_PASSWORD (a user of that realm); OARS_LIVE_ISSUER_URL defaults to
# the local stack's http://localhost:8180/realms/aor. Playwright's browser: `npx playwright install chromium` once.
live-login:
    npm run test:live -w packages/cli

# A throwaway Keycloak on http://localhost:8180 importing the realm file (aor-platform/k8s/keycloak-realm.json), for live-login when the
# local stack is down. It takes about 45 s to answer; stop it with `docker stop oars-live-keycloak`.
live-keycloak realm:
    docker run -d --rm --name oars-live-keycloak -p 127.0.0.1:8180:8080 -e KC_HOSTNAME=http://localhost:8180 -v "{{absolute_path(realm)}}:/opt/keycloak/data/import/realm.json:ro" {{keycloak_image}} start-dev --import-realm
