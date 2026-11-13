// Fixture stores for the real-work table and its release note: a sessions store built in a temp folder from invented transcripts, an invented exclusion term, and an owners file. No test reads a real store.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deposit, type SessionsRuntime } from '../../cli/src/sessions/store.js';

export const TERM = 'zorblax';
const dirs: string[] = [];

/** Removes every folder `fixture` made; call it from an `afterEach`. */
export const removeFixtures = (): void => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
};

const line = (value: object): string => JSON.stringify(value);
export const id = (n: number): string => `${String(n).repeat(8)}-1111-4111-8111-111111111111`;

export interface Call {
  tool: string;
  input: object;
  ok: boolean;
}
export interface Prompt {
  text: string;
  calls: Call[];
}
export interface Spec {
  id: string;
  project: string;
  version: string;
  model: string;
  prompts: Prompt[];
}

export const bash = (ok: boolean): Call => ({ tool: 'Bash', input: { command: 'npm test' }, ok });
export const edit = (): Call => ({ tool: 'Edit', input: { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' }, ok: true });
export const failedEdit = (): Call => ({ ...edit(), ok: false });
export const read = (): Call => ({ tool: 'Read', input: { file_path: 'src/a.ts' }, ok: true });

// A transcript the way the harness writes it: a user line per prompt, then an assistant line and a result line per call.
const transcript = (spec: Spec, cwd: string): string[] => {
  const lines: string[] = [];
  let n = 0;
  let second = 0;
  const at = (): string => `2026-06-01T10:${String(Math.floor(second / 60)).padStart(2, '0')}:${String(second++ % 60).padStart(2, '0')}.000Z`;
  for (const prompt of spec.prompts) {
    n += 1;
    lines.push(line({ type: 'user', uuid: `${spec.id.slice(0, 8)}-b${String(n).padStart(3, '0')}-4222-8222-222222222222`, parentUuid: null, isSidechain: false, timestamp: at(), version: spec.version, sessionId: spec.id, cwd, message: { role: 'user', content: prompt.text } }));
    for (const call of prompt.calls) {
      n += 1;
      const tool = `toolu_${spec.id.slice(0, 4)}${String(n)}`;
      lines.push(line({ type: 'assistant', uuid: `${spec.id.slice(0, 8)}-a${String(n).padStart(3, '0')}-4222-8222-222222222222`, parentUuid: null, isSidechain: false, timestamp: at(), version: spec.version, sessionId: spec.id, requestId: `req_${spec.id.slice(0, 4)}${String(n)}`, message: { role: 'assistant', model: spec.model, content: [{ type: 'tool_use', id: tool, name: call.tool, input: call.input }], usage: { input_tokens: 100, output_tokens: 50 } } }));
      lines.push(line({ type: 'user', uuid: `${spec.id.slice(0, 8)}-b${String(n).padStart(3, '0')}-4333-8333-333333333333`, parentUuid: null, isSidechain: false, timestamp: at(), version: spec.version, sessionId: spec.id, cwd, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tool, ...(call.ok ? {} : { is_error: true }), content: call.ok ? 'done' : 'Error: Exit code 1' }] } }));
    }
  }
  return lines;
};

export interface Fixture {
  root: string;
  runtime: SessionsRuntime;
  terms: string;
  owners: string;
  out: string;
  add: (spec: Spec) => void;
  stored: () => Promise<void>;
}

export const fixture = (): Fixture => {
  const root = mkdtempSync(join(tmpdir(), 'oars-real-work-'));
  dirs.push(root);
  const projectsRoot = join(root, 'projects');
  mkdirSync(projectsRoot);
  const cwd = join(root, 'work', 'app');
  mkdirSync(join(cwd, '.git'), { recursive: true });
  writeFileSync(join(cwd, '.git', 'config'), `[remote "origin"]\n\turl = https://example.com/acme/app.git\n`);
  const terms = join(root, 'terms.txt');
  writeFileSync(terms, `${TERM}\n`);
  const owners = join(root, 'owners.json');
  writeFileSync(owners, JSON.stringify([{ folder: '*-oars*', owner: 'Many Oars Co.', license: 'Apache-2.0' }]));
  const runtime: SessionsRuntime = { storeDir: join(root, 'store'), projectsRoot, sources: [], stdin: process.stdin, stdout: { write: () => true } };
  const add = (spec: Spec): void => {
    const file = join(projectsRoot, spec.project, `${spec.id}.jsonl`);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, `${transcript(spec, cwd).join('\n')}\n`);
  };
  const stored = async (): Promise<void> => {
    await deposit(runtime, { allow: [], redactDomains: [], now: () => Date.parse('2026-06-10T00:00:00Z') });
  };
  return { root, runtime, terms, owners, out: join(root, 'table'), add, stored };
};

/** A session id for the stores that need more than nine of them. */
export const idOf = (n: number): string => `${String(n).padStart(8, '0')}-2222-4222-8222-222222222222`;
