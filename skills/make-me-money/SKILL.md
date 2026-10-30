---
name: make-me-money
description: Ship a paid agent on Many Oars and get paid for it. Use when the user says "make me money", "ship a paid agent", "get paid for an agent", or asks to sell an agent, API, or per-task job with the oars CLI (@manyoars/oars).
---

# Make me money on Many Oars

Many Oars puts a paid agent on its platform from a starter template. The `oars` CLI does the work; the human does only
what a person must (signing in, and Stripe's identity and bank steps). Run every command as `npx @manyoars/oars <command>`
(Node 24 or newer). Add `--json` to read the result as one JSON document on stdout; read the exit code either way.

## Rules

- Never sign, accept terms, or fill an identity, tax, or bank form for the human. Hand each one over and wait.
- Never print or commit the SDK key. `deploy` shows it once; tell the human to save it, and keep it out of logs and git.
- Never pass `--issuer-url` or set `OARS_ISSUER_URL` unless the human gave you the URL. Do not guess one.
- Test mode is the default, so deploying and `test-charge` move no money. Real payouts need the human's Stripe step.

## Steps

1. **Log in.** Run `npx @manyoars/oars login --no-browser`. It prints a link and a code on stderr
   (`To sign in, open <url>` and `confirm the code <code>`). Show both to the human, tell them to open the link and
   confirm, and wait for the command to finish. Success prints `Logged in as <email>`. The first sign-in has the human
   create an account, accept Many Oars' terms, and verify their email; those are theirs to do.
2. **Pick a template.** Run `npx @manyoars/oars templates`. Each entry prints as `<id>: <name>`, a description, and its
   starter prices. Choose by what the human wants to sell: `paid-api` charges per call, `per-task-agent` charges per
   finished task. If the choice is not obvious from the request, ask the human which one.
3. **Deploy.** Run `npx @manyoars/oars deploy --template <id>`. Success prints `Deployed <name> (workload <id>)`, the
   one-time `SDK key (shown once; save it now): ...`, the `Prices:` it created, and a `Next:` list. Note the workload id. With `--json` the key is the `sdkKey` field.
   To register and price it without starting it, add `--no-start`. Pass a secret the agent needs with
   `--secret-from-env <NAME>`, never `--secret`, so the value stays out of shell history.
4. **Check it runs.** Run `npx @manyoars/oars status <workloadId>`. Success prints four lines: the name and id,
   `Workload: <status>`, `Deployment: <status> (<health>), desired <state>`, and `Billing mode: TEST`. If the deployment is not healthy
   yet, wait a little and run it again.
5. **Prove the money path.** Run `npx @manyoars/oars test-charge <workloadId>` (add `--price <ref>` when the workload has
   more than one active price). Success prints `Test charge <chargeId> for <ref>: <status>`. It is a Stripe test charge on
   Many Oars' own sandbox, so the human needs no Stripe account yet.
6. **Hand over the Stripe step.** Real money needs the human to finish Stripe onboarding (name, date of birth, address,
   bank account, and Stripe's terms) in the Many Oars web app, under Account, then Payout account. Tell them it is theirs
   to do, that Stripe sets the time it takes, and that you cannot do it for them. Wait for them to say it is done.
7. **Check that it gets paid.** After they finish, run `npx @manyoars/oars status <workloadId>` again and report the
   billing mode. Going live and the payout itself are the human's, in the web app; Stripe pays out on its own schedule,
   typically seven to fourteen days after the first live payment. Do not promise a date.

## Exit codes to handle

Read the exit code of every command. With `--json` a failure is `{"ok": false, "step": ..., "problem": {...}}`.

| Exit | Meaning | What you do |
|------|---------|-------------|
| 0 | success | go to the next step |
| 2 | usage error | read the message and fix the command; see "Not launched yet" below for the one that matters most |
| 3 | login expired or denied | run `login` again (step 1) |
| 4 | the platform rejected the input | read `problem.detail`, fix the input, rerun |
| 5 | conflict (key or workload already used) | same `--idempotency-key` if resuming; if the workload already exists, run `status` on it instead of deploying again |
| 6 | a person must act first | stop, see "Needs you" below |
| 7 | rate limited | wait a minute, rerun the same command |
| 8 | the platform could not be reached | retry once; if it persists, tell the human |
| 9 | `deploy` stopped part way | rerun the `Rerun to resume:` command it printed (with `--json`, the `rerun` field), exactly as printed |
| 1 | unexpected error | show the human the message and stop |

### Not launched yet

If `login` prints `Many Oars has not launched yet: pass --issuer-url or set OARS_ISSUER_URL.` (exit 2), stop. Do not
work around it. Tell the human that Many Oars has not opened to the public yet, that this path will work once it has, and
that manyoars.com will say when it does. Only continue if they hand you an issuer URL.

### Needs you (exit 6)

The last line of stderr starts with `Needs you:` and names the one thing, usually a link: finishing Stripe onboarding,
adding a payment method, buying credits, or raising the compute cap. Give the human that line word for word, say you are
waiting, and make no further calls until they confirm. Then rerun the same command (with the same `--idempotency-key`
if you set one); a `deploy` resumes where it stopped.

With `--json` there is no `Needs you:` line: give the human `problem.actionUrl` (else `problem.title` and `problem.detail`).
