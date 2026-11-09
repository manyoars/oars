// Shared by the Codex recording hook's tests: a store under a temp folder that the environment points at, and payloads built from the recorded schema fixture.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { defaultConfigDir } from '../credentials.js';
import type { CodexHookRuntime } from './codex-hook.js';
import { appendOwnerOnly } from './owner-only.js';
import { FIXTURES, removeHeld } from './test-support.js';

const dirs: string[] = [];

export const AT = Date.parse('2026-11-09T12:00:00Z');

export type Obj = { [key: string]: unknown };
const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);
const rec = (value: unknown): Obj => (isObj(value) ? value : {});
const schema: Obj = rec(JSON.parse(readFileSync(join(FIXTURES, 'codex-hook-schema.json'), 'utf8')));

const sample = (kind: unknown): unknown => {
  if (kind === 'string') return 'x';
  if (kind === 'number') return 7;
  if (kind === 'null') return null;
  return Object.fromEntries(Object.entries(rec(kind)).map(([name, inner]) => [name, sample(inner)]));
};

/** A payload with every field the fixture lists for the event, each holding a stand-in of its kind; `over` replaces or adds fields. */
export const payloadOf = (event: 'SessionStart' | 'PostToolUse' | 'PostModelRequest', over: Obj = {}): Obj => ({
  ...rec(sample(schema.common)),
  ...rec(sample(schema[event])),
  hook_event_name: event,
  ...over,
});

export interface HookStore {
  root: string;
  home: string;
  storeDir: string;
  runtime: CodexHookRuntime;
  rows: () => Obj[];
  notes: () => Obj[];
  saveState: (text: string) => void;
}

export const linesOf = (file: string): Obj[] => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((line) => line !== '').map((line) => rec(JSON.parse(line))) : []);

/** A fresh machine under a temp folder: APPDATA and XDG_CONFIG_HOME point there, and the store path is confirmed to be under it before anything runs. */
export const stageHook = (): HookStore => {
  const root = mkdtempSync(join(tmpdir(), 'oars-codex-hook-'));
  dirs.push(root);
  const home = join(root, 'home');
  mkdirSync(home);
  vi.stubEnv('APPDATA', join(root, 'appdata'));
  vi.stubEnv('XDG_CONFIG_HOME', join(root, 'config'));
  const storeDir = join(defaultConfigDir(process.env, process.platform, home), 'oars', 'sessions');
  if (!storeDir.startsWith(root)) throw new Error(`The store path ${storeDir} is outside the temp folder ${root}.`);
  mkdirSync(storeDir, { recursive: true });
  return {
    root,
    home,
    storeDir,
    runtime: { storeDir, home, now: () => AT, append: appendOwnerOnly },
    rows: () => linesOf(join(storeDir, 'hook-rows.jsonl')),
    notes: () => linesOf(join(storeDir, 'hook-calls.jsonl')),
    saveState: (text) => {
      writeFileSync(join(storeDir, 'state.json'), text);
    },
  };
};

export const cleanHook = (): void => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) removeHeld(dir);
};
