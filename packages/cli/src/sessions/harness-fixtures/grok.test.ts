import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { captureSession, type Capture } from '../extract.js';
import { makeRedactor } from '../redact.js';
import { makeRepoIdentity, makeRepoRoot } from '../repo-root.js';
import { SOURCES } from '../sources.js';
import { cleanup, stage, stageGrok } from '../test-support.js';
import { verifyCaptured, verifySkeleton } from '../verify.js';

afterEach(cleanup);

// Grok Build: a made-up session (no real prompt, path, name, or key) in the shape the reader expects; see harness-fixtures/README.md.
// A harness release that changes this format turns this one test red.
const FIXTURE = fileURLToPath(new URL('./grok.updates.jsonl', import.meta.url));
const objectOf = (file: string): object => {
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null) throw new Error('fixture is not an object');
  return parsed;
};
const sibling = (part: string): string => FIXTURE.replace('updates.jsonl', `${part}.json`);

const capture = (text: string): Capture =>
  captureSession({
    text,
    harness: 'grok',
    session: 'grok-fixture',
    project: 'p',
    rev: 1,
    at: '2026-06-01T00:00:00Z',
    bytes: text.length,
    redact: makeRedactor(),
    salt: 'salt',
    sid: 'abcd1234',
    repoRoot: makeRepoRoot(),
    repoIdentity: makeRepoIdentity(),
  });

describe('the Grok Build reader on its fixture', () => {
  it('parses the fixture into a session record that passes the capture invariants', async () => {
    const s = stage();
    const source = SOURCES.find((entry) => entry.name === 'grok');
    if (source === undefined) throw new Error('no such source');
    const root = stageGrok(s.root, [{ id: 'sess', cwd: '/work/app', updates: readFileSync(FIXTURE, 'utf8'), usage: objectOf(sibling('usage')), summary: objectOf(sibling('summary')) }]);
    const store = await source.open(root);
    expect(store?.sessions).toHaveLength(1);
    expect(store?.unreadable).toEqual([]);
    const [session] = store?.sessions ?? [];
    const text = session === undefined ? '' : await store?.transcript(session);
    store?.close();
    const out = capture(text ?? '');
    expect([...verifySkeleton(out.skeleton), ...verifyCaptured([out.session], out.tools)].filter((entry) => entry.violations > 0)).toEqual([]);
    expect({
      userTurns: out.session.userTurns,
      assistantTurns: out.session.assistantTurns,
      models: out.session.models,
      version: out.session.env.harness,
      tools: out.tools.map((tool) => [tool.tool, tool.status]),
      errorLines: out.errorLines.map((entry) => entry.line),
    }).toEqual({
      userTurns: 1,
      assistantTurns: 3,
      models: { 'grok-build': 3 },
      version: null,
      tools: [['Bash', 'error'], ['Edit', 'ok']],
      errorLines: ['make: *** No rule to make target'],
    });
  });
});
