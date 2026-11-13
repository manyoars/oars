import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compactLog, deposit, scanLog, depositSession, derive, loadStore, namesAny, paths, readCalls, readRedactDomains, readSkeletons, slugOf, withLock } from './store.js';
import { CAPTURE_VERSION, EXTRACTOR_VERSION } from './schema.js';
import { addProject, cleanup, NOW, stage } from './test-support.js';

afterEach(cleanup);

const options = (allow: string[]) => ({ allow, redactDomains: [], now: () => NOW });

interface StateFile {
  files: { [key: string]: { v?: string } };
}

const isStateFile = (value: unknown): value is StateFile => typeof value === 'object' && value !== null && typeof Reflect.get(value, 'files') === 'object';

const readStateFile = (storeDir: string): StateFile => {
  const parsed: unknown = JSON.parse(readFileSync(paths(storeDir).state, 'utf8'));
  if (!isStateFile(parsed)) throw new Error('state.json has no files');
  return parsed;
};

const rewriteState = (storeDir: string, change: (state: StateFile) => void): void => {
  const state = readStateFile(storeDir);
  change(state);
  writeFileSync(paths(storeDir).state, JSON.stringify(state));
};

describe('re-deposit on a new extractor version or a wider redaction set', () => {
  it('re-deposits an unchanged file whose recorded version differs, and records the current one', async () => {
    const staged = stage();
    await deposit(staged.runtime, options(['proj']));
    rewriteState(staged.storeDir, (state) => {
      for (const entry of Object.values(state.files)) entry.v = '0';
    });
    const again = await deposit(staged.runtime, options(['proj']));
    expect(again).toMatchObject({ sessions: 4, unchanged: 0 });
    expect(await deposit(staged.runtime, options(['proj']))).toMatchObject({ sessions: 0, unchanged: 4 });
    const state = readStateFile(staged.storeDir);
    expect(Object.values(state.files).every((entry) => entry.v === CAPTURE_VERSION)).toBe(true);
  });

  it('re-deposits every allowed file when the --redact-domain set grows, and not when it repeats', async () => {
    const staged = stage();
    await deposit(staged.runtime, { ...options(['proj']), redactDomains: ['a.example'] });
    expect(await deposit(staged.runtime, { ...options(['proj']), redactDomains: ['a.example'] })).toMatchObject({ sessions: 0, unchanged: 4 });
    expect(await deposit(staged.runtime, { ...options(['proj']), redactDomains: ['b.example'] })).toMatchObject({ sessions: 4, unchanged: 0 });
  });
});

describe('the domain set is recorded per file', () => {
  it('deposits B again when a later run widened the set while only A was allowed', async () => {
    const staged = stage();
    const line = JSON.stringify({ type: 'user', timestamp: '2026-06-01T00:00:00Z', message: { role: 'user', content: 'deploy to build.x.com now' } });
    addProject(staged, 'proj-a', 'a1', [line]);
    addProject(staged, 'proj-b', 'b1', [line]);
    await deposit(staged.runtime, options(['proj-a', 'proj-b']));
    await deposit(staged.runtime, { ...options(['proj-a']), redactDomains: ['x.com'] });
    const third = await deposit(staged.runtime, { ...options(['proj-b']), redactDomains: [] });
    expect(third).toMatchObject({ sessions: 1, unchanged: 0 });
    expect((await loadStore(staged.storeDir)).prompts.find((prompt) => prompt.session === 'b1')?.head).toContain('<org-domain>');
    expect(await deposit(staged.runtime, options(['proj-b']))).toMatchObject({ sessions: 0, unchanged: 1 });
  });
});

