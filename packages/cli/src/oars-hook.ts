#!/usr/bin/env node
// The `oars-hook` executable: the host-independent command a machine's Stop and SessionEnd hooks run (`oars-hook stop --machine`, written by `oars sessions hook install --machine`). It is the same program as
// `hook-bin.js`, behind a name on PATH, so a settings file committed from one machine names no install path and still runs on a VM whose setup script installed the package globally.
await import('./hook-bin.js');
