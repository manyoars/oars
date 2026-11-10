// t1111: what the sample pack's redaction and selection add for the Fable read of pack 2026-11-10b. Fixture stores in a temp folder; every value is invented.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deposit, type SessionsRuntime } from '../../cli/src/sessions/store.js';
import { buildPack, parseOwners, type OwnerRule, type PackCounts, type PackOptions } from './sample-pack.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const BS = String.fromCharCode(92);
const win = (...parts: string[]): string => parts.join(BS);
const S = (n: number): string => `${String(n).repeat(8)}-1111-4111-8111-111111111111`;
const U = (n: number): string => `${String(n).repeat(8)}-5555-4555-8555-555555555555`;
const line = (value: object): string => JSON.stringify(value);
const at = (n: number): string => `2026-06-01T10:00:${String(n).padStart(2, '0')}.000Z`;
const uuidOf = (session: string, kind: 'a' | 'b', n: number): string => `${session.slice(0, 8)}-${kind}${String(n).padStart(3, '0')}-4222-8222-222222222222`;

interface Fixture {
  root: string;
  runtime: SessionsRuntime;
  cwd: string;
  out: string;
  options: (extra?: Partial<PackOptions>) => PackOptions;
  write: (session: string, lines: readonly string[], project?: string) => void;
  stored: () => Promise<void>;
  setOwners: (owners: readonly object[]) => void;
}

/** `remote` is the origin URL of the fixture repository: the account a session's repository lives under is read from it. */
const fixture = (remote = 'https://github.com/acme-dev/app.git'): Fixture => {
  const root = mkdtempSync(join(tmpdir(), 'oars-sample-pack-redact-'));
  dirs.push(root);
  const projectsRoot = join(root, 'projects');
  mkdirSync(projectsRoot);
  const cwd = join(root, 'work', 'app');
  mkdirSync(join(cwd, '.git'), { recursive: true });
  writeFileSync(join(cwd, '.git', 'config'), `[remote "origin"]\n\turl = ${remote}\n`);
  mkdirSync(join(root, 'notes'));
  writeFileSync(join(root, 'terms.txt'), 'zorblax\n');
  writeFileSync(join(root, 'owners.json'), JSON.stringify([{ folder: '*-oars*', owner: 'Many Oars Co.', license: 'Apache-2.0' }]));
  writeFileSync(join(root, 'index.key'), 'ab'.repeat(32));
  const runtime: SessionsRuntime = { storeDir: join(root, 'store'), projectsRoot, sources: [], stdin: process.stdin, stdout: { write: () => true } };
  return {
    root,
    runtime,
    cwd,
    out: join(root, 'pack'),
    options: (extra = {}) => ({ terms: join(root, 'terms.txt'), owners: join(root, 'owners.json'), indexKey: join(root, 'index.key'), buyerKey: 'sample', out: join(root, 'pack'), size: 25, seed: '1', minTurns: 1, ...extra }),
    write: (session, lines, project = '-work-oars') => {
      mkdirSync(join(projectsRoot, project), { recursive: true });
      writeFileSync(join(projectsRoot, project, `${session}.jsonl`), `${lines.join('\n')}\n`);
    },
    stored: async () => {
      await deposit(runtime, { allow: [], redactDomains: [], now: () => Date.parse('2026-06-10T00:00:00Z') });
    },
    setOwners: (owners) => {
      writeFileSync(join(root, 'owners.json'), JSON.stringify(owners));
    },
  };
};

const user = (f: Fixture, session: string, n: number, content: unknown): string =>
  line({ type: 'user', uuid: uuidOf(session, 'b', n), parentUuid: null, isSidechain: false, timestamp: at(n), version: '2.1.300', sessionId: session, cwd: f.cwd, message: { role: 'user', content } });
const assistant = (session: string, n: number, content: unknown[]): string =>
  line({ type: 'assistant', uuid: uuidOf(session, 'a', n), parentUuid: uuidOf(session, 'b', n), isSidechain: false, timestamp: at(n + 1), version: '2.1.300', sessionId: session, message: { role: 'assistant', model: 'claude-opus-5-5', content, usage: { input_tokens: 10, output_tokens: 20 } } });

const packText = (out: string): string =>
  readdirSync(join(out, 'sessions'), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), 'utf8'))
    .join('\n');

const run = async (f: Fixture, extra: Partial<PackOptions> = {}): Promise<PackCounts> => {
  await f.stored();
  return buildPack(f.runtime, f.options(extra));
};

