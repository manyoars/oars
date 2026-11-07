// What the wire says about whose work it is and who it covers (t871): a store-salted repo key, three coverage bands, and the UTC hour. Every value here is invented.
import { describe, expect, it } from 'vitest';
import { incrementsOf, storeOf } from './cell-increments.js';
import { captureSession } from './extract.js';
import { rolloutLines } from './codex.js';
import { makeRedactor } from './redact.js';
import { rolloutLine } from './test-support.js';
import { hourOf, NO_COVERAGE, ORG_SIZES, parseSkeleton, REPO_VISIBILITIES, skeletonOf, TEAMS, type Coverage, type SessionSkeleton, type SkeletonFrame } from './pool-wire.js';
import { frame, printOf, prompt, session, sessionsFrom, step, store, storedNames, tool } from './pool-fixture.js';

const KEY_A = '0123456789abcdef';
const KEY_B = 'fedcba9876543210';
const read = step(0, 0, 'file.read', { native: 'Read' });

const stored = (repo: string | null, extra: Partial<ReturnType<typeof session>> = {}): ReturnType<typeof store> =>
  store({
    sessions: [session('s1', { frame: frame({ day: '2026-11-01', shell: 'bash' }), repo, tsFirst: '2026-11-01T13:05:00.000Z', ...extra })],
    prompts: [prompt('s1', 0, { frame: frame({ day: '2026-11-01', shell: 'bash' }), ts: '2026-11-01T22:59:59.000Z' })],
    tools: [tool('s1', 0, 'Read', { steps: [read], prompt: 0 })],
  });

const skeletonFrom = (from: ReturnType<typeof store>, coverage?: Coverage): SessionSkeleton => {
  const [only] = sessionsFrom(from);
  const skeleton = only === undefined ? null : skeletonOf(only, '0123456789abcdef', storedNames, printOf, [], coverage);
  if (skeleton === null) throw new Error('no skeleton');
  return skeleton;
};

describe('the repo key', () => {
  it('is the session record salted hash of the repository, on the transcript frame and every frame its steps ran in', () => {
    const skeleton = skeletonFrom(stored(KEY_A));
    const transcript = skeleton.transcripts[0];
    expect(transcript?.frame.repoKey).toBe(KEY_A);
    expect(transcript?.frames.map((entry) => entry.repoKey)).toEqual(transcript?.frames.map(() => KEY_A));
    // Like the reach, it is not repeated on a prompt's frame.
    expect(transcript?.prompts[0]?.frame.repoKey).toBeUndefined();
  });

  it('is absent when the session sat in no repository', () => {
    const transcript = skeletonFrom(stored(null)).transcripts[0];
    expect(transcript?.frame).not.toHaveProperty('repoKey');
    expect(transcript?.frames[0]).not.toHaveProperty('repoKey');
  });

  it('is left out when the record holds anything but a key, so a name in that field never leaves', () => {
    const transcript = skeletonFrom(stored('github.com/org/secret-app')).transcripts[0];
    expect(transcript?.frame).not.toHaveProperty('repoKey');
    expect(JSON.stringify(transcript)).not.toContain('secret-app');
  });

  it('holds no path and no remote text anywhere in a whole batch', () => {
    const text = JSON.stringify(skeletonFrom(stored(KEY_A, { project: '-w-secret-app', files: ['/w/secret-app/src/a.ts'] })));
    for (const forbidden of ['secret-app', '/w/', 'github.com', 'origin']) expect(text).not.toContain(forbidden);
  });

  it('is refused unless it is 16 lowercase hex characters, so a path or a remote cannot ride in it', () => {
    for (const bad of ['/w/secret-app', 'github.com/org/app', KEY_A.toUpperCase(), `${KEY_A}0`, 7, null]) {
      const skeleton = skeletonFrom(stored(KEY_A));
      const first = skeleton.transcripts[0];
      if (first === undefined) throw new Error('no transcript');
      Reflect.set(first.frame, 'repoKey', bad);
      expect(parseSkeleton(skeleton)).toEqual({ ok: false, field: 'transcripts[0].frame.repoKey', reason: typeof bad === 'string' ? 'outside the vocabulary' : 'not text' });
    }
  });

  it('survives the parser', () => {
    const parsed = parseSkeleton(structuredClone(skeletonFrom(stored(KEY_A))));
    expect(parsed.ok).toBe(true);
  });
});

