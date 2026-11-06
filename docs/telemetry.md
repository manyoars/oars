# Telemetry

`oars` records how it is used, on your machine, and says so. This page is the whole list of what it records, what it never records, when anything is sent, and how to stop it. The code is in `packages/cli/src/telemetry/`; the schema that decides what may be written is `schema.ts` there.

## What happens

- On the first run that is not a hook, `oars` prints a notice on stderr, once, and records that it did. A hook (`oars gate hook`, `hook-bin.js`) never prints it, and a hook's stdout is the same with telemetry as without.
- Each CLI command except the bare `oars gate hook` (which skips the full CLI to stay inside its time budget) then leaves one event in a spool: `<config>/oars/telemetry/events.jsonl` (`<config>` is `%APPDATA%` on Windows, `$XDG_CONFIG_HOME` or `~/.config` elsewhere). The spool is append-only and capped at 1 MiB; at the cap the file becomes `events.1.jsonl`, replacing the one before, so the folder never holds more than 2 MiB. Rotation is best-effort: two oars processes that rotate at the same moment can drop the events of one rotated file. Two first runs at the same moment share one install id.
- Recording never throws and never changes a command's exit code or output. A spool that cannot be written costs nothing but the event.
- Each event carries the install id: a random UUID made on the first run and kept in `<config>/oars/telemetry/install-id`. It comes from the system's random source, not from your machine, your account, or a path. Delete the file and the next run makes an unrelated one.

## What is sent, and when

The events in the spool are what telemetry sends, unchanged: `oars telemetry show` prints them exactly as stored. They will be sent in batches by a later release, only while telemetry is on and the notice has been shown, and only to a pool server you configure (`--server` or `OARS_POOL_URL`). There is no default server: with none configured, the events stay in the spool and nothing leaves your machine. This version records; the sender is a later release (the check it must call first is `telemetrySendAllowed` in `consent.ts`: off, or notice not yet shown, means nothing sends).

## Event types

Every event has the same envelope: `v` (the schema version, `1`), `id` (the install id), `at` (UTC time), `type`, `cli` (the oars version), `os` (`win32`, `darwin`, `linux`, or `other`), `data`, and `dropped` when the schema refused something (see below).

### `command`

One per CLI command, written when it ends.

| Field | What it holds |
|---|---|
| `path` | The command's name path as the program defines it, at most 4 names: `["pool", "fetch"]`. Empty for `--help`, `--version`, or a usage error, since no command ran. |
| `flags` | The names of the options given on the command line, as the program defines them: `["apiUrl", "json"]`. Never a value. |
| `durationMs` | How long the command took, in milliseconds. |
| `exitCode` | The exit code (0 to 255). |
| `errorClass` | Present on a non-zero exit: one of `usage`, `auth`, `invalid`, `conflict`, `rate-limited`, `unreachable`, `capped`, `unexpected`, chosen from the exit code. The error's text is never read. |

An invented example:

```json
{"v":1,"id":"3f2b8c1e-5d4a-4b7e-9c10-2a6f8e1d7b43","at":"2026-11-06T14:03:22.418Z","type":"command","cli":"0.4.0","os":"win32","data":{"path":["pool","fetch"],"flags":["server","harnessVersion"],"durationMs":412,"exitCode":10,"errorClass":"capped"}}
```

Later releases add event types here, one section each.

## What is never recorded or sent

No session content, prompt text, tool output, file path, directory name, URL, argument value, flag value, error message, environment variable, hostname, username, or account. The command path and flag names are the names the program itself declares, never text you typed after them, so `oars sessions recall --error "my private message"` records the flag name `error` and nothing of the message.

## The schema is the control

Every event passes a closed schema before it reaches the spool. A field the schema does not know is dropped; so is a value that does not fit its rule (a name is letters, digits, and hyphens only, which no path, URL, or sentence is; a number is a whole number in a fixed range; `errorClass` is one of the closed words above). Each drop is counted in the event's `dropped`. A test feeds a home path, command text, a prompt-shaped sentence, and a URL to every field of every event type and checks the spool for them.

## Switches

- `oars telemetry status` shows whether it is on, which switch decided that, whether the notice was shown, and the spool's size.
- `oars telemetry off` stops recording and sending. The spool and the id stay until you delete the folder.
- `oars telemetry on` resumes, prints the notice, and records that it was shown.
- `OARS_TELEMETRY=0` (also `false`, `off`, `no`) or `DO_NOT_TRACK=1` (also `true`) turns it off for that process, and wins over `oars telemetry on`. Off also stops recording, not just sending.
- `oars telemetry show` prints the spool. `--json` prints the same events as one document.

To remove everything telemetry keeps, delete `<config>/oars/telemetry/`.
