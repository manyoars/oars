// The three per-harness file counts (`seen`, `yielded`, `unreadable`) and the rule that makes `seen` the sum of the outcomes.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FILE_COUNT_RULES, harnessFileCounts, outcomeOf, tally, type FileOutcome } from './harness-files.js';
import type { Source, SourceSession, SourceStore } from './sources.js';
import { cleanup, stage } from './test-support.js';

afterEach(cleanup);

const USER = JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null, isSidechain: false, timestamp: '2026-06-01T10:00:00.000Z', cwd: '/work/app', message: { role: 'user', content: 'fix the build' } });
const ASSISTANT = JSON.stringify({
  type: 'assistant',
  uuid: 'a1',
  parentUuid: 'u1',
  isSidechain: false,
  timestamp: '2026-06-01T10:00:02.000Z',
  requestId: 'req_1',
  message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 1, output_tokens: 2 } },
});
// Valid JSON on every line, none of it in a shape the reader knows: a harness whose record shape moved.
const MOVED = [JSON.stringify({ kind: 'prompt', body: 'fix the build' }), JSON.stringify({ kind: 'reply', body: 'done' })].join('\n');

interface Listed {
  session: SourceSession;
  /** The transcript text, or an Error to throw. */
  text: string | Error;
}

const listed = (id: string, size: number, text: string | Error): Listed => ({ session: { id, folder: null, size, mtimeMs: 1 }, text });

/** A source over canned sessions, so each outcome is forced without a harness's own files. */
const fake = (name: string, sessions: readonly Listed[], extra: Partial<SourceStore> = {}): Source => ({
  name,
  harness: 'codex',
  label: name,
  root: () => '/unused',
  storeFile: () => '/unused',
  open: () =>
    Promise.resolve({
      sessions: sessions.map((entry) => entry.session),
      transcript: (session) => {
        const found = sessions.find((entry) => entry.session.id === session.id);
        if (found?.text instanceof Error) throw found.text;
        return found?.text ?? '';
      },
      rejected: 0,
      unreadable: [],
      where: () => '/unused',
      close: () => undefined,
      ...extra,
    }),
});

const countsOf = async (sources: readonly Source[], setup?: (projectsRoot: string) => void) => {
  const staged = stage();
  // The staged fixtures are Claude Code transcripts too: start from an empty projects folder.
  rmSync(join(staged.projectsRoot, 'proj'), { recursive: true });
  setup?.(staged.projectsRoot);
  const runtime = { ...staged.runtime, sources, sourceRoots: Object.fromEntries(sources.map((source) => [source.name, '/unused'])) };
  return harnessFileCounts(runtime);
};

describe('the file-count rules', () => {
  it('states where each kind of file goes, so the rule is in one place', () => {
    expect(FILE_COUNT_RULES).toMatch(/empty/);
    expect(FILE_COUNT_RULES).toMatch(/skipped by a rule/);
  });

  it('puts every file in exactly one of yielded, unreadable, or not seen', () => {
    expect(outcomeOf({ size: 10, records: 3 })).toBe('yielded');
    expect(outcomeOf({ size: 10, records: 0 })).toBe('unreadable');
    expect(outcomeOf({ size: 10, records: undefined })).toBe('unreadable');
    expect(outcomeOf({ size: 0, records: 0 })).toBe('empty');
    // A read that threw is unreadable even when the file is empty: something was there to fail on.
    expect(outcomeOf({ size: 0, records: undefined })).toBe('unreadable');
  });

  it('tallies seen as the sum of yielded and unreadable', () => {
    const outcomes: FileOutcome[] = ['yielded', 'yielded', 'unreadable', 'empty', 'empty', 'empty'];
    expect(tally(outcomes)).toEqual({ seen: 3, yielded: 2, unreadable: 1 });
  });
});

