import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import type { SessionsRuntime } from './store.js';

export const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

const dirs: string[] = [];

export const cleanup = (): void => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
};

export interface Staged {
  root: string;
  projectsRoot: string;
  storeDir: string;
  runtime: SessionsRuntime;
  stdin: PassThrough;
  written: string[];
}

/** A fresh projects root holding `proj` (the fixtures) and an empty store beside it. */
export const stage = (project = 'proj'): Staged => {
  const root = mkdtempSync(join(tmpdir(), 'oars-sessions-test-'));
  dirs.push(root);
  const projectsRoot = join(root, 'projects');
  mkdirSync(projectsRoot);
  cpSync(join(FIXTURES, 'proj'), join(projectsRoot, project), { recursive: true });
  const stdin = new PassThrough();
  const written: string[] = [];
  const storeDir = join(root, 'store');
  return { root, projectsRoot, storeDir, stdin, written, runtime: { storeDir, projectsRoot, stdin, stdout: { write: (text: string) => written.push(text) } } };
};

/** Adds a project folder with one session file of the given lines. */
export const addProject = (staged: Staged, project: string, name: string, lines: readonly string[]): string => {
  const folder = join(staged.projectsRoot, project);
  mkdirSync(folder, { recursive: true });
  const file = join(folder, `${name}.jsonl`);
  writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
};

export const NOW = Date.parse('2026-06-10T00:00:00Z');
