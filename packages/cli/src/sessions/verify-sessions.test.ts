// `oars sessions verify` with the per-session results and the T0 audit (t743).
import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sessionsVerify } from './command.js';
import { deposit, paths, readState } from './store.js';
import { cleanup, NOW, stage } from './test-support.js';

afterEach(cleanup);
const options = { allow: ['proj'], redactDomains: [], now: () => NOW };

describe('sessionsVerify, per session', () => {
  it('reports every session with its rows and a T0 result, and names each row of the T0 table in the text', async () => {
    const staged = stage();
    await deposit(staged.runtime, options);
    const deps = { sessions: staged.runtime, install: undefined, now: () => NOW };
    const verified = await sessionsVerify(deps, { session: undefined });
    expect(verified.failed).toEqual([]);
    const { sessionResults, audit } = verified.report;
    expect(sessionResults.map((entry) => entry.session).sort()).toEqual(['errors-a', 'errors-b', 'sidechain', 'tldr']);
    expect(sessionResults.every((entry) => entry.invariants.length === 10)).toBe(true);
    expect(audit.sessions).toHaveLength(4);
    expect(audit.counts).toEqual({ 'root matches and the counts bind': 4, 'changed since deposit': 0, 'root mismatch': 0, 'counts do not bind': 0, 'not run': 0 });
    expect(verified.document).toMatchObject({ sessionResults, audit });
    for (const row of ['root matches and the counts bind', 'changed since deposit', 'root mismatch', 'counts do not bind', 'not run']) expect(verified.text).toContain(row);
  });

  it('scopes both to --session', async () => {
    const staged = stage();
    await deposit(staged.runtime, options);
    const verified = await sessionsVerify({ sessions: staged.runtime, install: undefined, now: () => NOW }, { session: 'tldr' });
    expect(verified.report.sessionResults.map((entry) => entry.session)).toEqual(['tldr']);
    expect(verified.report.audit.sessions.map((entry) => entry.session)).toEqual(['tldr']);
  });

  it('fails a session whose raw file edit kept the size and mtime, by name, so --strict exits 4', async () => {
    const staged = stage();
    await deposit(staged.runtime, options);
    const raw = join(paths(staged.storeDir).raw, 'proj', 'tldr.jsonl');
    const text = readFileSync(raw, 'utf8');
    const at = text.search(/[a-y]/);
    writeFileSync(raw, `${text.slice(0, at)}z${text.slice(at + 1)}`);
    const state = await readState(staged.storeDir);
    const entry = state.files['proj/tldr.jsonl'];
    if (entry === undefined) throw new Error('no state entry');
    entry.mtimeMs = statSync(raw).mtimeMs;
    writeFileSync(paths(staged.storeDir).state, JSON.stringify(state));
    const verified = await sessionsVerify({ sessions: staged.runtime, install: undefined, now: () => NOW }, { session: undefined });
    expect(verified.failed).toEqual(['merkle: root mismatch']);
    expect(verified.text).toContain('FAIL  tldr: root mismatch');
    expect(verified.report.audit.counts['root mismatch']).toBe(1);
  });

  it('lists a grown file as changed since deposit and does not fail it', async () => {
    const staged = stage();
    await deposit(staged.runtime, options);
    appendFileSync(join(staged.projectsRoot, 'proj', 'tldr.jsonl'), '{"type":"summary"}\n');
    const verified = await sessionsVerify({ sessions: staged.runtime, install: undefined, now: () => NOW }, { session: undefined });
    expect(verified.failed).toEqual([]);
    expect(verified.report.audit.counts['changed since deposit']).toBe(1);
  });
});
