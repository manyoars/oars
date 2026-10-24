#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { openBrowser } from './browser.js';
import { run } from './cli.js';
import { defaultConfigDir, fileCredentialStore } from './credentials.js';
import { fileJournalStore } from './journal.js';

/** The version in this package's package.json (one folder up from dist/). */
const readVersion = (): string => {
  const manifest: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const version: unknown = typeof manifest === 'object' && manifest !== null ? Reflect.get(manifest, 'version') : undefined;
  return typeof version === 'string' ? version : '0.0.0';
};

const configDir = defaultConfigDir(process.env, process.platform, homedir());

// exitCode rather than process.exit(), so a piped stdout is flushed before the process ends.
process.exitCode = await run(process.argv.slice(2), {
  env: process.env,
  io: {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  },
  store: fileCredentialStore(configDir),
  journal: fileJournalStore(configDir),
  version: readVersion(),
  sleep: (ms) => sleep(ms),
  random: Math.random,
  now: Date.now,
  openBrowser,
});
