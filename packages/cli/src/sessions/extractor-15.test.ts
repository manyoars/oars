// The staged-store round trip for EXTRACTOR 15 and CAPTURE 23 (t915, section 17 rule 7 of the direction conclusion): the fixtures that carry the three misreads (a checkout of a slashed or quoted branch, a checkout with an unlisted
// path flag, and a Codex or Gemini decline or interrupt), staged into a temp store with the repo's fixtures, a store stamped as main left it (EXTRACTOR 14) refreshed, and every session put on the wire and parsed back.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalBytes } from './pool-outbox.js';
import { printOf, sessionsFrom, storedNames } from './pool-fixture.js';
import { parseSkeleton, skeletonOf, type SessionSkeleton } from './pool-wire.js';
import { CAPTURE_VERSION, EXTRACTOR_VERSION, PROMPT_INTERVENTIONS, type PromptIntervention } from './schema.js';
import { deposit, loadStore, paths, refresh } from './store.js';
import { addProject, cleanup, geminiHead, rolloutLine, stage, stageCodex, stageGemini } from './test-support.js';

afterEach(cleanup);

const NOW = Date.parse('2026-06-10T00:00:00Z');
const T = (second: number): string => `2026-06-01T10:00:${String(second).padStart(2, '0')}.000Z`;
const user = (second: number, content: unknown) => ({ type: 'user', timestamp: T(second), message: { role: 'user', content } });
const assistant = (second: number, id: string, name: string, input: object) => ({ type: 'assistant', timestamp: T(second), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const result = (second: number, id: string, content: string) => ({ type: 'user', timestamp: T(second), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: false, content }] } });

/** A Claude Code session whose first prompt edits a file and whose second runs `command`, so the first prompt is the one `intervention` reads. */
const checkout = (command: string): string[] =>
  [user(1, 'add a field'), assistant(2, 't1', 'Edit', { file_path: '/work/app/src/a.ts', old_string: 'a', new_string: 'b' }), result(3, 't1', 'ok'), user(4, 'now this'), assistant(5, 't2', 'Bash', { command }), result(6, 't2', 'ok')].map((entry) =>
    JSON.stringify(entry),
  );

/** [session name, command, the bucket at main's versions (EXTRACTOR 14, CAPTURE 21), the bucket now]. */
const CHECKOUTS: readonly (readonly [string, string, PromptIntervention, PromptIntervention])[] = [
  ['branch-slashed', 'git checkout feature/x', 'revert', 'none'],
  ['branch-quoted', 'git checkout "fix-1"', 'revert', 'none'],
  ['path-marker', 'git checkout -- src/a.ts', 'revert', 'revert'],
  ['path-flag', 'git checkout --ours src/a.ts', 'none', 'revert'],
];

const CODEX = 'cccc1111-1111-4111-8111-111111111111';
const GEMINI = 'dddd2222-2222-4222-8222-222222222222';
const codexLines: unknown[] = [
  rolloutLine(T(0), 'session_meta', { session_id: CODEX, id: CODEX, timestamp: T(0), cwd: '/work/app', originator: 'codex_cli_rs', cli_version: '0.50.0' }),
  rolloutLine(T(1), 'turn_context', { model: 'gpt-5-codex', cwd: '/work/app' }),
  rolloutLine(T(2), 'event_msg', { type: 'user_message', message: 'remove it' }),
  rolloutLine(T(3), 'response_item', { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['rm', 'x'] }), call_id: 'c1' }),
  rolloutLine(T(4), 'response_item', { type: 'function_call_output', call_id: 'c1', output: 'exec command rejected by user' }),
  rolloutLine(T(5), 'event_msg', { type: 'user_message', message: 'try again' }),
  rolloutLine(T(6), 'event_msg', { type: 'turn_aborted', reason: 'interrupted' }),
  rolloutLine(T(7), 'event_msg', { type: 'user_message', message: 'go on' }),
];
const geminiLines: unknown[] = [
  geminiHead(GEMINI),
  { id: 'u1', timestamp: T(1), type: 'user', content: [{ text: 'remove it' }] },
  {
    id: 'g1',
    timestamp: T(2),
    type: 'gemini',
    content: '',
    model: 'gemini-2.5-pro',
    toolCalls: [{ id: 'b', name: 'run_shell_command', args: { command: 'rm x' }, status: 'cancelled', timestamp: T(3), result: [{ functionResponse: { id: 'b', name: 'run_shell_command', response: { error: '[Operation Cancelled] User cancelled tool execution.' } } }] }],
  },
  { id: 'u2', timestamp: T(5), type: 'user', content: [{ text: 'go on' }] },
];