describe('harnessFileCounts, one test per outcome', () => {
  it('counts a file that yielded records', async () => {
    const counts = await countsOf([fake('a', [listed('s1', 50, `${USER}\n${ASSISTANT}\n`)])]);
    expect(counts.codex).toEqual({ seen: 1, yielded: 1, unreadable: 0 });
  });

  it('counts a file whose records are in a form the reader does not know as unreadable', async () => {
    const counts = await countsOf([fake('a', [listed('s1', 50, MOVED)])]);
    expect(counts.codex).toEqual({ seen: 1, yielded: 0, unreadable: 1 });
  });

  it('counts a file that is not parseable text as unreadable', async () => {
    const counts = await countsOf([fake('a', [listed('s1', 50, '\u0000not json\n{"torn":')])]);
    expect(counts.codex).toEqual({ seen: 1, yielded: 0, unreadable: 1 });
  });

  it('counts a file the reader could not read as unreadable', async () => {
    const counts = await countsOf([fake('a', [listed('s1', 50, new Error('EACCES'))])]);
    expect(counts.codex).toEqual({ seen: 1, yielded: 0, unreadable: 1 });
  });

  it('counts an item the store could not inspect as one unreadable file', async () => {
    const counts = await countsOf([fake('a', [], { unreadable: [{ file: '/x/y', reason: 'EACCES' }] })]);
    expect(counts.codex).toEqual({ seen: 1, yielded: 0, unreadable: 1 });
  });

  it('counts a store that cannot be opened as one unreadable file', async () => {
    const source = { ...fake('a', []), open: () => Promise.reject(new Error('locked')) };
    expect((await countsOf([source])).codex).toEqual({ seen: 1, yielded: 0, unreadable: 1 });
  });

  it('does not count an empty file', async () => {
    const counts = await countsOf([fake('a', [listed('s1', 0, ''), listed('s2', 50, `${USER}\n${ASSISTANT}\n`)])]);
    expect(counts.codex).toEqual({ seen: 1, yielded: 1, unreadable: 0 });
  });

  it('does not count a file the reader skipped by a rule (an unsafe id)', async () => {
    const counts = await countsOf([fake('a', [listed('s1', 50, `${USER}\n${ASSISTANT}\n`)], { rejected: 4 })]);
    expect(counts.codex).toEqual({ seen: 1, yielded: 1, unreadable: 0 });
  });

  it('does not count a session folded into another', async () => {
    const folded: Listed = { session: { id: 's2', folder: null, size: 0, mtimeMs: 0, supersededBy: 's1' }, text: '' };
    const counts = await countsOf([fake('a', [listed('s1', 50, `${USER}\n${ASSISTANT}\n`), folded])]);
    expect(counts.codex).toEqual({ seen: 1, yielded: 1, unreadable: 0 });
  });

  it('keeps seen equal to yielded plus unreadable across a mixed store', async () => {
    const mixed = [listed('s1', 50, `${USER}\n${ASSISTANT}\n`), listed('s2', 50, MOVED), listed('s3', 0, ''), listed('s4', 9, new Error('gone')), listed('s5', 50, `${USER}\n`)];
    const counts = await countsOf([fake('a', mixed, { unreadable: [{ file: '/x', reason: 'EACCES' }] })]);
    const one = counts.codex;
    expect(one).toEqual({ seen: 5, yielded: 2, unreadable: 3 });
    expect(one?.seen).toBe((one?.yielded ?? 0) + (one?.unreadable ?? 0));
  });

  it('closes the store it opened', async () => {
    let closed = 0;
    await countsOf([fake('a', [listed('s1', 50, MOVED)], { close: () => (closed += 1) })]);
    expect(closed).toBe(1);
  });

  it('leaves out a harness with no store', async () => {
    const none = { ...fake('a', []), open: () => Promise.resolve(undefined) };
    expect(await countsOf([none])).toEqual({});
  });
});

describe('harnessFileCounts, Claude Code transcripts', () => {
  const write = (projectsRoot: string, project: string, name: string, text: string): void => {
    mkdirSync(join(projectsRoot, project), { recursive: true });
    writeFileSync(join(projectsRoot, project, name), text);
  };

  it('counts a transcript that yielded, one in a moved shape, a torn one, and leaves an empty one out', async () => {
    const counts = await countsOf([], (root) => {
      write(root, 'p', 'good.jsonl', `${USER}\n${ASSISTANT}\n`);
      write(root, 'p', 'moved.jsonl', `${MOVED}\n`);
      write(root, 'p', 'torn.jsonl', '{"type":"user","mess');
      write(root, 'p', 'empty.jsonl', '');
    });
    expect(counts['claude-code']).toEqual({ seen: 3, yielded: 1, unreadable: 2 });
  });

  it('counts a subagent transcript beside the main ones', async () => {
    const counts = await countsOf([], (root) => {
      write(root, 'p', 'main.jsonl', `${USER}\n${ASSISTANT}\n`);
      write(root, join('p', 'main', 'subagents').replaceAll('\\', '/'), 'agent-x.jsonl', `${USER}\n${ASSISTANT}\n`);
    });
    expect(counts['claude-code']).toEqual({ seen: 2, yielded: 2, unreadable: 0 });
  });

  it('has no entry when there are no transcripts', async () => {
    expect(await countsOf([])).toEqual({});
  });
});
