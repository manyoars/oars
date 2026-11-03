# Contributing

Build and test commands are in the [README](README.md#develop). This file covers one rule that is easy to break by accident.

## Keep private names out of a public repository

This repository is public. A name read from a real session, such as a program, a customer, or an internal service, must never
appear in it: not in code, a test, a fixture, a doc, or a commit message. Tests and fixtures use **invented names only**.

### The pre-push check

`scripts/check-private-names.mjs` runs from a `pre-push` hook (`.githooks/pre-push`). It scans only what the push would newly
publish (`git rev-list <sha> --not --remotes=origin`): added lines and commit messages. A hit blocks the push and prints the
commit, file, and line, never the term or the text.

Turn it on once, from the main checkout, with `just hooks`. That sets `core.hooksPath` to an absolute path, because every
worktree shares one config.

It reads two local files, one term per line, matched without regard to case. They never live in this repository:

- `OARS_EXCLUSION_TERMS`, default `~/.claude/session-commons/exclusion-terms.txt` (under `$CLAUDE_CONFIG_DIR` instead of
  `~/.claude` when that is set): the session store's exclusion list.
- `OARS_PUBLIC_DENYLIST`, default `~/.claude/session-commons/public-denylist.txt` (same `CLAUDE_CONFIG_DIR` rule).

A missing file prints a warning and the check passes, so a contributor who has neither list is not blocked. A list that
exists but is not UTF-8 (a UTF-16 file from PowerShell 5.1 `>`, for example) blocks the push, because it would otherwise match
nothing in silence; an empty list only warns.

### What it catches, and what it misses

- It catches **listed terms only**, in **added lines** and **commit messages**. A new private name is invisible to it until
  someone adds that name to a list.
- It does not look at removed lines, file contents outside the diff, file names, branch names, annotated tag messages, binary
  files, or commit author and committer names and emails (both are published with each commit).
- It cannot see anything **already on origin**. Cleaning up what was published is a separate, manual job.
- A stale `origin/*` tracking ref counts as already on origin. After a history rewrite, commits reachable only from an unpruned
  ref are not scanned; run `git fetch --prune origin` first.
- `git push --no-verify` skips it.

So the check is a backstop. The rule is the protection: invented names only in tests and fixtures, never a name read from a
real session.