const staged = () => {
  const s = stage();
  for (const [name, command] of CHECKOUTS) addProject(s, 'proj', name, checkout(command));
  const codex = stageCodex(s.root, [{ id: CODEX, lines: codexLines }]);
  const gemini = stageGemini(s.root, [{ id: GEMINI, slug: 'app', projectRoot: join(s.root, 'not-a-repo'), lines: geminiLines }]);
  return { ...s, runtime: { ...s.runtime, sourceRoots: { codex, gemini } } };
};

const skeletonsOf = (loaded: Awaited<ReturnType<typeof loadStore>>): SessionSkeleton[] =>
  sessionsFrom(loaded).map((records, index) => {
    const built = skeletonOf(records, index.toString(16).padStart(16, '0'), storedNames, printOf);
    if (built === null) throw new Error(`no skeleton for session ${String(index)}`);
    return built;
  });

type Loaded = Awaited<ReturnType<typeof loadStore>>;
const countOf = (loaded: Loaded): { [bucket in PromptIntervention]: number } => {
  const counts = { none: 0, 'after-error': 0, redo: 0, revert: 0, 'user-stop': 0, unknown: 0 };
  for (const prompt of loaded.prompts) if (prompt.intervention !== undefined) counts[prompt.intervention] += 1;
  return counts;
};
/** The few fields of a capture record the rewrite below reads or drops. */
interface LogRecord {
  kind: string;
  cv?: string;
  session?: string;
  index?: number;
  head?: string;
  steps?: { identity: { target?: string } | null }[];
}
const isLogRecord = (value: unknown): value is LogRecord => typeof value === 'object' && value !== null && 'kind' in value && typeof value.kind === 'string';
/**
 * The store totals (20 prompts) over the staged store with the capture log as main left it (CAPTURE 21), read by EXTRACTOR 15: measured by running this test.
 * The two declines read `user-stop` here; main's own EXTRACTOR 14 reading of them was not run, because the old extractor is not in this tree.
 */
const MAIN_ERA: { [bucket in PromptIntervention]: number } = { none: 5, 'after-error': 0, redo: 0, revert: 3, 'user-stop': 2, unknown: 10 };

const options = { allow: ['proj', 'codex', 'gemini'], redactDomains: [], now: () => NOW };