describe('deposit', () => {
  it('reads every folder without an --allow, and none that a denial names', async () => {
    const denied = stage();
    expect((await deposit(denied.runtime, options(['!proj']))).sessions).toBe(0);
    const staged = stage();
    expect((await deposit(staged.runtime, options([]))).sessions).toBeGreaterThan(0);
    expect(readFileSync(paths(staged.storeDir).observations, 'utf8')).not.toBe('');
  });

  it('reads only allowed folders, by name or by path, and counts the skipped ones', async () => {
    const staged = stage('-work-app');
    addProject(staged, '-work-other', 'x', ['{"type":"user"}']);
    const byName = await deposit(staged.runtime, options(['-work-app']));
    expect(byName).toMatchObject({ sessions: 4, skippedFolders: 1, folders: ['-work-app'], missing: [], badLines: 1 });
    const workSlug = slugOf(resolve('/work/app'));
    expect(workSlug).toMatch(/work-app$/);
    const staged2 = stage(workSlug);
    const byPath = await deposit(staged2.runtime, options([resolve('/work/app'), resolve('/nowhere')]));
    expect(byPath).toMatchObject({ sessions: 4, folders: [workSlug], missing: [resolve('/nowhere')] });
  });

  it('is idempotent: a second run skips unchanged files and appends nothing', async () => {
    const staged = stage();
    const first = await deposit(staged.runtime, options(['proj']));
    const size = statSync(paths(staged.storeDir).observations).size;
    const second = await deposit(staged.runtime, options(['proj']));
    expect(first.sessions).toBe(4);
    expect(first.observations).toBe(4 + 7 + 18 + 6);
    expect(second).toMatchObject({ sessions: 0, unchanged: 4, observations: 0 });
    expect(statSync(paths(staged.storeDir).observations).size).toBe(size);
  });

  it('reads only the sessions it is asked for, and the session records alone when it is asked for no content', async () => {
    const staged = stage();
    await deposit(staged.runtime, options(['proj']));
    const whole = await loadStore(staged.storeDir);
    const [named] = whole.sessions;
    if (named === undefined) throw new Error('no session');
    const one = await loadStore(staged.storeDir, undefined, { only: new Set([named.session]) });
    expect(one.sessions.map((session) => session.session)).toEqual([named.session]);
    expect(one.prompts.every((prompt) => prompt.session === named.session)).toBe(true);
    expect(one.prompts.length).toBe(whole.prompts.filter((prompt) => prompt.session === named.session).length);
    const heads = await loadStore(staged.storeDir, undefined, { sessionsOnly: true });
    expect(heads.sessions).toHaveLength(whole.sessions.length);
    expect(heads.prompts).toEqual([]);
    expect(heads.tools).toEqual([]);
    expect(heads.errors).toEqual([]);
  });

  it('keeps a line whose session id JSON escaped (jsonescapedid), and drops one that names no wanted session', () => {
    const odd = 'a"b\\c';
    const line = JSON.stringify({ kind: 'session', session: odd, rev: 1 });
    expect(line).toContain(String.raw`"session":"a\"b\\c"`);
    expect(namesAny(line, new Set([odd]))).toBe(true);
    expect(namesAny(line, new Set(['other']))).toBe(true);
    expect(namesAny(JSON.stringify({ kind: 'session', session: 'plain', rev: 1 }), new Set(['other']))).toBe(false);
    expect(namesAny(JSON.stringify({ kind: 'session', session: 'plain', rev: 1 }), new Set(['plain']))).toBe(true);
  });

  it('takes the revs of a scan it is given (revscan) and does not scan the log again', async () => {
    const staged = stage();
    await deposit(staged.runtime, options(['proj']));
    const whole = await loadStore(staged.storeDir);
    const { latest } = await scanLog(paths(staged.storeDir).observations);
    const same = await loadStore(staged.storeDir, undefined, { latest });
    expect(same.sessions).toEqual(whole.sessions);
    expect(same.tools).toEqual(whole.tools);
    // A scan that knows no session keeps no row: proof the log is not scanned again to find the revs.
    const none = await loadStore(staged.storeDir, undefined, { latest: new Map() });
    expect(none.sessions).toEqual([]);
  });

  it('seeks to the lines of the wanted sessions by the byte spans of a scan, and reads no other line (spanseek)', async () => {
    const staged = stage();
    await deposit(staged.runtime, options(['proj']));
    const file = paths(staged.storeDir).observations;
    const { latest, spans, identity } = await scanLog(file, undefined, true);
    const ids = [...latest.keys()];
    expect(ids.length).toBeGreaterThan(1);
    const only = new Set([ids[0] ?? '']);
    let streamed = 0;
    const byStream = await loadStore(staged.storeDir, undefined, { latest, only, lineRead: () => { streamed += 1; } });
    let seeked = 0;
    const bySeek = await loadStore(staged.storeDir, undefined, { latest, only, spans, identity, lineRead: () => { seeked += 1; } });
    expect(bySeek).toEqual(byStream);
    expect(seeked).toBe((spans?.get(ids[0] ?? '') ?? []).length / 2);
    expect(seeked).toBeLessThan(streamed);
    // Everything wanted at once equals the whole read, order included.
    expect(await loadStore(staged.storeDir, undefined, { latest, only: new Set(ids), spans, identity })).toEqual(await loadStore(staged.storeDir));
  });

  it('keeps in the span index only the lines at the highest rev of each session (spanrev)', async () => {
    const staged = stage();
    await deposit(staged.runtime, options(['proj']));
    const log = paths(staged.storeDir).observations;
    const rows = readFileSync(log, 'utf8').split('\n').filter((line) => line !== '');
    // Every row once more at a lower rev, ahead of the live ones: two revs per session, as an uncompacted log holds.
    writeFileSync(log, `${[...rows.map((line) => line.replace(/"rev":\d+/, '"rev":0')), ...rows].join('\n')}\n`);
    const scan = await scanLog(log, undefined, true);
    expect(scan.superseded).toBe(true);
    const lines = readFileSync(log, 'utf8').split('\n').filter((line) => line !== '').length;
    const indexed = [...(scan.spans?.values() ?? [])].reduce((sum, own) => sum + own.length / 2, 0);
    expect(indexed).toBe(lines / 2);
    expect(await loadStore(staged.storeDir, undefined, { latest: scan.latest, only: new Set(scan.latest.keys()), spans: scan.spans, identity: scan.identity })).toEqual(await loadStore(staged.storeDir));
  });

  it('reads the same rows when a compaction moves the log between the scan and the chunk load (spancompact)', async () => {
    const staged = stage();
    await deposit(staged.runtime, options(['proj']));
    const log = paths(staged.storeDir).observations;
    // Superseded lines ahead of the live ones, so a compaction moves every offset after them.
    const rows = readFileSync(log, 'utf8').split('\n').filter((line) => line !== '');
    writeFileSync(log, `${[...rows.map((line) => line.replace(/"rev":\d+/, '"rev":0')), ...rows].join('\n')}\n`);
    const scan = await scanLog(log, undefined, true);
    expect(scan.superseded).toBe(true);
    const only = new Set(scan.latest.keys());
    const streamed = await loadStore(staged.storeDir, undefined, { latest: scan.latest, only });
    const scanned = statSync(log).size;
    await compactLog(staged.storeDir, 0);
    expect(statSync(log).size).toBeLessThan(scanned);
    let read = 0;
    const seeked = await loadStore(staged.storeDir, undefined, { latest: scan.latest, only, spans: scan.spans, identity: scan.identity, lineRead: () => { read += 1; } });
    expect(seeked).toEqual(streamed);
    expect(seeked.sessions).toHaveLength(only.size);
    // The log is not the one that was scanned, so the load streams it as main does.
    expect(read).toBeGreaterThanOrEqual(seeked.sessions.length);
  });

  it('ignores a row appended past the scanned end, even at the scanned rev, and falls back when a rewrite shortened the log (spanappend)', async () => {
    const staged = stage();
    await deposit(staged.runtime, options(['proj']));
    const file = paths(staged.storeDir).observations;
    const { latest, spans, identity } = await scanLog(file, undefined, true);
    const only = new Set(latest.keys());
    const before = await loadStore(staged.storeDir, undefined, { latest, only, spans, identity });
    const first = [...only][0] ?? '';
    // A live session writing: a newer rev of a scanned session, and a torn half line with no newline.
    const row = readFileSync(file, 'utf8').split('\n').find((line) => line.includes(`"session":"${first}"`)) ?? '';
    appendFileSync(file, `${row.replace(/"rev":\d+/, '"rev":99')}\n{"kind":"sess`);
    expect(await loadStore(staged.storeDir, undefined, { latest, only, spans, identity })).toEqual(before);
    // A same-rev copy past the scanned end: a reader that took bytes beyond the end would read it as a second line.
    let reads = 0;
    const baseline = await loadStore(staged.storeDir, undefined, { latest, only, spans, identity, lineRead: () => { reads += 1; } });
    appendFileSync(file, `${row}\n`);
    let readsAfter = 0;
    expect(await loadStore(staged.storeDir, undefined, { latest, only, spans, identity, lineRead: () => { readsAfter += 1; } })).toEqual(baseline);
    expect(readsAfter).toBe(reads);
    // The truncation fallback: a log rewritten shorter than the scan, so no span is misread as another session's row.
    writeFileSync(file, 'not a row\n');
    const after = await loadStore(staged.storeDir, undefined, { latest, only, spans, identity });
    expect(after.sessions).toEqual([]);
    expect(after.errors).toEqual([]);
  });

  it('re-deposits a changed file under a higher rev and a reader keeps only the latest', async () => {
    const staged = stage();
    await deposit(staged.runtime, options(['proj']));
    const before = await loadStore(staged.storeDir);
    const file = join(staged.projectsRoot, 'proj', 'tldr.jsonl');
    appendFileSync(file, `${JSON.stringify({ type: 'user', timestamp: '2026-06-01T00:00:00Z', message: { role: 'user', content: 'one more prompt' } })}\n`);
    const later = new Date(Date.now() + 5000);
    utimesSync(file, later, later);
    const again = await deposit(staged.runtime, options(['proj']));
    const after = await loadStore(staged.storeDir);
    expect(again.sessions).toBe(1);
    expect(after.sessions).toHaveLength(4);
    expect(after.prompts.filter((prompt) => prompt.session === 'tldr')).toHaveLength(before.prompts.filter((prompt) => prompt.session === 'tldr').length + 1);
    const raw = readFileSync(paths(staged.storeDir).observations, 'utf8').split('\n').filter((line) => line !== '');
    expect(raw.length).toBeGreaterThan(after.sessions.length + after.prompts.length + after.errors.length);
  });

  it('never writes raw content beyond the truncations: no secrets, no tool inputs, no replies', async () => {
    const staged = stage();
    await deposit(staged.runtime, options(['proj']));
    const log = readFileSync(paths(staged.storeDir).observations, 'utf8');
    expect(log).not.toContain('abc123');
    expect(log).not.toContain('FAKEFAKE');
    expect(log).not.toContain('echo ok');
    expect(log).not.toContain('You are welcome');
    expect(log).toContain('token=<secret>');
  });

  it('masks the organization domains it is given', async () => {
    const staged = stage();
    addProject(staged, 'org', 'o1', [JSON.stringify({ type: 'user', timestamp: '2026-06-01T00:00:00Z', message: { role: 'user', content: 'deploy to build.corp.example now' } })]);
    await deposit(staged.runtime, { allow: ['org'], redactDomains: ['corp.example'], now: () => NOW });
    expect(readFileSync(paths(staged.storeDir).observations, 'utf8')).toContain('deploy to <org-domain> now');
  });

  it('writes the derived records, one skeleton per session, and stamps the extractor version', async () => {
    const staged = stage();
    await deposit(staged.runtime, options(['proj']));
    expect(readdirSync(paths(staged.storeDir).skeletons).sort()).toEqual(['errors-a.json', 'errors-b.json', 'sidechain.json', 'tldr.json']);
    const store = await loadStore(staged.storeDir);
    const derived = derive(store, 'now');
    const written: unknown = JSON.parse(readFileSync(paths(staged.storeDir).derived, 'utf8'));
    expect(typeof written === 'object' && written !== null && Reflect.get(written, 'sessions')).toBe(4);
    const top = derived.signatures[0];
    expect(top).toMatchObject({ v: EXTRACTOR_VERSION, tool: 'Bash', sessions: 2, count: 2, harnessVersions: ['2.1.300', '2.1.310'] });
    expect(top?.sig).toContain('unexpected EOF while looking for matching quote');
    expect(top?.following).toEqual({ Write: 1, Read: 1, Bash: 1 });
    expect(derived.classes['edit-verify']?.prompts).toBe(2);
    expect(derived.recovery['Write>Read']).toBe(1);
    expect(derived.bigrams['Read>Bash']).toBe(2);
    expect(derived.summaries.find((summary) => summary.session === 'tldr')).toMatchObject({ prompts: 2, errors: 0, tldrs: 1 });
    expect(store.sessions.every((observation) => observation.cv === CAPTURE_VERSION)).toBe(true);
    expect([...store.prompts, ...store.errors].every((observation) => observation.v === EXTRACTOR_VERSION)).toBe(true);
    expect((await readSkeletons(staged.storeDir, 'tldr')).skeletons.map((skeleton) => skeleton.session)).toEqual(['tldr']);
  });

  it('counts a torn skeleton file as unreadable instead of aborting', async () => {
    const staged = stage();
    await deposit(staged.runtime, options(['proj']));
    writeFileSync(join(paths(staged.storeDir).skeletons, 'torn.json'), '{"lines": [');
    const { skeletons, unreadable } = await readSkeletons(staged.storeDir);
    expect(skeletons).toHaveLength(4);
    expect(unreadable).toBe(1);
  });

  it('reads a skeleton written before the cost-state since, models, or model keys fields with them empty', async () => {
    const staged = stage();
    await deposit(staged.runtime, options(['proj']));
    const line = { n: 0, type: 'cost-state', costState: { input: 1, cacheWrite: null, cacheRead: null, output: null } };
    const kept = { n: 1, type: 'cost-state', costState: { since: '2026-01-01T00:00:00.000Z', input: 1, cacheWrite: null, cacheRead: null, output: null, models: ['m', 7, { model: 'n', keys: ['output', 'bogus', 'input'] }, { model: 'o', keys: 'x' }, { keys: [] }, 3] } };
    writeFileSync(join(paths(staged.storeDir).skeletons, 'old.json'), JSON.stringify({ v: '2', session: 'old', project: 'proj', merkleRoot: 'x', leaves: 2, lines: [line, kept, { n: 2, costState: null }] }));
    const old = (await readSkeletons(staged.storeDir, 'old')).skeletons[0];
    expect(old?.lines.map((entry) => entry.costState)).toEqual([
      { ...line.costState, since: null, models: [] },
      { ...kept.costState, models: [{ model: 'm', keys: [] }, { model: 'n', keys: ['input', 'output'] }, { model: 'o', keys: [] }] },
      null,
    ]);
  });

  it('keeps every --redact-domain in state.json across deposits', async () => {
    const staged = stage();
    await deposit(staged.runtime, { ...options(['proj']), redactDomains: ['a.example'] });
    await deposit(staged.runtime, { ...options(['proj']), redactDomains: ['b.example'] });
    expect(await readRedactDomains(staged.storeDir)).toEqual(['a.example', 'b.example']);
    expect(await readRedactDomains(join(staged.root, 'none'))).toEqual([]);
  });

  it('reads a tool row with no key list as an empty one instead of failing every reader', async () => {
    const staged = stage();
    await deposit(staged.runtime, options(['proj']));
    const [tool] = (await loadStore(staged.storeDir)).tools;
    if (tool === undefined) throw new Error('the fixture deposits no tool row');
    const { keys, ...without } = { ...tool, n: 999, toolUseId: 'toolu_without_keys' };
    expect(Array.isArray(keys)).toBe(true);
    appendFileSync(paths(staged.storeDir).observations, `${JSON.stringify(without)}\n`);
    const kept = (await loadStore(staged.storeDir)).tools.find((row) => row.toolUseId === 'toolu_without_keys');
    expect(kept).toMatchObject({ session: tool.session, tool: tool.tool });
    expect(kept?.keys).toEqual([]);
  });

  it('normalizes a tool row whose segments are not a list of records instead of failing every reader', async () => {
    const staged = stage();
    await deposit(staged.runtime, options(['proj']));
    const [tool] = (await loadStore(staged.storeDir)).tools;
    if (tool === undefined) throw new Error('the fixture deposits no tool row');
    const odd: Array<[string, unknown, unknown]> = [
      ['toolu_text_segments', 'not a list', undefined],
      ['toolu_null_segment', [null, { run: 'git status', read: true }], [{ run: 'git status', read: true }]],
      ['toolu_runless_segment', [{ read: true }], []],
      ['toolu_numeric_run', [{ run: 5, read: true }], []],
    ];
    for (const [toolUseId, segments] of odd) {
      appendFileSync(paths(staged.storeDir).observations, `${JSON.stringify({ ...tool, n: 999, toolUseId, segments })}\n`);
    }
    const rows = (await loadStore(staged.storeDir)).tools;
    for (const [toolUseId, , expected] of odd) {
      const row = rows.find((candidate) => candidate.toolUseId === toolUseId);
      expect(row?.segments).toEqual(expected);
      // A text list reads as a record captured before `segments`, which has no such key.
      if (expected === undefined) expect(row).not.toHaveProperty('segments');
    }
  });

  it('derives a prompt whose shell call after an edit holds a malformed key list or segment', async () => {
    // The shapes a hand-edited or foreign log can hold; capture never writes them. All but the text key list used to throw in derive.ts and abort every reader.
    const shapes: Array<[string, { [key: string]: unknown }]> = [
      ['keys is null', { keys: null }],
      ['keys is text', { keys: 'run_in_background' }],
      ['segments is text', { segments: 'not a list' }],
      ['a segment is null', { segments: [null] }],
      ['a segment has no run', { segments: [{ read: true }] }],
      ['a segment run is a number', { segments: [{ run: 5, read: true }] }],
    ];
    for (const [shape, fields] of shapes) {
      const staged = stage();
      await deposit(staged.runtime, options(['proj']));
      const [tool] = (await loadStore(staged.storeDir)).tools;
      if (tool === undefined) throw new Error('the fixture deposits no tool row');
      const edit = { ...tool, tool: 'Edit', status: 'ok', n: 998, toolUseId: 'toolu_edit' };
      const shell = { ...tool, tool: 'Bash', status: 'ok', n: 999, toolUseId: 'toolu_shell', ...fields };
      appendFileSync(paths(staged.storeDir).observations, `${JSON.stringify(edit)}\n${JSON.stringify(shell)}\n`);
      await expect(loadStore(staged.storeDir), shape).resolves.toHaveProperty('tools');
      cleanup();
    }
  });

  it('keeps a session a compaction between the two passes would have dropped', async () => {
    // A lock-free reader (`verify`, the MCP server) can meet a recapture and its compaction between the passes. Both passes read one open file, so the
    // second pass sees the log the first one scanned and the session stays; a reopen would see the compacted log and fail the rev match.
    const staged = stage();
    await deposit(staged.runtime, options(['proj']));
    const file = paths(staged.storeDir).observations;
    const before = await loadStore(staged.storeDir);
    const target = before.sessions[0];
    if (target === undefined) throw new Error('the fixture deposits no session');
    const recapture = readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.includes(`"session":"${target.session}"`))
      .map((line) => line.replace(/"rev":\d+/, `"rev":${String(target.rev + 1)}`));
    const compact = async (): Promise<void> => {
      appendFileSync(file, `${recapture.join('\n')}\n`);
      // Windows refuses to rename over a file a reader holds open, so there the compaction fails and the log is as it was: the reader is safe either way.
      await compactLog(staged.storeDir, 0).catch((error: unknown) => {
        if (process.platform !== 'win32') throw error;
      });
    };
    const during = await loadStore(staged.storeDir, compact);
    expect(during.sessions.map((session) => session.session)).toContain(target.session);
    expect(during.sessions).toHaveLength(before.sessions.length);
    expect((await loadStore(staged.storeDir)).sessions.find((session) => session.session === target.session)?.rev).toBe(target.rev + 1);
  });

  it('reads an empty or missing store as empty', async () => {
    const staged = stage();
    expect(await loadStore(staged.storeDir)).toEqual({ sessions: [], prompts: [], errors: [], subagents: [], tools: [], newerCaptures: 0 });
    expect(await readCalls(staged.storeDir)).toEqual([]);
    expect(await readSkeletons(staged.storeDir)).toEqual({ skeletons: [], unreadable: 0 });
    const missingRoot = { ...staged.runtime, projectsRoot: join(staged.root, 'absent') };
    expect(await deposit(missingRoot, options(['proj']))).toMatchObject({ sessions: 0, skippedFolders: 0, missing: ['proj'] });
  });
});

