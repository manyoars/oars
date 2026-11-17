import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { captureSession, type Capture } from '../extract.js';
import { makeRedactor } from '../redact.js';
import { makeRepoIdentity, makeRepoRoot } from '../repo-root.js';
import { SOURCES } from '../sources.js';
import { cleanup, stage, stageCodex } from '../test-support.js';
import { verifyCaptured, verifySkeleton } from '../verify.js';

afterEach(cleanup);

// Codex: a made-up session (no real prompt, path, name, or key) in the shape the reader expects, record for record the Paginated rollout a Codex 0.169 CLI writes
// (the record types, and the fields each carries, follow a real 0.169 file; every value is invented); see harness-fixtures/README.md.
// A harness release that changes this format turns this one test red.
const FIXTURE = fileURLToPath(new URL('./codex.jsonl', import.meta.url));

const capture = (text: string): Capture =>
  captureSession({
    text,
    harness: 'codex',
    session: 'codex-fixture',
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

describe('the Codex reader on its fixture', () => {
  it('parses the fixture into a session record that passes the capture invariants', async () => {
    const s = stage();
    const source = SOURCES.find((entry) => entry.name === 'codex');
    if (source === undefined) throw new Error('no such source');
    const root = stageCodex(s.root, [{ id: '11111111-1111-4111-8111-111111111111', lines: readFileSync(FIXTURE, 'utf8') }]);
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
      usage: out.session.usage,
      usageResponses: out.session.usageResponses,
      offered: out.session.funnel?.offered,
    }).toEqual({
      userTurns: 1,
      assistantTurns: 5,
      models: { 'gpt-5-codex': 5 },
      version: '0.169.0',
      // t1202: a Codex 0.166+ code-mode cell. The `exec` cell settles on its own header (`Script completed`, so ok); the command it ran is a separate Bash call from the
      // CommandExecution item and keeps its exit code, so the shell outcome is not lost (t890 has nothing to fix for this shape).
      // t1362: this fixture is the Paginated rollout the 0.169 CLI writes (`history_mode` `paginated`): the prompt and both replies are `item_completed`
      // UserMessage and AgentMessage items (no `user_message` or `agent_message` event), the code-mode `exec` cell and its two CommandExecution items are the only
      // calls, the usage is the sum of the two `token_count` events (the `token_usage_record` lines beside them are not read, so the sum would double if they were), and `offered` is the `additional_tools` record's tool. The shell call that exits 2 and the
      // patch edit of the pre-0.169 shape stay pinned in codex-legacy.test.ts.
      tools: [['Bash', 'ok'], ['Bash', 'error'], ['Bash', 'ok']],
      errorLines: ['make: *** No rule to make target all'],
      usage: { input: 1800, cacheWrite: 0, cacheRead: 1200, output: 400, thinking: 100 },
      usageResponses: 2,
      offered: ['extra_tool'],
    });
  });
});