describe('EXTRACTOR_VERSION 15 and CAPTURE_VERSION 23', () => {
  it('are the versions that read a checkout by its target class and a Codex or Gemini decline as a stop', () => {
    expect(Number(EXTRACTOR_VERSION)).toBeGreaterThanOrEqual(15);
    expect(Number(CAPTURE_VERSION)).toBeGreaterThanOrEqual(23);
  });

  it('refreshes a store as main left it (CAPTURE 21, EXTRACTOR 14), puts every session on the wire with none refused and extensions empty, and holds a listed intervention on every prompt', async () => {
    const s = staged();
    await deposit(s.runtime, options);
    const derived = paths(s.storeDir).derived;
    // The store as main left it: the stamp is '14' (derived prompts are not stored, so it is all that moves there), and the capture log is rewritten as CAPTURE 21 wrote it:
    // every record is `cv` '21', a `git checkout` step has no `target` key, and a Codex `turn_aborted` has no marker prompt record.
    writeFileSync(derived, readFileSync(derived, 'utf8').replaceAll(`"v":"${EXTRACTOR_VERSION}"`, '"v":"14"'));
    const log = paths(s.storeDir).observations;
    const dropped = { markers: 0, targets: 0, rewritten: 0 };
    const kept: string[] = [];
    const later = new Map<string, number>();
    for (const line of readFileSync(log, 'utf8').split('\n').filter((entry) => entry !== '')) {
      const record: unknown = JSON.parse(line);
      if (!isLogRecord(record)) throw new Error('a capture record has no kind');
      if (record.kind === 'user-prompt' && record.session === `codex-${CODEX}` && typeof record.head === 'string' && record.head.startsWith('[Request interrupted by user')) {
        dropped.markers += 1;
        later.set(record.session, 1);
        continue;
      }
      if (record.kind === 'user-prompt' && typeof record.session === 'string' && later.has(record.session) && typeof record.index === 'number') record.index -= 1;
      for (const step of record.steps ?? []) {
        if (step.identity !== null && step.identity.target !== undefined) {
          delete step.identity.target;
          dropped.targets += 1;
        }
      }
      if (record.cv === CAPTURE_VERSION) {
        record.cv = '21';
        dropped.rewritten += 1;
      }
      kept.push(JSON.stringify(record));
    }
    writeFileSync(log, `${kept.join('\n')}\n`);
    // The rewrite did something on each count, so the store below is not the CAPTURE 23 store restamped.
    expect(dropped.markers).toBe(1);
    expect(dropped.targets).toBe(4);
    expect(dropped.rewritten).toBeGreaterThan(0);
    const before = await loadStore(s.storeDir);
    expect(before.tools.every((tool) => Number(tool.cv) <= 21)).toBe(true);
    expect(countOf(before)).toEqual(MAIN_ERA);

    await refresh(s.runtime, [], '2026-06-10T00:00:00.000Z');
    expect(readFileSync(derived, 'utf8')).not.toContain('"v":"14"');
    const loaded = await loadStore(s.storeDir);
    const skeletons = skeletonsOf(loaded);
    expect(skeletons.length).toBeGreaterThan(0);
    const sent = skeletons.flatMap((skeleton) => skeleton.transcripts.flatMap((transcript) => transcript.prompts));
    expect(sent.length).toBe(loaded.prompts.length);
    for (const skeleton of skeletons) {
      const parsed = parseSkeleton(JSON.parse(canonicalBytes(skeleton)));
      if (!parsed.ok) throw new Error(`refused ${parsed.field}: ${parsed.reason}`);
      expect(parsed.extensions).toEqual([]);
      expect(parsed.skeleton).toEqual(skeleton);
    }
    for (const entry of sent) expect(PROMPT_INTERVENTIONS).toContain(entry.intervention);
  });

  it('reads each checkout fixture, and the Codex and Gemini stops, as the doc says', async () => {
    const s = staged();
    await deposit(s.runtime, options);
    const loaded = await loadStore(s.storeDir);
    const buckets = (match: (session: string) => boolean): (PromptIntervention | undefined)[] => loaded.prompts.filter((prompt) => match(prompt.session)).map((prompt) => prompt.intervention);
    const stored = loaded.sessions.map((session) => session.session);
    for (const [name, , , now] of CHECKOUTS) {
      const mine = stored.filter((session) => loaded.prompts.some((prompt) => prompt.session === session && prompt.head === 'now this') && session.includes(name));
      expect(mine).toHaveLength(1);
      expect(buckets((session) => session === mine[0])[0]).toBe(now);
    }
    // 'remove it' (declined), 'try again' (interrupted: the marker follows), the marker's own record, and the last prompt.
    expect(buckets((session) => session === `codex-${CODEX}`)).toEqual(['user-stop', 'user-stop', 'unknown', 'unknown']);
    expect(buckets((session) => session === `gemini-${GEMINI}`)).toEqual(['user-stop', 'unknown']);
  });

  it('counts the buckets over the staged store, for the report', async () => {
    const s = staged();
    await deposit(s.runtime, options);
    // Store totals over `fixtures/proj` plus the six added sessions (21 prompts, the Codex marker record included). The same sessions with main's capture log are `MAIN_ERA` above (20 prompts).
    expect(countOf(await loadStore(s.storeDir))).toEqual({ none: 5, 'after-error': 0, redo: 0, revert: 2, 'user-stop': 3, unknown: 11 });
  });
});
