// Layer 4, T0 (spec 2.4): the raw-file match for a hard link and a cross-volume copy, the root recompute, the count bindings, and the result table.
import { appendFileSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { auditSession, auditStore, formatAudit, type SessionAudit } from './audit.js';
import { deposit, loadStore, paths, readSkeletons, readState } from './store.js';
import { cleanup, NOW, stage, type Staged } from './test-support.js';

afterEach(cleanup);
const options = { allow: ['proj'], redactDomains: [], now: () => NOW };

const audits = async (staged: Staged): Promise<SessionAudit[]> => {
  const store = await loadStore(staged.storeDir);
  const { skeletons } = await readSkeletons(staged.storeDir);
  return auditStore(staged.runtime, [...store.sessions, ...store.subagents], skeletons);
};
const one = async (staged: Staged, session: string): Promise<SessionAudit> => {
  const found = (await audits(staged)).find((audit) => audit.session === session);
  if (found === undefined) throw new Error(`no audit for ${session}`);
  return found;
};
const parts = async (staged: Staged, name: string) => {
  const store = await loadStore(staged.storeDir);
  const { skeletons } = await readSkeletons(staged.storeDir);
  const session = store.sessions.find((entry) => entry.session === name);
  const skeleton = skeletons.find((entry) => entry.session === name);
  if (session === undefined || skeleton === undefined) throw new Error(`missing ${name}`);
  return { session, skeleton };
};
const rawOf = (staged: Staged, name: string): string => join(paths(staged.storeDir).raw, 'proj', `${name}.jsonl`);
const sourceOf = (staged: Staged, name: string): string => join(staged.projectsRoot, 'proj', `${name}.jsonl`);
/** Replaces the hard link in `raw/` with a copy, as a cross-volume deposit leaves it. */
const asCopy = (staged: Staged, name: string): void => {
  const raw = rawOf(staged, name);
  const bytes = readFileSync(raw);
  rmSync(raw);
  writeFileSync(raw, bytes);
};
/** Sets the mtime `state.json` holds for a transcript of `proj`. */
const holdState = async (staged: Staged, name: string, mtimeMs: number): Promise<void> => {
  const state = await readState(staged.storeDir);
  const entry = state.files[`proj/${name}.jsonl`];
  if (entry === undefined) throw new Error('no state entry');
  entry.mtimeMs = mtimeMs;
  writeFileSync(paths(staged.storeDir).state, JSON.stringify(state));
};
/** The same text with one letter changed, so the size is unchanged. */
const edited = (text: string): string => {
  const at = text.search(/[a-y]/);
  return `${text.slice(0, at)}z${text.slice(at + 1)}`;
};

describe('auditSession, hard link', () => {
  it('matches a link whose root and counts hold', async () => {
    const staged = stage();
    await deposit(staged.runtime, options);
    const audit = await one(staged, 'errors-a');
    expect(audit).toMatchObject({ result: 'root matches and the counts bind', tier: 'skeleton', mode: 'link', changedSinceDeposit: false, possibleTampering: false });
    expect(audit.bindings.bind).toBe(true);
  });

  it('calls a link the harness grew since deposit changed, never tampering', async () => {
    const staged = stage();
    await deposit(staged.runtime, options);
    appendFileSync(sourceOf(staged, 'errors-a'), '{"type":"summary"}\n');
    expect(await one(staged, 'errors-a')).toMatchObject({ result: 'changed since deposit', tier: 'skeleton', mode: 'link', changedSinceDeposit: true, possibleTampering: false });
  });

  it('fails a link whose bytes changed under an unchanged size and mtime', async () => {
    const staged = stage();
    await deposit(staged.runtime, options);
    const raw = rawOf(staged, 'errors-a');
    const before = statSync(raw);
    writeFileSync(raw, edited(readFileSync(raw, 'utf8')));
    // The attacker also makes state.json agree, so only the root can tell.
    await holdState(staged, 'errors-a', statSync(raw).mtimeMs);
    expect(statSync(raw).size).toBe(before.size);
    expect(await one(staged, 'errors-a')).toMatchObject({ result: 'root mismatch', tier: 'none', mode: 'link' });
  });
});

describe('auditSession, cross-volume copy', () => {
  it('matches a copy of the same size whose mtime is no older than state.json', async () => {
    const staged = stage();
    await deposit(staged.runtime, options);
    asCopy(staged, 'errors-a');
    expect(await one(staged, 'errors-a')).toMatchObject({ result: 'root matches and the counts bind', mode: 'copy', changedSinceDeposit: false });
  });

  it('counts a copy of a different size as possible tampering, not honest growth', async () => {
    const staged = stage();
    await deposit(staged.runtime, options);
    asCopy(staged, 'errors-a');
    appendFileSync(rawOf(staged, 'errors-a'), '{"type":"summary"}\n');
    expect(await one(staged, 'errors-a')).toMatchObject({ result: 'changed since deposit', tier: 'skeleton', mode: 'copy', changedSinceDeposit: true, possibleTampering: true });
  });

  it('calls a copy older than state.json changed, with no tampering flag when the size holds', async () => {
    const staged = stage();
    await deposit(staged.runtime, options);
    asCopy(staged, 'errors-a');
    utimesSync(rawOf(staged, 'errors-a'), new Date(0), new Date(0));
    expect(await one(staged, 'errors-a')).toMatchObject({ result: 'changed since deposit', mode: 'copy', possibleTampering: false });
  });

  it('reads a link whose source is gone as a copy, and fails an edit that kept its size', async () => {
    const staged = stage();
    await deposit(staged.runtime, options);
    rmSync(sourceOf(staged, 'errors-a'));
    const raw = rawOf(staged, 'errors-a');
    const text = readFileSync(raw, 'utf8');
    // A new file, so its mtime is later than state.json's and its size is unchanged: the match passes and the root decides.
    rmSync(raw);
    writeFileSync(raw, edited(text));
    expect(await one(staged, 'errors-a')).toMatchObject({ result: 'root mismatch', tier: 'none', mode: 'copy' });
  });

  it('reports changed since deposit when state.json holds no entry for the file', async () => {
    const staged = stage();
    await deposit(staged.runtime, options);
    writeFileSync(paths(staged.storeDir).state, JSON.stringify({ files: {}, redactDomains: [], allow: [] }));
    expect(await one(staged, 'errors-a')).toMatchObject({ result: 'changed since deposit', possibleTampering: false });
  });
});

describe('auditSession, the other rows', () => {
  it('is not run, at tier skeleton, when the raw file is gone', async () => {
    const staged = stage();
    await deposit(staged.runtime, options);
    rmSync(rawOf(staged, 'errors-a'));
    expect(await one(staged, 'errors-a')).toMatchObject({ result: 'not run', tier: 'skeleton', mode: null });
  });

  it('is not run for a session with no skeleton', async () => {
    const staged = stage();
    await deposit(staged.runtime, options);
    const store = await loadStore(staged.storeDir);
    const result = await auditStore(staged.runtime, store.sessions, []);
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((audit) => audit.result === 'not run' && audit.tier === 'skeleton' && audit.leaves === 0)).toBe(true);
  });

  it('drops to none when leaves, session.lines, and lines + badLines disagree, even with no raw file', async () => {
    const staged = stage();
    await deposit(staged.runtime, options);
    rmSync(rawOf(staged, 'errors-a'));
    const { session, skeleton } = await parts(staged, 'errors-a');
    const audit = await auditSession(staged.runtime, session, { ...skeleton, leaves: skeleton.leaves + 1 });
    expect(audit).toMatchObject({ result: 'counts do not bind', tier: 'none' });
    expect(audit.bindings).toMatchObject({ leaves: skeleton.leaves + 1, sessionLines: session.lines, bind: false });
    expect((await auditSession(staged.runtime, { ...session, badLines: session.badLines + 1 }, skeleton)).result).toBe('counts do not bind');
  });

  it('fails a matching file that holds fewer lines than the records name', async () => {
    const staged = stage();
    await deposit(staged.runtime, options);
    const { session, skeleton } = await parts(staged, 'errors-a');
    // Both records name one more line than the file holds, so the counts bind and the root decides.
    const audit = await auditSession(staged.runtime, { ...session, lines: session.lines + 1 }, { ...skeleton, leaves: skeleton.leaves + 1, lines: [...skeleton.lines, ...skeleton.lines.slice(0, 1)] });
    expect(audit.bindings.bind).toBe(true);
    expect(audit.result).toBe('root mismatch');
  });

  it('marks a session under 10 leaves as joining no root and counting toward no n, and one at 10 or more as not', async () => {
    const staged = stage();
    await deposit(staged.runtime, options);
    const audit = await one(staged, 'errors-a');
    expect(audit.leaves).toBe(22);
    expect(audit.belowMinLeaves).toBe(false);
    expect((await one(staged, 'errors-b')).belowMinLeaves).toBe(true);
  });
});

describe('formatAudit', () => {
  it('names every row of the T0 table with a count, and lists only the sessions that are not clean', async () => {
    const staged = stage();
    await deposit(staged.runtime, options);
    appendFileSync(sourceOf(staged, 'errors-a'), '{"type":"summary"}\n');
    const all = await audits(staged);
    const text = formatAudit(all);
    for (const row of ['root matches and the counts bind', 'changed since deposit', 'root mismatch', 'counts do not bind', 'not run']) expect(text).toContain(row);
    expect(text).toMatch(/changed since deposit: 1\b/);
    expect(text).toMatch(/root matches and the counts bind: \d+/);
    expect(text).toContain('errors-a');
    expect(text.split('\n').filter((line) => line.startsWith('FAIL')).length).toBe(0);
  });
});
