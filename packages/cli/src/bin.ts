#!/usr/bin/env node
import { exitIfTooOld } from './node-floor.js';

// An older Node gets one line and exit 1, before anything loads that would fail on it.
exitIfTooOld(process.versions.node, (text) => process.stderr.write(text), (code) => process.exit(code));

// The `oars` executable. It decides which program to load before loading any: `oars gate hook` is run by the harness before every matching tool call and has under a
// second to finish, so it must not pay for the whole CLI (its command tree, its sign-in, its HTTP client) just to start. Everything else loads `main.js`, as before.
// Only the bare command: with an argument (`--help`) the full CLI answers, so its description shows.
const hook = process.argv.length === 4 && process.argv[2] === 'gate' && process.argv[3] === 'hook';

// `oars statusline` and `oars statusline --color` likewise: a terminal status line runs it after every assistant message, so it does not load the CLI either.
const statusline = process.argv[2] === 'statusline' && (process.argv.length === 3 || (process.argv.length === 4 && process.argv[3] === '--color'));

await (hook ? import('./gate/hook-main.js') : statusline ? import('./statusline-main.js') : import('./main.js'));
