# Session record and pack manifest

Spec version: `1`

This page is the open format for a lot of coding-agent sessions: a manifest of one row per session, a record (the skeleton) per session, and the transcripts. Any seller can write it and any buyer can check it. It is Apache-2.0 with the rest of this repository. Checking a file needs no key, no network, and no Many Oars account:

```
npm run validate-pack -w packages/pool -- <pack folder | manifest.jsonl | record.json>
```

Exit 0 means the input conforms. Exit 1 prints one line per violation, `<where> <field>: <rule>`, and never the field's content. Exit 2 means nothing was readable at the path. The command is `packages/pool/scripts/validate-pack.ts`; the tables below are held equal to its checks and to the writer's fields by `validate-pack.test.ts`.

## Pack layout

```
manifest.jsonl                    one JSON object per line, one row per session
sessions/<matchId>/main.jsonl     the main transcript, the harness's own lines
sessions/<matchId>/<file>.jsonl   one file per subagent transcript
sessions/<matchId>/skeleton.json  the record, when the row names one
```

A session folder is named by its row's `matchId`, and a folder no row names does not conform. A row's `transcripts` is the number of transcript files in its folder (the record is not one). A transcript keeps each harness's own line format; this spec checks its ids only.

## What a conforming file must contain

- A match id is 64 lowercase hex characters, a keyed hash. Each match id appears in one row.
- Every field named in the tables below, except the ones marked optional. A null is allowed only where the table says so.
- Counts and buckets are whole numbers. A value that names a thing (a program, a model, a skill) is a name after redaction, or the word `private`.
- A value off a closed list reads as the word `other`; the value itself is never kept.

## What a conforming file must not contain

- A raw id: a UUID, or a harness's tool, message, or request id (`toolu_`, `srvtoolu_`, `msg_`, `req_`) left unmasked, in a manifest row, a record, or a transcript line. A transcript line's `sessionId` is the match id.
- A field this page does not list, in a row or a record.
- A `<field>Literal` field beside an `other`.
- A digest of the text of an edit (`digests` on a tool call): a plain hash of text that was not masked.
- A row with an empty `harnessTerms`, or `training` among `permittedUses` (`training` has its own field).

## Manifest

One JSON object per line. Types: `text` is a non-empty string; `count` is a whole number of 0 or more; `time` is an ISO 8601 date and time.

### Manifest object `row`

| Field | Type | Required | Meaning |
|---|---|---|---|
| matchId | match id | yes | The session's id for this buyer: a keyed hash, never the harness's session id. |
| harness | name | yes | Which harness wrote the session, lowercase, such as `claude-code` or `codex`. |
| harnessVersions | list of text | yes | The harness versions seen in the session. |
| repoOwner | text | yes | The owner of the repositories the session worked in. On a row built from a pool deposit it is `depositor:<16 hex>`: a keyed pseudonym of the depositor, one value per buyer key, never an account id. |
| sourceLicense | text or null | yes | The license of the source the session worked on, or null when unknown. |
| harnessTerms | list of objects | yes | The terms the session ran under, at least one; see `harnessTerms`. |
| permittedUses | list of use names | yes | What the seller permits, such as `evaluation`; never `training`. |
| training | `not-offered`, `priced-add-on`, or `included` | yes | Whether training use is offered. |
| transcripts | count | yes | The transcript files in the session folder, at least one. |
| models | object of counts | yes | Model name to the number of turns it ran. |
| turns | count | yes | The user turns in the session. |
| skeleton | file name | no | The record's file name in the session folder. |
| pointer | object or null | no | The repository the session worked in, for an owner who opted in; see `pointer`. |
| outcome | object | no | What happened to the work, for an owner who opted in; see `outcome`. |
| reasoning | `kept` or `stripped` | no | Whether the transcripts hold the model's reasoning blocks (`kept`) or the seller left them out (`stripped`). A row without it comes from a pack built before the field, and holds them. |
| acceptedAt | time | no | Present only on a row built from a pool deposit: when the depositor accepted the covenant cited in `sourceLicense`, as an ISO 8601 time with milliseconds. A row without it is an operator row. A row with it has a `repoOwner` of the form `depositor:<16 hex>`. |
| redactionVersion | text | yes | The version of the redaction the transcripts went through. |
| startedAt | time or null | yes | When the session began. |
| endedAt | time or null | yes | When the session ended. |