describe('Item 2: the account the repositories live under', () => {
  it('masks the account of the cwd repository remote as <owner> in a path and a remote URL', async () => {
    const f = fixture();
    f.write(S(1), [
      user(f, S(1), 1, `look at ${win('C:', 'Users', 'dev', 'source', 'repos', 'acme-dev', 'app', 'src')} and /home/dev/src/acme-dev/app/parse.ts`),
      assistant(S(1), 1, [{ type: 'text', text: 'remotes: git@github.com:acme-dev/app.git and https://github.com/acme-dev/app/pull/3 in folder C--Users-dev-source-repos-acme-dev-app' }]),
    ]);
    expect((await run(f)).emitted).toBe(1);
    const text = packText(f.out);
    expect(text).not.toContain('acme-dev');
    expect(text).toContain('/<owner>/app/parse.ts');
    expect(text).toContain('<email>:<owner>/app.git');
    expect(text).toContain('https://<host>/<owner>/app/pull/3');
  });

  it('takes the handle from origin only: an upstream remote and a submodule url keep their accounts in the clear', async () => {
    const f = fixture();
    writeFileSync(
      join(f.cwd, '.git', 'config'),
      '[remote "origin"]\n\turl = https://github.com/acme-dev/app.git\n[remote "upstream"]\n\turl = https://github.com/upstream-co/app.git\n[submodule "vendor"]\n\turl = https://github.com/vendor-co/lib.git\n',
    );
    f.write(S(1), [
      user(f, S(1), 1, 'see https://github.com/upstream-co/app/issues/9 and /srv/vendor-co/lib and /srv/acme-dev/app'),
      assistant(S(1), 1, [{ type: 'text', text: 'ok' }]),
    ]);
    expect((await run(f)).emitted).toBe(1);
    const text = packText(f.out);
    expect(text).not.toContain('acme-dev');
    expect(text).toContain('upstream-co/app/issues/9');
    expect(text).toContain('/srv/vendor-co/lib');
  });

  it('masks an account the owners entry names, whatever remote the session repository has', async () => {
    const f = fixture('https://example.com/other/app.git');
    f.setOwners([{ folder: '*-oars*', owner: 'Many Oars Co.', license: null, handles: ['lamp-co'] }]);
    f.write(S(1), [user(f, S(1), 1, `open ${win('D:', 'repos', 'lamp-co', 'tool')} please`), assistant(S(1), 1, [{ type: 'text', text: 'opened /srv/lamp-co/tool' }])]);
    expect((await run(f)).emitted).toBe(1);
    const text = packText(f.out);
    expect(text).not.toContain('lamp-co');
    expect(text).toContain('/<owner>/tool');
  });

  it('refuses an owners entry whose handles are not a list of names', () => {
    expect(() => parseOwners(JSON.stringify([{ folder: '*', owner: 'x', license: null, handles: 'lamp-co' }]))).toThrow(/handles/);
    expect(() => parseOwners(JSON.stringify([{ folder: '*', owner: 'x', license: null, handles: [''] }]))).toThrow(/handles/);
    const [rule]: OwnerRule[] = parseOwners(JSON.stringify([{ folder: '*', owner: 'x', license: null, handles: ['lamp-co'] }]));
    expect(rule?.handles).toEqual(['lamp-co']);
  });

  it('keys accountUuid and organizationUuid under the buyer key: none in the clear, the same value in every session', async () => {
    const f = fixture();
    const owner = (session: string): string => line({ type: 'session-owner', sessionId: session, accountUuid: U(7), organizationUuid: U(8) });
    // A quoted settings file: the ids sit inside a string, so no line carries them as a key.
    const quoted = JSON.stringify({ oauthAccount: { accountUuid: U(9), organizationUuid: U(6), emailAddress: 'x' } });
    f.write(S(1), [owner(S(1)), user(f, S(1), 1, 'show settings'), assistant(S(1), 1, [{ type: 'text', text: `settings: ${quoted}` }])]);
    f.write(S(2), [owner(S(2)), user(f, S(2), 1, 'again'), assistant(S(2), 1, [{ type: 'text', text: 'ok' }])]);
    expect((await run(f)).emitted).toBe(2);
    const text = packText(f.out);
    for (const id of [U(6), U(7), U(8), U(9)]) expect(text, id).not.toContain(id);
    const masks = text
      .split('\n')
      .filter((row) => row.includes('"session-owner"'))
      .map((row) => ({ account: /"accountUuid":"([^"]+)"/.exec(row)?.[1], organization: /"organizationUuid":"([^"]+)"/.exec(row)?.[1] }));
    expect(masks).toHaveLength(2);
    expect(masks[0]).toEqual(masks[1]);
    expect(masks[0]?.account).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(masks[0]?.account).not.toBe(masks[0]?.organization);
  });
});

const callOf = (session: string, n: number, id: string, name: string, input: object): string => assistant(session, n, [{ type: 'tool_use', id, name, input }]);
const resultOf = (f: Fixture, session: string, n: number, id: string, text: string): string => user(f, session, n, [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] }]);