describe('the repo key as capture makes it', () => {
  const lines = (cwd: string): string =>
    [
      JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-06-01T00:00:01.000Z', version: '2.1.300', cwd, message: { role: 'user', content: 'read it' } }),
      JSON.stringify({ type: 'assistant', uuid: 'u2', timestamp: '2026-06-01T00:00:02.000Z', version: '2.1.301', cwd, message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } } }),
    ].join('\n');
  const keyOf = (cwd: string, salt: string, identity: string): string | null => {
    const text = lines(cwd);
    return captureSession({
      text, session: 's', project: 'p', rev: 1, at: 'x', bytes: text.length, redact: (value: string) => value, salt, sid: null,
      repoRoot: () => cwd, repoIdentity: () => identity, runtime: { oars: '1.2.3', node: 'v99', os: 'plan9' },
    }).session.repo;
  };

  it('is one key for one repository under one store salt, from two clones, and two keys under two salts', () => {
    const here = keyOf('/w/app', 'account-one', 'github.com/org/app');
    const clone = keyOf('/elsewhere/app-copy', 'account-one', 'github.com/org/app');
    const other = keyOf('/w/app', 'account-two', 'github.com/org/app');
    expect(here).toMatch(/^[0-9a-f]{16}$/);
    expect(clone).toBe(here);
    expect(other).toMatch(/^[0-9a-f]{16}$/);
    expect(other).not.toBe(here);
  });

  it('is one key for one repository under one store salt across two harnesses, Claude Code and Codex', () => {
    const repoRoot = (): string => '/w/app';
    const repoIdentity = (): string => 'origin:github.com/org/app';
    const common = { session: 's', project: 'p', rev: 1, at: 'x', redact: makeRedactor(), salt: 'account-one', sid: null, repoRoot, repoIdentity } as const;
    const claudeText = lines('/w/app');
    const rollout = [
      rolloutLine('2026-06-01T10:00:00.000Z', 'session_meta', { id: 'sess-1', session_id: 'sess-1', timestamp: '2026-06-01T10:00:00.000Z', cwd: '/w/app', originator: 'codex_cli_rs', cli_version: '0.50.0' }),
      rolloutLine('2026-06-01T10:00:01.000Z', 'turn_context', { model: 'gpt-5-codex', cwd: '/w/app' }),
      rolloutLine('2026-06-01T10:00:02.000Z', 'event_msg', { type: 'user_message', message: 'read it' }),
    ];
    const codexText = rolloutLines(rollout.map((entry) => JSON.stringify(entry)).join('\n'), 'sess').map((entry) => JSON.stringify(entry)).join('\n');
    const claude = captureSession({ ...common, text: claudeText, bytes: claudeText.length }).session;
    const codex = captureSession({ ...common, text: codexText, bytes: codexText.length, harness: 'codex' }).session;
    const keyOfHarness = (captured: typeof claude, harness: 'claude-code' | 'codex'): string | undefined =>
      skeletonFrom(stored(captured.repo, { frame: frame({ day: '2026-11-01', harness }) })).transcripts[0]?.frame.repoKey;
    const first = keyOfHarness(claude, 'claude-code');
    const second = keyOfHarness(codex, 'codex');
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(second).toBe(first);
    // The harnesses differ on the same wire, so the one key is what joins them.
    expect(skeletonFrom(stored(codex.repo, { frame: frame({ day: '2026-11-01', harness: 'codex' }) })).transcripts[0]?.frame.harness).toBe('codex');
    expect(claude.harness ?? 'claude-code').not.toBe(codex.harness);
  });

  it('does not hold the identity: the key of a repository is not a prefix, suffix, or substring of its remote', () => {
    const key = keyOf('/w/app', 'account-one', 'github.com/org/app') ?? '';
    expect('github.com/org/app').not.toContain(key);
  });
});

