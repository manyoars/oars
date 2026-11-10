---
name: oars-recall
description: Look up a tool error, a file, or a kind of task in this user's own past coding agent sessions with the oars_recall tool, before solving it from scratch. Use when an error repeats, a file has a history, or the user asks what happened last time.
---

# Recall from the user's past sessions

`oars_recall` reads the local record that `oars` keeps of this user's earlier agent sessions. It runs on this machine and answers with counts, not transcripts. Each call is logged locally as a recall.

Call it when:

- a tool call fails and you have not seen the error in this session: pass the error text, as printed
- you are about to edit a file that may have a history: pass the path or file name
- the user asks what happened last time, or how a similar problem went

## Calls

Name one form per call.

- `error`: the error text, as printed. Paste the line below a `<tool_use_error>` header, not the header.
- `path`: a file path or file name an earlier session touched.
- `class`: a prompt class (`edit-verify`, `edit-only`, `shell-only`, `research`, `orchestration`, `explore-only`, `mixed`, `no-tools`).
- `sinceDays`: keep only the last N days. It narrows an `error`, `path`, or `class` call.
- `prefix`: read IDs for your steps so far, to ask what happened from here.
- `entity`: a public name, such as a package, a tool, an MCP server, an action, or a model.
- `family`: a read family to answer.
- `text`: text to look for in the local record.

## Reading the answer

The answer gives counts: how many sessions and days, which harness versions, how far the evidence sits from this user, and the actions that followed. A small count is a hint. Say how many sessions it rests on when you use it, and check it against the code in front of you.

An answer with no matches means the record has nothing on it. Go on without it.

If the tool is not available in this session, do not work around it.
