import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { openBrowser } from './browser.js';
import { run } from './cli.js';
import { defaultConfigDir, fileCredentialStore } from './credentials.js';
import { codexRoot } from './sessions/codex.js';
import { cursorRoot } from './sessions/cursor.js';
import { claudeEvaluator, runClaude } from './sessions/gold-arms.js';
import { catchUpOnStore } from './sessions/pool-due.js';
import { SOURCES } from './sessions/sources.js';
import { spawnDetachedSend } from './telemetry/send.js';

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
  telemetry: { dir: join(configDir, 'oars', 'telemetry'), platform: process.platform, spawnSend: spawnDetachedSend },
  version: readVersion(),
  catchUp: () => catchUpOnStore(join(configDir, 'oars', 'sessions'), fileURLToPath(new URL('./hook-bin.js', import.meta.url))),
  sleep: (ms) => sleep(ms),
  random: Math.random,
  now: Date.now,
  openBrowser,
  install: {
    platform: process.platform,
    nodePath: process.execPath,
    hookBin: fileURLToPath(new URL('./hook-bin.js', import.meta.url)),
    userSettings: join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'settings.json'),
    cwd: process.cwd(),
    codex: { home: codexRoot(process.env), nodePath: process.execPath, hookBin: fileURLToPath(new URL('./sessions/codex-hook-bin.js', import.meta.url)) },
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
    sourceRoots: Object.fromEntries(SOURCES.map((source) => [source.name, source.root(process.platform, process.env, homedir())])),
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  },
});
