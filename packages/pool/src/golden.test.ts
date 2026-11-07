// Golden fixtures, one per adapted harness (conclusion section 17, rule 7): the batch the client builds for a small session of that harness, kept as the canonical bytes a deposit carries. Each is
// built from the harness's own action table (the tool names its adapter reads), round tripped parse to serialize to parse, and posted to the route. A change to the vocabulary or the field list moves
// them on purpose: run `UPDATE_GOLDEN=1 just build oars exec -w packages/pool vitest run src/golden` and read the diff (the refresh the direction conclusion's A47 asks for).
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACTION_TABLES } from '../../cli/src/sessions/actions.js';
import { canonicalBytes } from '../../cli/src/sessions/pool-outbox.js';
import { frame, printOf, prompt, session, sessionsFrom, step, storedNames, store, tool } from '../../cli/src/sessions/pool-fixture.js';
import { parseSkeleton, skeletonOf, type SessionSkeleton } from '../../cli/src/sessions/pool-wire.js';
import type { Harness } from '../../cli/src/sessions/schema.js';
import { startPool, type TestPool } from './test-pool.js';

const HARNESSES: readonly Harness[] = ['claude-code', 'cursor', 'codex', 'copilot', 'gemini', 'grok', 'vscode-copilot'];
const DIR = fileURLToPath(new URL('./golden/', import.meta.url));
const TOKEN = 'a-golden-token';

/** The first tool name a harness's adapter table maps to an action: the name its own sessions carry. */
const nativeOf = (harness: Harness, action: 'shell.exec' | 'file.read'): string => {
  const found = Object.entries(ACTION_TABLES[harness].rows).find(([, held]) => held === action);
  if (found === undefined) throw new Error(`${harness} has no ${action}`);
  return found[0];
};

/** One session of a harness: a prompt, a shell call (`git push`), and a file read. Real adapters differ in what they name the tools; the skeleton is the same shape. */
const skeletonFor = (harness: Harness, id: string): SessionSkeleton => {
  const framed = frame({ harness, shell: 'bash' });
  const shell = nativeOf(harness, 'shell.exec');
  const read = nativeOf(harness, 'file.read');
  const [only] = sessionsFrom(
    store({
      sessions: [session('s1', { frame: framed, harness })],
      prompts: [prompt('s1', 0, { frame: framed })],
      tools: [
        tool('s1', 0, shell, { steps: [step(0, 0, 'shell.exec', { native: shell, identity: { program: 'git', sub: 'push', flags: ['-f'] } })] }),
        tool('s1', 1, read, { steps: [step(1, 0, 'file.read', { native: read })] }),
      ],
    }),
  );
  const built = only === undefined ? null : skeletonOf(only, id, storedNames, printOf);
  if (built === null) throw new Error('no skeleton');
  return built;
};

const goldenPath = (harness: Harness): string => `${DIR}${harness}.json`;

let pool: TestPool;
beforeAll(async () => {
  pool = await startPool();
  const db = await pool.db();
  await db.prepare("INSERT INTO accounts (id, covenant) VALUES ('acct-1', 'v1')").run();
  await db.prepare("INSERT INTO tokens (hash, account, expires_at) VALUES (?, 'acct-1', ?)").bind(createHash('sha256').update(TOKEN).digest('hex'), Date.now() + 600_000).run();
  if (process.env.UPDATE_GOLDEN !== undefined) {
    mkdirSync(DIR, { recursive: true });
    for (const [at, harness] of HARNESSES.entries()) writeFileSync(goldenPath(harness), canonicalBytes(skeletonFor(harness, `00000000000000${String(at).padStart(2, '0')}`)));
  }
}, 60_000);

afterAll(async () => {
  await pool.dispose();
});

describe.each(HARNESSES)('the %s golden', (harness) => {
  const bytes = (): string => readFileSync(goldenPath(harness), 'utf8');

  it('is the batch the client builds for the session now', () => {
    const at = HARNESSES.indexOf(harness);
    expect(bytes()).toBe(canonicalBytes(skeletonFor(harness, `00000000000000${String(at).padStart(2, '0')}`)));
  });

  it('round trips parse to serialize to parse, with nothing set aside', () => {
    const first = parseSkeleton(JSON.parse(bytes()));
    if (!first.ok) throw new Error(`${first.field}: ${first.reason}`);
    expect(first.extensions).toEqual([]);
    expect(first.others).toBe(0);
    const again = canonicalBytes(first.skeleton);
    expect(again).toBe(bytes());
    const second = parseSkeleton(JSON.parse(again));
    expect(second).toEqual(first);
  });

  it('is accepted by the deposit route', async () => {
    const answer = await pool.post('/v1/deposits', bytes(), TOKEN);
    expect(answer.status).toBe(201);
  });

  it('names its own harness at the transcript and the frame', () => {
    const parsed = parseSkeleton(JSON.parse(bytes()));
    if (!parsed.ok) throw new Error(`${parsed.field}: ${parsed.reason}`);
    expect(parsed.skeleton.transcripts.map((held) => [held.harness, held.frame.harness])).toEqual([[harness, harness]]);
  });
});

describe('the goldens together', () => {
  it('cover the seven adapted harnesses, one batch each, with ids that differ', () => {
    expect(new Set(HARNESSES).size).toBe(7);
    const ids = HARNESSES.map((harness) => {
      const parsed = parseSkeleton(JSON.parse(readFileSync(goldenPath(harness), 'utf8')));
      if (!parsed.ok) throw new Error(`${parsed.field}: ${parsed.reason}`);
      return parsed.skeleton.id;
    });
    expect(new Set(ids).size).toBe(7);
  });
});