### Manifest object `harnessTerms`

| Field | Type | Required | Meaning |
|---|---|---|---|
| name | text | yes | The page the session ran under. |
| version | text | yes | The version that page prints for itself. |

### Manifest object `pointer`

| Field | Type | Required | Meaning |
|---|---|---|---|
| remote | text | yes | The repository's network URL, credentials dropped. |
| commit | text or null | yes | The newest commit from before the session began. |

### Manifest object `outcome`

| Field | Type | Required | Meaning |
|---|---|---|---|
| verify | `passed`, `failed`, `masked`, `none`, `na`, or null | yes | What the session's last verification did. |
| commits | list of objects | yes | The commits the session made; see `commits`. |

### Manifest object `commits`

| Field | Type | Required | Meaning |
|---|---|---|---|
| sha | text | yes | A commit the session made. |
| landed | true, false, or null | yes | Whether the commit reached the default branch, or null when not known. |

## Record

One JSON object, `skeleton.json`. Its meanings are the wire field register (`pool-outbox.ts`, `FIELD_ROWS`); the lines below shorten it. A record is read by the pool's own reader (`parseSkeleton`), so a record that conforms here is one the pool reads. The reader names the first shape error it finds, so a record with several reports one at a time. Types: `text` and `count` are as in the manifest; `bucket` is a whole number of 0 or more standing for a range, never an exact count; `signed bucket` is the same but may be negative, within a limit the reader sets by metric; `name` is a string after redaction, or `private`; `class` is a value from a closed list, or `other`; `hex` is lowercase hex digits of the length the field fixes, and `16 hex` is exactly 16 of them; `bool` is true or false; `UTC day` is `YYYY-MM-DD`.

### Record object `batch`

| Field | Type | Required | Meaning |
|---|---|---|---|
| format | count | yes | The record format number: the reader's `SKELETON_FORMAT`, 7 at spec version 1 (it also reads 3 to 6). |
| vocabVersion | text | yes | The version of the closed lists the record was built under. |
| fieldsVersion | count | yes | The version of the field list the record was built from. |
| id | match id | yes | The session's match id, the same as its row's. |
| transcripts | list of `transcript` | yes | The main transcript, then each subagent. |
| timingPrint | hex or null | no | A hash of the main transcript's call durations, or null under 50 timed calls. |
| deltas | list of `delta` | no | Changes the client found between its own before and after windows. |
| claimed | object or null | no | The host class and launcher; see `claimed`. |
| recommendations | list of `recommendation` | no | Recommendations the session was shown or held back from. |

### Record object `transcript`

| Field | Type | Required | Meaning |
|---|---|---|---|
| merkleRoot | hex | yes | A hash over the hashes of the transcript's lines. |
| leaves | count | yes | How many lines the root covers. |
| harness | class | yes | Which harness wrote the transcript. |
| frame | object | yes | Where the transcript ran; see `frame`. |
| frames | list of `frame` | yes | The distinct frames its steps ran in. |
| prompts | list of `prompt` | yes | The prompts, never their words. |
| tools | list of `tool` | yes | The tool calls, never their targets or arguments. |
| spawnedIn | count or null | no | The position of the transcript that spawned this one; null for the main run. |

### Record object `frame`

| Field | Type | Required | Meaning |
|---|---|---|---|
| harness | class | yes | The harness. |
| platform | class | yes | The operating system family. |
| stack | object | yes | The project's languages, frameworks, and size; see `stack`. |
| harnessVersion | name or null | no | The harness version. |
| model | name or null | no | The model. |
| effort | text or null | no | The effort level, when public. |
| day | UTC day or null | no | The UTC calendar day, `YYYY-MM-DD`; never a time of day. |
| shell | class or null | no | The shell. |
| reach | object | no | The servers, skills, and plugins in reach; see `reach`. |
| repoKey | 16 hex | no | A salted hash of the repository; never a path or a name. |
| orgSize | class | no | The size band of the operator's organization, or `unknown`. |
| team | class | no | One author or several, or `unknown`. |
| repoVisibility | class | no | Public or private, or `unknown`. |
| hour | count | no | The UTC hour, 0 to 23. |

