import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../cli.js';
import { harness } from '../test-support.js';
import { prompt, session, store } from './pool-fixture.js';
import { STATUSLINE_ID, statuslineLine } from './statusline.js';
import type * as StoreModule from './store.js';
import type { Store } from './store.js';

const held = vi.hoisted((): { store: Store | undefined; fail: boolean } => ({ store: undefined, fail: false }));
vi.mock('./store.js', async (original) => ({
  ...(await original<typeof StoreModule>()),
  loadStore: () => (held.fail ? Promise.reject(new Error('unreadable store C:/Users/alice/secret-repo')) : Promise.resolve(held.store)),
}));

/** Noon on a local Monday: every timestamp is built from local calendar parts, so the tests hold in any time zone. */
const NOW = new Date(2026, 10, 9, 12, 0, 0).getTime();
const at = (day: number, hour = 9, second = 0): string => new Date(2026, 10, day, hour, 0, second).toISOString();
const SECRETS = { path: 'C:/Users/alice/secret-repo/src/app.ts', text: 'PROMPT-SECRET-TEXT sk-live-123456', repo: 'secret-repo' };
const owned = (id: string): ReturnType<typeof session> => session(id, { project: SECRETS.repo, files: [SECRETS.path] });

/** Window Nov 3 to Nov 9 (local): sessions a and b on Nov 3 and Nov 5, so two sessions on two active days. */
const weekStore = (): Store =>
  store({
    sessions: [owned('a'), owned('b')],
    prompts: [prompt('a', 0, { ts: at(3), head: SECRETS.text }), prompt('a', 1, { ts: at(3, 10), head: SECRETS.text }), prompt('b', 0, { ts: at(5) })],
  });

describe('statuslineLine', () => {
  beforeEach(() => {
    held.fail = false;
  });

  it('prints the exact line for a week with sessions', async () => {
    held.store = weekStore();
    expect(await statuslineLine({ storeDir: 'unused', now: NOW, color: false })).toBe(`${STATUSLINE_ID} 7d: 2 sessions, 2 active days`);
  });

  it('uses the singular at one', async () => {
    held.store = store({ sessions: [owned('a')], prompts: [prompt('a', 0, { ts: at(9, 8) })] });
    expect(await statuslineLine({ storeDir: 'unused', now: NOW, color: false })).toBe(`${STATUSLINE_ID} 7d: 1 session, 1 active day`);
  });

  it('prints a truthful short line over an empty store', async () => {
    held.store = store({});
    expect(await statuslineLine({ storeDir: 'unused', now: NOW, color: false })).toBe(`${STATUSLINE_ID} 7d: 0 sessions, 0 active days`);
  });

  it('counts a session one second inside the window and not one second outside it', async () => {
    const opens = new Date(2026, 10, 3, 0, 0, 0).getTime();
    const closes = new Date(2026, 10, 10, 0, 0, 0).getTime();
    const prompts = [
      prompt('in-open', 0, { ts: new Date(opens).toISOString() }),
      prompt('out-before', 0, { ts: new Date(opens - 1000).toISOString() }),
      prompt('in-close', 0, { ts: new Date(closes - 1000).toISOString() }),
      prompt('out-after', 0, { ts: new Date(closes).toISOString() }),
    ];
    held.store = store({ sessions: prompts.map((p) => owned(p.session)), prompts });
    expect(await statuslineLine({ storeDir: 'unused', now: NOW, color: false })).toBe(`${STATUSLINE_ID} 7d: 2 sessions, 2 active days`);
  });

  it('prints the identifier alone when the store cannot be read, and leaks nothing of the error', async () => {
    held.fail = true;
    const line = await statuslineLine({ storeDir: 'unused', now: NOW, color: false });
    expect(line).toBe(STATUSLINE_ID);
  });

  it('prints the identifier alone when a row is bad', async () => {
    const bad = prompt('a', 0);
    Object.defineProperty(bad, 'ts', { get: () => { throw new Error('bad row'); } });
    held.store = store({ sessions: [owned('a')], prompts: [bad] });
    expect(await statuslineLine({ storeDir: 'unused', now: NOW, color: false })).toBe(STATUSLINE_ID);
  });

  it('is plain ASCII within 40 columns, and wraps in color only when asked', async () => {
    held.store = weekStore();
    const plain = await statuslineLine({ storeDir: 'unused', now: NOW, color: false });
    expect(plain).toMatch(/^[\x20-\x7e]{1,40}$/);
    const colored = await statuslineLine({ storeDir: 'unused', now: NOW, color: true });
    expect(colored).toBe(`\u001b[1m${STATUSLINE_ID}\u001b[0m${plain.slice(STATUSLINE_ID.length)}`);
  });

  it('leaves out every path, prompt, and repository name', async () => {
    held.store = weekStore();
    const line = await statuslineLine({ storeDir: 'unused', now: NOW, color: true });
    for (const secret of Object.values(SECRETS)) expect(line).not.toContain(secret);
  });
});

