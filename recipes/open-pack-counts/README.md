# Count failed calls in an open skeleton pack

One script. It reads the files of an open skeleton pack and prints three small tables. It needs Node 24 or newer, the files of the pack, and nothing else. It makes no network call and reads no Many Oars store.

## Get the pack

The pack is a folder. This recipe was checked against the pack with release ID `open-skeleton-2026-11-14-card` (built 2026-11-14T12:02:36.240Z, key `d55a57e14949f104`, redaction version 4). The pack is offered on https://manyoars.com/packs, the page the pack's own README names. <!-- wording: owner read pending -->
The pack's own README states the rights it is offered under: https://manyoars.com/packs#rights. This recipe does not grant or change those rights.

## Run it

```
node recipes/open-pack-counts/open-pack-counts.mjs <pack folder>
```

Add `--json` for the same numbers as JSON. The first line of the output names the pack it read, so a result you publish says which release it came from.

## What each output means

<!-- wording: owner read pending -->
- **Failed calls per error code.** One count for each tool call in a session that has an `errorCode`, grouped by that code. `total` is the sum.
- **Failed calls by what followed.** For each of those calls, whether one of the next 5 calls wrote a file without failing. `edit followed` means yes. `no edit followed` means no. `not recorded` means the call has no record of what followed. The pack's own README prints the first two rows.
- **Sessions per harness version.** For each session row in `manifest.jsonl`, each distinct harness version it lists, counted once.
- **Sessions read, skipped.** A session row, skeleton file, transcript, tool entry, or harness version that cannot be read is counted as skipped and named. It is never dropped without a line. The version table comes from `manifest.jsonl` alone, so a skipped skeleton still shows in it.

The script exits 1 and prints the path when a file the schema requires is missing: `manifest.jsonl`, or the `sessions/<match id>/skeleton.json` of a row in it. `pack.json` is optional, and only supplies the build date and key in the first line.

## Change one question

Add `--by model` to split the same failed calls by the model of the prompt that the call followed. Use `--by class` to split by the prompt's class (`edit-only`, `research`, and so on).

Over the small test pack in `fixture/`:

```
node recipes/open-pack-counts/open-pack-counts.mjs recipes/open-pack-counts/fixture --by model
```

adds this table:

```
Failed calls per model
  model-a  2
  model-b  1
  total    3
```

To ask something else, edit the `by` branch in `countPack` in `open-pack-counts.mjs` (the lines that pick `frame.model` or `cls`). The fields it can read are in `docs/session-record.md`.

## Check the pack

The pack's own README names a validator: `npm run validate-pack -w packages/pool -- <pack folder>`, in this repository. It checks that the files follow the public spec. It does not show that the sample is representative of anything.

## What this cannot tell you

<!-- wording: owner read pending -->
- Whether any later edit fixed the failed call. `edit followed` only says a file was written soon after.
- Why a call failed. The pack holds an error code, not the error text.
- How often failed calls happen in any other set of sessions. This pack shows these 200 sessions.
- What the sessions were for. No prompt text is in the pack.
- Anything about sessions that are not in the pack.