### Record object `stack`

| Field | Type | Required | Meaning |
|---|---|---|---|
| languages | list of class | yes | The project's programming languages. |
| frameworks | list of class | yes | The project's frameworks. |
| size | class or null | no | A size class of the repository. |
| languageShares | list of objects | no | Each language with its share bucket; see `languageShares`. |

### Record object `reach`

| Field | Type | Required | Meaning |
|---|---|---|---|
| filled | bool | yes | Whether the harness recorded what was in reach; false means the lists are empty. |
| mcp | list of name | yes | The MCP servers in reach, sorted. |
| skills | list of name | yes | The skills in reach, sorted. |
| plugins | list of `private` | yes | One `private` for each plugin in reach. |

### Record object `claimed`

| Field | Type | Required | Meaning |
|---|---|---|---|
| hostClass | class | yes | Where the session ran: local, vps, cloud, ci, or hosted. |
| launcher | class | yes | What started it: interactive, orchestrated, scheduled, ci, hosted-run, or unknown. |

### Record object `prompt`

| Field | Type | Required | Meaning |
|---|---|---|---|
| cls | class | yes | The class of the prompt, from the kinds of tools it used. |
| errors | bucket | yes | How many tool calls failed. |
| usage | object | yes | The prompt's tokens; see `usage`. |
| frame | object | yes | Where the prompt ran; see `frame`. |
| wallSec | bucket or null | no | The seconds the prompt took. |
| explore | bucket or null | no | How many steps only looked. |
| usageResponses | bucket | no | The responses that reported usage. |
| intervention | class | no | Whether a human stepped in after the prompt, and how. |

### Record object `usage`

| Field | Type | Required | Meaning |
|---|---|---|---|
| input | bucket or null | yes | Input tokens. |
| cacheWrite | bucket or null | yes | Tokens written to the cache. |
| cacheRead | bucket or null | yes | Tokens read from the cache. |
| output | bucket or null | yes | Output tokens. |
| thinking | bucket or null | yes | Thinking tokens. |

### Record object `tool`

| Field | Type | Required | Meaning |
|---|---|---|---|
| side | bool | yes | Whether the call ran as a side call. |
| status | class | yes | Whether the call succeeded: ok, error, or none. |
| steps | list of `step` | yes | The call's steps, each an action in closed vocabulary. |
| prompt | count or null | no | Which prompt the call follows. |
| durationMs | count or null | no | The call's time in milliseconds. |
| errorCode | class or null | no | Why the call failed, from a closed list; never result text. |
| recoveryCalls | object or null | no | What followed a failed call; see `recoveryCalls`. |
| keys | list of name | no | The call's input key names, sorted; never a value. |
| keysDropped | bucket | no | How many key names were not sent. |
| targetClass | class | no | The class of the path the call touched; never the path. |
| argClass | list of class | no | The kinds of value the arguments held. |
| argFeatures | list of objects | no | Each key's value features; see `argFeatures`. |
| argValues | list of objects | no | Each key's closed value; see `argValues`. |
| changeKind | list of class | no | What changed from the previous call of the same tool. |
| names | list of objects | no | Name tokens of the call's values; see `names`. |
| namesDropped | bucket | no | How many name tokens were not sent. |
| templates | list of text | no | One template per shell command, every argument a slot. |
| templatesDropped | bucket | no | How many templates were not sent. |
| diffShape | list of class | no | What an edit did, such as `lines-added`; never the text. |

### Record object `step`

| Field | Type | Required | Meaning |
|---|---|---|---|
| action | class | yes | The canonical action, never the harness's tool text. |
| native | name | yes | The name the harness gave the tool. |
| identity | object or null | yes | What the step called; see `identity`. |
| status | class | yes | Whether the step succeeded: ok, error, or none. |
| agentType | class or null | yes | The subagent type whose run holds the step; null on the main run. |
| frame | count | yes | The position of the frame the step ran in. |
| tokens | bucket or null | no | A lower bound of the step's tokens. |
| ms | bucket or null | no | A lower bound of the step's milliseconds. |
| allocated | bool | no | Whether the token figure was divided among calls of one response. |
| parent | count or null | no | The position of the call that spawned this step. |
| skill | name | no | The skill whose run the step sat in. |
| edges | list of objects | no | Edges arriving at the step; see `edge`. |
| remainingTokens | bucket or null | no | A lower bound of the tokens the run spent after the step. |

