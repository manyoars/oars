import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { captureSession, type Capture } from '../extract.js';
import { makeRedactor } from '../redact.js';
import { makeRepoIdentity, makeRepoRoot } from '../repo-root.js';
import { cleanup } from '../test-support.js';
import { verifyCaptured, verifySkeleton } from '../verify.js';

afterEach(cleanup);

// Claude Code: a made-up session (no real prompt, path, name, or key) in the shape Claude Code writes; see harness-fixtures/README.md.
// A harness release that changes this format turns this one test red.
const FIXTURE = fileURLToPath(new URL('./claude-code.jsonl', import.meta.url));

const capture = (text: string): Capture =>
  captureSession({
    text,
    session: 'claude-code-fixture',
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

describe('the Claude Code reader on its fixture', () => {
  it('parses the fixture into a session record that passes the capture invariants', () => {
    const out = capture(readFileSync(FIXTURE, 'utf8'));
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
      models: { 'claude-sonnet-5-5': 3 },
      version: '2.1.322',
      tools: [['Bash', 'error'], ['Edit', 'ok']],
      errorLines: ['make: *** No rule to make target'],
    });
  });
});
