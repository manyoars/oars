# Changelog

All notable changes to `@manyoars/oars`. Versions follow semver; a release is the tag `cli-v<version>`.

## 0.2.0

- `oars templates` lists the starter templates, and `oars deploy --template <id>` deploys one without an image of your own.
- `oars login` works with no flags once Many Oars has launched: the production issuer is built in, and
  `https://manyoars.com/.well-known/oars.json` (`{"launched": true}`) switches it on. The flag never supplies the URL.
  Before launch, `login` says "Many Oars has not launched yet: pass --issuer-url or set OARS_ISSUER_URL." and exits 2.
  `--issuer-url` and `OARS_ISSUER_URL` still win.
- An exit 6 ends with a "Needs you:" line that names the link for the step only a person can do, such as Stripe onboarding.
- `deploy` refuses a mix of flags with a message that uses the serial comma; a `--template` the catalog lacks exits 2 and an
  unreachable catalog exits 8, before anything is registered.

## 0.1.1

- README lists the commands and flags.

## 0.1.0

- First release: `login`, `logout`, `deploy`, `status`, and `test-charge`.