describe('through the store', () => {
  it('sets repo on a skeleton-derived store from the key, so a read that groups by repo works from one store', () => {
    const first = skeletonFrom(stored(KEY_A));
    const second = skeletonFrom(stored(KEY_A));
    const third = skeletonFrom(stored(KEY_B));
    const derived = storeOf([{ ...first, id: 'a' }, { ...second, id: 'b' }, { ...third, id: 'c' }]);
    expect(derived.sessions.map(({ repo }) => repo)).toEqual([KEY_A, KEY_A, KEY_B]);
    const groups = new Map<string | null, number>();
    for (const { repo } of derived.sessions) groups.set(repo, (groups.get(repo) ?? 0) + 1);
    expect(Object.fromEntries(groups)).toEqual({ [KEY_A]: 2, [KEY_B]: 1 });
  });

  it('leaves repo null on a skeleton with no key, and changes no cell key', () => {
    expect(storeOf([skeletonFrom(stored(null))]).sessions[0]?.repo).toBeNull();
    const keyed = incrementsOf(skeletonFrom(stored(KEY_A), { orgSize: '11-100', team: 'team', repoVisibility: 'private' }));
    const bare = incrementsOf(skeletonFrom(stored(null)));
    expect([...keyed.cells.keys()]).toEqual([...bare.cells.keys()]);
  });
});

describe('coverage bands', () => {
  it('default to unknown when nothing was read', () => {
    expect(NO_COVERAGE).toEqual({ orgSize: 'unknown', team: 'unknown', repoVisibility: 'unknown' });
    const transcript = skeletonFrom(stored(KEY_A)).transcripts[0];
    expect(transcript?.frame).toMatchObject(NO_COVERAGE);
  });

  it('carry what the operator and the git log gave, on the transcript frame and the frames of its list', () => {
    const coverage: Coverage = { orgSize: '101-1000', team: 'team', repoVisibility: 'public' };
    const transcript = skeletonFrom(stored(KEY_A), coverage).transcripts[0];
    expect(transcript?.frame).toMatchObject(coverage);
    expect(transcript?.frames.every((entry) => entry.orgSize === '101-1000' && entry.team === 'team' && entry.repoVisibility === 'public')).toBe(true);
    expect(parseSkeleton(structuredClone(skeletonFrom(stored(KEY_A), coverage))).ok).toBe(true);
  });

  it('list the pinned members', () => {
    expect(ORG_SIZES).toEqual(['solo', '2-10', '11-100', '101-1000', 'over-1000', 'unknown']);
    expect(TEAMS).toEqual(['solo', 'team', 'unknown']);
    expect(REPO_VISIBILITIES).toEqual(['public', 'private', 'unknown']);
  });

  it('read a value outside its list as other, and keep the text in the extensions bag', () => {
    for (const [field, bad] of [['orgSize', '5000'], ['team', 'duo'], ['repoVisibility', 'internal']] as const) {
      const skeleton = skeletonFrom(stored(KEY_A));
      const first = skeleton.transcripts[0];
      if (first === undefined) throw new Error('no transcript');
      Reflect.set(first.frame, field, bad);
      const result = parseSkeleton(skeleton);
      expect(result).toMatchObject({ ok: true });
      if (!result.ok) throw new Error('refused');
      expect(result.skeleton.transcripts[0]?.frame).toMatchObject({ [field]: 'other' });
      expect(result.extensions).toContainEqual({ at: `transcripts[0].frame.${field}`, kind: 'value', value: bad });
    }
  });

  it('are optional on the wire: a frame with none still parses', () => {
    const skeleton = skeletonFrom(stored(KEY_A));
    const first = skeleton.transcripts[0];
    if (first === undefined) throw new Error('no transcript');
    for (const frames of [[first.frame], first.frames, first.prompts.map(({ frame: entry }) => entry)]) {
      for (const entry of frames) for (const field of ['repoKey', 'orgSize', 'team', 'repoVisibility', 'hour']) Reflect.deleteProperty(entry, field);
    }
    expect(parseSkeleton(skeleton).ok).toBe(true);
  });
});

