// The two manifests an order names: the fleet manifest (harnesses, their versions, and model IDs; `fleet-1`) and the task-set manifest (`taskset/v1/manifest.json`:
// task ids with category, the fixture tag and commit). Spec sections 1 and 4.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { arrayAt, objectAt, parseJson, ParseError, stringAt } from './json.js';

export interface HarnessEntry {
  name: string;
  version: string;
  provider: string;
  region: string;
  modelIds: string[];
}

export interface FleetManifest {
  version: string;
  harnesses: HarnessEntry[];
}

export interface TaskEntry {
  id: string;
  category: string;
}

export interface TaskSetManifest {
  version: string;
  fixtureTag: string;
  fixtureCommit: string;
  tasks: TaskEntry[];
}

const strings = (values: readonly unknown[], where: string): string[] =>
  values.map((value) => {
    if (typeof value !== 'string' || value === '') throw new ParseError(`${where} must hold non-empty strings`);
    return value;
  });

export const parseFleet = (text: string): FleetManifest => {
  const root = objectAt(parseJson(text, 'fleet manifest'), 'fleet manifest');
  return {
    version: stringAt(root, 'version', 'fleet'),
    harnesses: arrayAt(root, 'harnesses', 'fleet').map((entry, index) => {
      const at = `fleet.harnesses[${String(index)}]`;
      const item = objectAt(entry, at);
      return {
        name: stringAt(item, 'name', at),
        version: stringAt(item, 'version', at),
        provider: stringAt(item, 'provider', at),
        region: stringAt(item, 'region', at),
        modelIds: strings(arrayAt(item, 'modelIds', at), `${at}.modelIds`),
      };
    }),
  };
};

export const parseTaskSet = (text: string): TaskSetManifest => {
  const root = objectAt(parseJson(text, 'task-set manifest'), 'task-set manifest');
  const tasks = arrayAt(root, 'tasks', 'taskset').map((entry, index) => {
    const at = `taskset.tasks[${String(index)}]`;
    const item = objectAt(entry, at);
    return { id: stringAt(item, 'id', at), category: stringAt(item, 'category', at) };
  });
  if (tasks.length === 0) throw new ParseError('taskset.tasks must not be empty');
  if (new Set(tasks.map((task) => task.id)).size !== tasks.length) throw new ParseError('taskset.tasks ids must be distinct');
  return { version: stringAt(root, 'version', 'taskset'), fixtureTag: stringAt(root, 'fixtureTag', 'taskset'), fixtureCommit: stringAt(root, 'fixtureCommit', 'taskset'), tasks };
};

/** Reads `<folder>/manifest.json`; the 26 real tasks are a later brief, so a test folder holds a small manifest. */
export const loadTaskSet = async (folder: string): Promise<TaskSetManifest> => parseTaskSet(await readFile(join(folder, 'manifest.json'), 'utf8'));