describe('Item 3: over-masking', () => {
  it('keys a tool id under the buyer key: the call and its result carry one value, in the shape of the id', async () => {
    const f = fixture();
    const id = 'toolu_01AbCdEfGhIjKlMnOpQrStUv';
    f.write(S(1), [user(f, S(1), 1, 'list files'), callOf(S(1), 1, id, 'Bash', { command: 'ls' }), resultOf(f, S(1), 2, id, 'a.txt')]);
    f.write(S(2), [user(f, S(2), 1, 'again'), callOf(S(2), 1, id, 'Bash', { command: 'ls' }), resultOf(f, S(2), 2, id, 'b.txt')]);
    expect((await run(f)).emitted).toBe(2);
    const text = packText(f.out);
    expect(text).not.toContain(id);
    const ids = [...text.matchAll(/toolu_[0-9a-f]{24}/g)].map((match) => match[0]);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(1);
  });

  it('keeps a host the session fetched in that result, masks the rest, and keeps token counts', async () => {
    const f = fixture();
    const id = 'toolu_01FetchFetchFetchFetch';
    f.write(S(1), [
      user(f, S(1), 1, 'read the docs'),
      callOf(S(1), 1, id, 'WebFetch', { url: 'https://docs.example.org/page', prompt: 'p' }),
      resultOf(f, S(1), 2, id, 'cited https://docs.example.org/guide and https://tracker.example.net/x\ntokens: 4096\n1password: a password manager\nadd @scope/name@1.2.3'),
    ]);
    expect((await run(f)).emitted).toBe(1);
    const text = packText(f.out);
    expect(text).toContain('https://docs.example.org/guide');
    expect(text).toContain('https://<host>/x');
    expect(text).toContain('tokens: 4096');
    expect(text).toContain('1password: a password manager');
    expect(text).toContain('@scope/name@1.2.3');
  });
});

const command = (f: Fixture, session: string, name: string, args: string): string =>
  user(f, session, 1, `<command-message>${name.slice(1)}</command-message>\n<command-name>${name}</command-name>\n<command-args>${args}</command-args>`);

describe('Item 4: orchestration lead sessions are not drawn', () => {
  it('leaves out a session whose first prompt is /loop /orchestrate or /orchestrate, counts it lead, and writes the count to pack.json', async () => {
    const f = fixture();
    f.write(S(1), [command(f, S(1), '/loop', '/orchestrate'), assistant(S(1), 1, [{ type: 'text', text: 'leading' }])]);
    f.write(S(2), [command(f, S(2), '/orchestrate', ''), assistant(S(2), 1, [{ type: 'text', text: 'leading' }])]);
    f.write(S(3), [command(f, S(3), '/handoff', 'resume t1086'), assistant(S(3), 1, [{ type: 'text', text: 'working' }])]);
    f.write(S(4), [user(f, S(4), 1, 'orchestrate the loop of the parser'), assistant(S(4), 1, [{ type: 'text', text: 'working' }])]);
    f.write(S(5), [command(f, S(5), '/handoff', 'write a note'), assistant(S(5), 1, [{ type: 'text', text: 'working' }])]);
    const counts = await run(f);
    expect(counts).toMatchObject({ lead: 2, emitted: 3 });
    const pack: unknown = JSON.parse(readFileSync(join(f.out, 'pack.json'), 'utf8'));
    expect(pack).toMatchObject({ counts: { lead: 2 }, redactionVersion: '4' });
    expect(packText(f.out)).not.toContain('leading');
  });

  it('draws /handoff resume in a repository whose owners entry lists no lead prompt, and leaves it out where the entry lists it', async () => {
    const f = fixture();
    f.write(S(1), [command(f, S(1), '/handoff', 'resume t1086'), assistant(S(1), 1, [{ type: 'text', text: 'ordinary work' }])]);
    expect(await run(f)).toMatchObject({ lead: 0, emitted: 1 });
    const g = fixture();
    g.setOwners([{ folder: '*-oars*', owner: 'Many Oars Co.', license: 'Apache-2.0', leadPrompts: ['/handoff resume'] }]);
    g.write(S(1), [command(g, S(1), '/handoff', 'resume t1086'), assistant(S(1), 1, [{ type: 'text', text: 'leading' }])]);
    g.write(S(2), [command(g, S(2), '/handoff', 'write a note'), assistant(S(2), 1, [{ type: 'text', text: 'working' }])]);
    expect(await run(g)).toMatchObject({ lead: 1, emitted: 1 });
    expect(packText(g.out)).not.toContain('leading');
  });

  it('refuses an owners entry whose leadPrompts are not a list of prompts', () => {
    expect(() => parseOwners(JSON.stringify([{ folder: '*', owner: 'x', license: null, leadPrompts: '/handoff resume' }]))).toThrow(/leadPrompts/);
    expect(() => parseOwners(JSON.stringify([{ folder: '*', owner: 'x', license: null, leadPrompts: [''] }]))).toThrow(/leadPrompts/);
    const [rule]: OwnerRule[] = parseOwners(JSON.stringify([{ folder: '*', owner: 'x', license: null, handles: ['a'], leadPrompts: ['/handoff resume'] }]));
    expect(rule).toMatchObject({ handles: ['a'], leadPrompts: ['/handoff resume'] });
  });

  it('leaves out a session whose first prompt matches one the pack is told to treat as one', async () => {
    const f = fixture();
    f.write(S(1), [user(f, S(1), 1, 'PLAN-LEAD start the plan'), assistant(S(1), 1, [{ type: 'text', text: 'leading' }])]);
    f.write(S(2), [user(f, S(2), 1, 'plain work'), assistant(S(2), 1, [{ type: 'text', text: 'working' }])]);
    expect(await run(f, { leadPrompts: [/^PLAN-LEAD\b/] })).toMatchObject({ lead: 1, emitted: 1 });
  });
});
