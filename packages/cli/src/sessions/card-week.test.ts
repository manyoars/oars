import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../cli.js';
import { harness } from '../test-support.js';
import { weekOf, weekText } from './card-week.js';
import type { Harness } from './schema.js';
import { error, prompt, session, store, tool } from './pool-fixture.js';
import type * as StoreModule from './store.js';
import type { Store } from './store.js';

const held = vi.hoisted((): { store: Store | undefined } => ({ store: undefined }));
vi.mock('./store.js', async (original) => ({ ...(await original<typeof StoreModule>()), loadStore: () => Promise.resolve(held.store) }));
vi.mock('./survival.js', () => ({ readSurvival: () => Promise.resolve(new Map()) }));

/** Noon on a local Monday: every timestamp below is built from local calendar parts, so the tests hold in any time zone. */
const NOW = new Date(2026, 10, 9, 12, 0, 0).getTime();
const at = (day: number, hour = 9, second = 0): string => new Date(2026, 10, day, hour, 0, second).toISOString();
const VERSION = '9.9.9';
const SECRETS = { path: 'C:/Users/alice/secret-repo/src/app.ts', text: 'PROMPT-SECRET-TEXT sk-live-123456', tool: 'mcp__secretserver__do_thing', repo: 'secret-repo' };

const owned = (id: string, harnessName: Harness | undefined): ReturnType<typeof session> =>
  session(id, { project: SECRETS.repo, files: [SECRETS.path], ...(harnessName === undefined ? {} : { harness: harnessName }) });

/** Window Nov 3 to Nov 9 (local). Claude Code: 2 sessions on Nov 3 and Nov 5; Codex: 1 session on Nov 9. */
const weekStore = (): Store => {
  const prompts = [
    prompt('a', 0, { ts: at(3), head: SECRETS.text, verify: 'passed' }),
    prompt('a', 1, { ts: at(3, 10), head: SECRETS.text, verify: 'failed' }),
    prompt('a', 2, { ts: at(3, 11), verify: 'passed' }),
    prompt('a', 3, { ts: at(3, 12), verify: 'na', cls: 'explore-only' }),
    prompt('b', 0, { ts: at(5), verify: 'none' }),
    prompt('c', 0, { ts: at(9, 8), verify: 'passed' }),
  ];
  return store({
    sessions: [owned('a', undefined), owned('b', undefined), owned('c', 'codex')],
    prompts,
    tools: [tool('a', 0, 'Bash', { prompt: 0, status: 'error' }), tool('c', 0, SECRETS.tool, { prompt: 0, status: 'error' })],
    errors: [
      error('a', 'Bash | exit 1', { tool: 'Bash', prompt: 0, example: SECRETS.path }),
      error('a', `${SECRETS.tool} | boom`, { tool: SECRETS.tool, toolUseId: 'e2', prompt: 1 }),
      error('c', 'shell | exit 1', { tool: 'shell', prompt: 0 }),
    ],
  });
};

const EXPECTED = [
  'oars week: 2026-11-03 to 2026-11-09 (7 local days)',
  'sessions       3 on 3 active days',
  'harnesses      claude-code 2, codex 1',
  'failed calls   2 (Codex sessions not counted)',
  'passing runs   2 of 4 edited prompts (Codex sessions not counted)',
  `oars card --week --text  |  oars ${VERSION}`,
].join('\n');

describe('weekText', () => {
  it('prints the exact receipt for two harnesses on three days', () => {
    expect(weekText(weekOf(weekStore(), NOW), VERSION)).toBe(EXPECTED);
  });

  it('prints a truthful empty receipt', () => {
    expect(weekText(weekOf(store({}), NOW), VERSION)).toBe(['oars week: 2026-11-03 to 2026-11-09 (7 local days)', 'no sessions in this window in the local store', `oars card --week --text  |  oars ${VERSION}`].join('\n'));
  });

  it('counts a session at the first second of the window and not one second before it', () => {
    const edge = (ts: string): string => weekText(weekOf(store({ sessions: [owned('a', undefined)], prompts: [prompt('a', 0, { ts })] }), NOW), VERSION);
    expect(edge(new Date(2026, 10, 3, 0, 0, 0).toISOString())).toContain('sessions       1 on 1 active day\n');
    expect(edge(new Date(2026, 10, 2, 23, 59, 59).toISOString())).toContain('no sessions');
    expect(edge(new Date(2026, 10, 10, 0, 0, 0).toISOString())).toContain('no sessions');
  });

  it('shows a fixture path, prompt text, repository, and long-tail tool name nowhere', () => {
    const text = weekText(weekOf(weekStore(), NOW), VERSION);
    for (const secret of Object.values(SECRETS)) expect(text).not.toContain(secret);
    expect(text).not.toContain('$');
    expect(text.split('\n').length).toBeLessThanOrEqual(12);
    for (const line of text.split('\n')) expect(line.length).toBeLessThanOrEqual(80);
    expect(text).not.toContain(String.fromCharCode(27));
  });
});

describe('oars card --week --text through run', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oars-card-week-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const wired = (): ReturnType<typeof harness> => {
    const h = harness();
    h.deps.now = () => NOW;
    h.deps.version = VERSION;
    h.deps.sessions = { storeDir: dir, projectsRoot: join(dir, 'projects'), stdin: process.stdin, stdout: { write: () => true } };
    return h;
  };

  it('prints the receipt and exits 0, and --json carries the counts', async () => {
    held.store = weekStore();
    const h = wired();
    expect(await run(['card', '--week', '--text'], h.deps)).toBe(0);
    expect(h.out.join('')).toBe(`${EXPECTED}\n`);
    const json = wired();
    expect(await run(['--json', 'card', '--week', '--text'], json.deps)).toBe(0);
    expect(JSON.parse(json.out.join(''))).toMatchObject({ ok: true, week: { start: '2026-11-03', end: '2026-11-09', sessions: 3, activeDays: 3 } });
  });

  it('prints the empty receipt over an empty store', async () => {
    held.store = store({});
    const h = wired();
    expect(await run(['card', '--week', '--text'], h.deps)).toBe(0);
    expect(h.out.join('')).toContain('no sessions in this window');
  });

  it('leaves `card --text` without --week as the crew card table', async () => {
    held.store = weekStore();
    const h = wired();
    expect(await run(['card', '--text'], h.deps)).toBe(0);
    expect(h.out.join('')).toContain('oars crew card');
  });
});
