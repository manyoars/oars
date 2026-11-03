#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { openBrowser } from './browser.js';
import { run } from './cli.js';
import { defaultConfigDir, fileCredentialStore } from './credentials.js';
import { fileJournalStore } from './journal.js';
import { cursorRoot } from './sessions/cursor.js';
import { claudeEvaluator, type ClaudeExec } from './sessions/gold-arms.js';

const CLAUDE_CALL_MS = 180_000;

/** Runs from the temp folder, so no project's instructions reach a reader. A hung call is killed and fails the run, which resumes. */
const runClaude: ClaudeExec = (args, { stdin, env }) =>
  new Promise((resolve, reject) => {
    const child = spawn('claude', args, { cwd: tmpdir(), env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, timeout: CLAUDE_CALL_MS });
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stdin.on('error', () => undefined);
    child.on('error', () => {
      reject(new Error('Cannot run `claude`: install Claude Code and put claude on your PATH.'));
    });
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stdout });
    });
    child.stdin.end(stdin);
  });

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
  install: {
    nodePath: process.execPath,
    hookBin: fileURLToPath(new URL('./hook-bin.js', import.meta.url)),
    userSettings: join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'settings.json'),
    cwd: process.cwd(),
    schtasks: (args) =>
      new Promise((resolve) => {
        let output = '';
        const child = spawn('schtasks', args, { windowsHide: true });
        child.stdout.on('data', (chunk: Buffer) => {
          output += chunk.toString();
        });
        child.stderr.on('data', (chunk: Buffer) => {
          output += chunk.toString();
        });
        child.on('error', (error) => {
          resolve({ code: 1, output: error.message });
        });
        child.on('close', (code) => {
          resolve({ code: code ?? 1, output });
        });
      }),
  },
  sessions: {
    storeDir: join(configDir, 'oars', 'sessions'),
    projectsRoot: join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects'),
    cursorRoot: cursorRoot(process.platform, process.env),
    evaluator: claudeEvaluator(runClaude, process.env),
    stdin: process.stdin,
    stdout: process.stdout,
  },
});