describe('the hour', () => {
  it('is the UTC hour of the prompt on its frame, of the first line on the transcript frame, and inherited by a call', () => {
    const transcript = skeletonFrom(stored(KEY_A)).transcripts[0];
    expect(transcript?.frame.hour).toBe(13);
    expect(transcript?.prompts[0]?.frame.hour).toBe(22);
    expect(transcript?.frames.map(({ hour }) => hour)).toEqual([13, 22]);
  });

  it('reads the instant, not the offset it was written in', () => {
    expect(hourOf('2026-11-01T23:30:00-05:00')).toBe(4);
    expect(hourOf('2026-11-01T00:00:00.000Z')).toBe(0);
    expect(hourOf('2026-11-01T23:59:59.999Z')).toBe(23);
  });

  it('is absent without a timestamp and refused outside 0 to 23', () => {
    expect(hourOf(null)).toBeNull();
    expect(hourOf(undefined)).toBeNull();
    expect(hourOf('')).toBeNull();
    expect(hourOf('not a time')).toBeNull();
    for (const bad of [-1, 24, 1.5, '7', null]) {
      const skeleton = skeletonFrom(stored(KEY_A));
      const first = skeleton.transcripts[0];
      if (first === undefined) throw new Error('no transcript');
      Reflect.set(first.frame, 'hour', bad);
      expect(parseSkeleton(skeleton)).toMatchObject({ ok: false, field: 'transcripts[0].frame.hour' });
    }
  });

  it('joins no cell: the cell keys are the same with and without it', () => {
    const base = incrementsOf(skeletonFrom(stored(KEY_A)));
    const untimed = stored(KEY_A, { tsFirst: null });
    for (const entry of untimed.prompts) entry.ts = null;
    const noTime = incrementsOf(skeletonFrom(untimed));
    expect(skeletonFrom(untimed).transcripts[0]?.frames.every((entry) => entry.hour === undefined)).toBe(true);
    expect([...noTime.cells.keys()]).toEqual([...base.cells.keys()]);
  });
});

// What the two fields that carry data cost on a skeleton that holds them. The large-deposit fixture has `repo`, `tsFirst`, and every prompt's `ts` null, so it measures only the three `unknown` bands.
describe('bytes on a fixture that carries a repo key and timestamps', () => {
  const HOURS = ['2026-11-01T09:10:00.000Z', '2026-11-01T14:20:00.000Z', '2026-11-01T22:30:00.000Z'];
  const bytesSkeleton = (repo: string | null, timed: boolean): ReturnType<typeof skeletonFrom> => {
    const framed = frame({ day: '2026-11-01', shell: 'bash' });
    const from = store({
      sessions: [session('s1', { frame: framed, repo, tsFirst: timed ? HOURS[0] ?? null : null })],
      prompts: HOURS.map((ts, index) => prompt('s1', index, { frame: framed, ts: timed ? ts : null })),
      tools: HOURS.flatMap((_, index) => [0, 1].map((call) => tool('s1', index * 2 + call, 'Read', { steps: [step(index * 2 + call, 0, 'file.read', { native: 'Read' })], prompt: index }))),
    });
    return skeletonFrom(from);
  };
  const bytesOf = (repo: string | null, timed: boolean): number => JSON.stringify(bytesSkeleton(repo, timed)).length;

  it('puts the hour on one frame per distinct prompt hour, and the key on every frame', () => {
    // A transcript holds its own `frame` and the `frames` its steps ran in (the transcript's own first), so the key is counted on each of those serialized frames.
    const framesOf = (timed: boolean): SkeletonFrame[] => {
      const transcript = bytesSkeleton(KEY_A, timed).transcripts[0];
      if (transcript === undefined) throw new Error('no transcript');
      return [transcript.frame, ...transcript.frames];
    };
    const bare = framesOf(false);
    const timed = framesOf(true);
    // The pinned figures rest on these counts: 2 frames with no timestamp (the transcript's and the one call frame), 4 with three prompt hours (the transcript's and one call frame per hour).
    expect(bare).toHaveLength(2);
    expect(timed).toHaveLength(4);
    expect(bare.every((entry) => entry.repoKey === KEY_A)).toBe(true);
    expect(timed.every((entry) => entry.repoKey === KEY_A)).toBe(true);
    expect(bare.every((entry) => entry.hour === undefined)).toBe(true);
    expect(new Set(timed.map((entry) => entry.hour))).toEqual(new Set([9, 14, 22]));
  });

  it('costs the pinned bytes: the key, and the hour with the frames it splits off', () => {
    const bare = bytesOf(null, false);
    const keyOnly = bytesOf(KEY_A, false);
    const hourOnly = bytesOf(null, true);
    const both = bytesOf(KEY_A, true);
    expect({ bare, keyOnly: keyOnly - bare, hourOnly: hourOnly - bare, both: both - bare }).toEqual({ bare: 3484, keyOnly: 58, hourOnly: 755, both: 871 });
    // The key is 29 bytes (`,"repoKey":"` and 16 hex) on each of 2 frames bare of timestamps and 4 with three prompt hours; the hour is what splits the call frames, one more full frame per distinct hour.
  });
});
