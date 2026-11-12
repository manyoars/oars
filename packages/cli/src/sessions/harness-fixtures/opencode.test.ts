import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { captureSession, type Capture } from '../extract.js';
import { makeRedactor } from '../redact.js';
import { makeRepoIdentity, makeRepoRoot } from '../repo-root.js';
import { SOURCES } from '../sources.js';
import { cleanup, stage, folders, stageOpencode, type OpencodeFixture } from '../test-support.js';
import { verifyCaptured, verifySkeleton } from '../verify.js';

const isRows = (value: unknown): value is OpencodeFixture[] => Array.isArray(value);

afterEach(cleanup);

// OpenCode: a made-up session (no real prompt, path, name, or key) in the shape the reader expects; see harness-fixtures/README.md.
// A harness release that changes this format turns this one test red.
const FIXTURE = fileURLToPath(new URL('./opencode.json', import.meta.url));

const capture = (text: string): Capture =>
  captureSession({
    text,
    harness: 'opencode',
    session: 'opencode-fixture',
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

describe('the OpenCode reader on its fixture', () => {
  it('parses the fixture into a session record that passes the capture invariants', async () => {
    const s = stage();
    const source = SOURCES.find((entry) => entry.name === 'opencode');
    if (source === undefined) throw new Error('no such source');
    const parsed: unknown = JSON.parse(readFileSync(FIXTURE, 'utf8').replaceAll('FOLDER', JSON.stringify(folders(s.root).repo).slice(1, -1)));
    if (!isRows(parsed)) throw new Error('fixture is not a list of sessions');
    const rows = parsed;
    const root = await stageOpencode(s.root, rows);
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
      assistantTurns: 1,
      models: { 'claude-sonnet-5-5': 1 },
      version: '2.2.5',
      tools: [['Bash', 'error'], ['Edit', 'ok']],
      errorLines: ['make: *** No rule to make target'],
    });
  });
});