describe('concurrent hook deposits', () => {
  it('two interleaved session deposits both keep their entry in state.json', async () => {
    const staged = stage();
    const line = JSON.stringify({ type: 'user', timestamp: '2026-06-01T00:00:00Z', message: { role: 'user', content: 'hello' } });
    const a = addProject(staged, 'proj-a', 'a1', [line]);
    const b = addProject(staged, 'proj-b', 'b1', [line]);
    await deposit(staged.runtime, options(['proj-a', 'proj-b']));
    rewriteState(staged.storeDir, (state) => {
      state.files = {};
    });
    await Promise.all([depositSession(staged.runtime, a, () => NOW), depositSession(staged.runtime, b, () => NOW)]);
    expect(Object.keys(readStateFile(staged.storeDir).files).sort()).toEqual(['proj-a/a1.jsonl', 'proj-b/b1.jsonl']);
  });

  it('a lock waits for its holder, breaks a stale one, and gives up on a fresh one that never frees', async () => {
    const staged = stage();
    const order: string[] = [];
    const first = withLock(staged.storeDir, async () => {
      order.push('first in');
      await new Promise((done) => setTimeout(done, 300));
      order.push('first out');
    });
    while (!order.includes('first in')) await new Promise((done) => setTimeout(done, 5));
    const second = withLock(staged.storeDir, () => {
      order.push('second');
      return Promise.resolve();
    });
    await Promise.all([first, second]);
    expect(order).toEqual(['first in', 'first out', 'second']);
    const lock = join(staged.storeDir, 'store.lock');
    writeFileSync(lock, 'old');
    utimesSync(lock, new Date(0), new Date(0));
    await withLock(staged.storeDir, () => Promise.resolve());
    writeFileSync(lock, 'busy');
    await expect(withLock(staged.storeDir, () => Promise.resolve(), { waitMs: 400, staleMs: 600000 })).rejects.toThrow('store is locked');
  });

  it('a stale lock is left in place while another waiter holds the break claim', async () => {
    const staged = stage();
    const lock = join(staged.storeDir, 'store.lock');
    mkdirSync(staged.storeDir, { recursive: true });
    writeFileSync(lock, 'dead');
    utimesSync(lock, new Date(0), new Date(0));
    writeFileSync(`${lock}.break`, 'other waiter');
    await expect(withLock(staged.storeDir, () => Promise.resolve(), { waitMs: 400, staleMs: 600000 })).rejects.toThrow('store is locked');
    expect(readFileSync(lock, 'utf8')).toBe('dead');
  });

  it('two waiters that both see a stale lock leave exactly one writer inside', async () => {
    const staged = stage();
    const lock = join(staged.storeDir, 'store.lock');
    mkdirSync(staged.storeDir, { recursive: true });
    writeFileSync(lock, 'dead');
    utimesSync(lock, new Date(0), new Date(0));
    let inside = 0;
    let most = 0;
    const work = async (): Promise<void> => {
      inside += 1;
      most = Math.max(most, inside);
      await new Promise((done) => setTimeout(done, 150));
      inside -= 1;
    };
    await Promise.all([withLock(staged.storeDir, work), withLock(staged.storeDir, work), withLock(staged.storeDir, work)]);
    expect(most).toBe(1);
  });
});