### Record object `identity`

The members depend on the step's action; each is a name after redaction or `private`. A shell step carries `program`, `sub`, and `flags` (and may carry `pulls`); an MCP step carries `server` and `tool`; a web step carries `host`. "Required" below means required for that action.

| Field | Type | Required | Meaning |
|---|---|---|---|
| program | name | yes | A shell program's basename (a shell step). |
| sub | name or null | yes | The program's subcommand (a shell step). |
| flags | list of name | yes | The program's flag names, never their values (a shell step). |
| pulls | list of objects | no | Packages a shell command pulled; see `pulls`. |
| server | name | yes | The MCP server (an MCP step). |
| tool | name | yes | The MCP tool (an MCP step). |
| host | name or null | yes | The host of a web fetch or search (a web step). |

### Record object `edge`

| Field | Type | Required | Meaning |
|---|---|---|---|
| kind | class | yes | How the edge came about: next, spawned, retried, or after-error. |
| target | count | yes | The position of the step the edge names. |

### Record object `languageShares`

| Field | Type | Required | Meaning |
|---|---|---|---|
| language | class | yes | A language of the project, or `other`. |
| languageShare | class | yes | How much of the touched files are in it: none, under 10 percent, 10 up to 50, or 50 and over. |

### Record object `argValues`

| Field | Type | Required | Meaning |
|---|---|---|---|
| key | text | yes | The sent key the value belongs to. |
| enumValue | class | yes | True, false, or a member of the tool's closed list for the key. |

### Record object `names`

| Field | Type | Required | Meaning |
|---|---|---|---|
| kind | class | yes | What the name is: file, dir, env, flag, or agent. |
| name | name | yes | The name as written, after redaction. |

### Record object `pulls`

| Field | Type | Required | Meaning |
|---|---|---|---|
| registry | class | yes | Which registry the package came from. |
| name | name | yes | The public package name. |
| version | text or null | yes | The package version, when it is a registry version. |

### Record object `recoveryCalls`

| Field | Type | Required | Meaning |
|---|---|---|---|
| next | list of class | yes | The actions of up to the next 5 calls after a failed call. |
| editFollowed | bool | yes | Whether one of those calls wrote a file. |

### Record object `argFeatures`

| Field | Type | Required | Meaning |
|---|---|---|---|
| key | text | yes | The sent key the features belong to. |
| valueSize | class | yes | A bucket of the value's length. |
| pathDepth | class | no | How many folders a path sits below the root (a path argument only). |
| extension | class | no | The class of a path's extension (a path argument only). |
| dirKind | class | no | The kind of folder a path names (a path argument only). |
| patternFeatures | list of class | no | What a pattern uses (a pattern argument only). |

### Record object `delta`

| Field | Type | Required | Meaning |
|---|---|---|---|
| deltaKind | class | yes | Added, removed, or changed. |
| field | class | yes | What changed: plugin, package, permissionMode, or effort. |
| name | name or null | yes | The name, or null when only the field is named. |
| registry | class or null | yes | The registry a package came from. |
| metric | class | yes | What the delta measures. |
| change | signed bucket | yes | A signed bucket of how far the metric moved. |

### Record object `recommendation`

| Field | Type | Required | Meaning |
|---|---|---|---|
| id | text | yes | The recommendation's id. |
| arm | class | yes | Whether it reached the asker or was held back: shown or held. |
| poolVersion | text | yes | The pool snapshot it answered from. |
| from | count | yes | The first call of its window. |
| to | count | yes | One past the last call of its window. |

### Record object `digests`

A conforming record has none. The two fields are listed because the writer can emit them; the validator rejects a tool call that carries `digests`.

| Field | Type | Required | Meaning |
|---|---|---|---|
| new | hex | yes | A digest of the text an edit wrote. |
| old | hex | no | A digest of the text an edit replaced. |

## What this page leaves out

How a match id is issued and checked, erasure, dedup across sellers, and license state are kept by the registry, not by the format. A file that conforms here is well formed; it is not verified.
