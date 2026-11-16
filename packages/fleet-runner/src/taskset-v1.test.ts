// Proof that the committed task set `taskset/v1/` is whole: the manifest names 26 tasks in the spec's shape (section 2), and every task has its prompt, its check, and any setup file.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isObject, objectAt, parseJson, stringAt } from './json.js';
import { parseTaskSet } from './manifest.js';

const TASKSET_V1 = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'taskset', 'v1');

const text = readFileSync(join(TASKSET_V1, 'manifest.json'), 'utf8');
const manifest = parseTaskSet(text);
const raw = objectAt(parseJson(text, 'manifest'), 'manifest');

/** The raw `setup` value of each task that has one, which `parseTaskSet` does not carry. */
const setups = (): string[] => {
  const tasks = raw['tasks'];
  if (!Array.isArray(tasks)) throw new Error('manifest tasks is not a list');
  return tasks.flatMap((task: unknown) => (isObject(task) && task['setup'] !== undefined ? [stringAt(task, 'setup', 'task')] : []));
};

describe('taskset/v1 manifest', () => {
  it('is version v1 and holds 26 tasks', () => {
    expect(manifest.version).toBe('v1');
    expect(manifest.tasks).toHaveLength(26);
  });

  it('has four categories of six and two controls', () => {
    const counts = new Map<string, number>();
    for (const task of manifest.tasks) counts.set(task.category, (counts.get(task.category) ?? 0) + 1);
    expect(Object.fromEntries([...counts].sort())).toEqual({ browser: 6, control: 2, database: 6, 'docs-fetch': 6, 'repo-workflow': 6 });
  });

  it('has a prompt and a check file for every id', () => {
    for (const task of manifest.tasks) {
      expect(existsSync(join(TASKSET_V1, 'prompts', `${task.id}.md`)), `prompts/${task.id}.md`).toBe(true);
      expect(existsSync(join(TASKSET_V1, 'checks', `${task.id}.mjs`)), `checks/${task.id}.mjs`).toBe(true);
    }
  });

  it('has every setup path it names, and names two', () => {
    const paths = setups();
    expect(paths).toHaveLength(2);
    for (const path of paths) expect(existsSync(join(TASKSET_V1, path)), path).toBe(true);
  });

  it('names a fixture tag and a commit of 7 to 40 hex characters', () => {
    expect(manifest.fixtureTag).toBe('taskset-v1');
    expect(manifest.fixtureCommit).toMatch(/^[0-9a-f]{7,40}$/);
  });
});
