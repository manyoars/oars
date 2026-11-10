#!/usr/bin/env node
import { exitIfTooOld } from './node-floor.js';

// The same one line and exit 1 as `oars` gives on a Node under the floor, before the hook program loads.
exitIfTooOld(process.versions.node, (text) => process.stderr.write(text), (code) => process.exit(code));

// The `oars-hook` executable: the host-independent command a machine's Stop and SessionEnd hooks run (`oars-hook stop --machine`, written by `oars sessions hook install --machine`). It is the same program as
// `hook-bin.js`, behind a name on PATH, so a settings file committed from one machine names no install path and still runs on a VM whose setup script installed the package globally.
await import('./hook-bin.js');