describe('oars statusline', () => {
  let dir = '';
  beforeEach(() => {
    held.fail = false;
    dir = mkdtempSync(join(tmpdir(), 'oars-statusline-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });
  const wired = (stdin: NodeJS.ReadableStream = process.stdin): ReturnType<typeof harness> => {
    const h = harness({ APPDATA: dir });
    h.deps.now = () => NOW;
    h.deps.sessions = { storeDir: join(dir, 'oars', 'sessions'), projectsRoot: join(dir, 'projects'), stdin, stdout: { write: () => true } };
    return h;
  };

  it('prints exactly one line with a trailing newline and exits 0', async () => {
    held.store = weekStore();
    const h = wired();
    expect(await run(['statusline'], h.deps)).toBe(0);
    expect(h.out.join('')).toBe(`${STATUSLINE_ID} 7d: 2 sessions, 2 active days\n`);
    expect(h.err.join('')).toBe('');
  });

  it('ignores stdin: closed, and with JSON piped in', async () => {
    held.store = weekStore();
    const { Readable } = await import('node:stream');
    const closed = wired(Readable.from([]));
    expect(await run(['statusline'], closed.deps)).toBe(0);
    const piped = wired(Readable.from([JSON.stringify({ model: { display_name: 'x' }, workspace: { current_dir: SECRETS.path } })]));
    expect(await run(['statusline'], piped.deps)).toBe(0);
    expect(piped.out.join('')).toBe(closed.out.join(''));
    expect(piped.out.join('')).not.toContain(SECRETS.path);
  });

  it('prints the identifier alone and exits 0 when the store throws', async () => {
    held.fail = true;
    const h = wired();
    expect(await run(['statusline'], h.deps)).toBe(0);
    expect(h.out.join('')).toBe(`${STATUSLINE_ID}\n`);
  });

  it('prints the identifier alone, without reading any store, when there is no store to find', async () => {
    held.store = weekStore();
    const h = wired();
    h.deps.sessions = undefined;
    expect(await run(['statusline'], h.deps)).toBe(0);
    expect(h.out.join('')).toBe(`${STATUSLINE_ID}\n`);
  });

  it('makes no network call and writes nothing: no telemetry, no weekly line, no catch-up, no file', async () => {
    held.store = weekStore();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const catchUp = vi.fn(() => Promise.resolve());
    const h = wired();
    h.deps.catchUp = catchUp;
    // Friday or later is when the weekly card line is due; it must not appear here.
    h.deps.now = () => new Date(2026, 10, 13, 12, 0, 0).getTime();
    expect(await run(['statusline', '--color'], h.deps)).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(catchUp).not.toHaveBeenCalled();
    expect(h.err.join('')).toBe('');
    expect(existsSync(join(dir, 'oars'))).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
    expect(readdirSync(h.configDir)).toEqual([]);
  });
});
