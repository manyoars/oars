import { afterEach, describe, expect, it } from 'vitest';
import { sessionsDeposit, sessionsReceipt, type SessionsDeps } from './command.js';
import { handleMessage } from './mcp.js';
import { error, prompt, session, store } from './pool-fixture.js';
import { isoWeek, receiptOf, RECEIPT_FOOTER, RECEIPT_MISS } from './receipt.js';
import { cleanup, NOW, stage } from './test-support.js';

afterEach(() => {
  cleanup();
});

const PLANTED = {
  folder: 'C--Users-alice-secret-repo',
  path: 'C:/Users/alice/secret-repo/src/app.ts',
  branch: 'feature/secret-launch',
  promptText: 'PROMPT-SECRET-TEXT sk-live-123456',
  secret: ['gh', 'p_', 'a1B2c3D4e5F6g7H8i9J0k1L2'].join(''),
  rawError: 'ENOENT /home/alice/secret-dir RAW-ERROR-BEYOND-SIGNATURE',
  longTailTool: 'mcp__secretserver__do_thing',
} as const;

const SIG = `Bash | npm ERR! failed for ${PLANTED.secret}`;
const ago = new Date('2026-11-10T00:00:00Z').getTime();

const planted = () => {
  const owned = (id: string, over: Parameters<typeof session>[1] = {}) => session(id, { project: PLANTED.folder, files: [PLANTED.path], branches: [PLANTED.branch], ...over });
  return store({
    sessions: [owned('s1'), owned('s2', { harness: 'codex' })],
    prompts: [prompt('s1', 0, { head: PLANTED.promptText }), prompt('s2', 0, { head: PLANTED.promptText })],
    errors: [
      error('s1', SIG, { tool: 'Bash', example: PLANTED.rawError, next: ['Edit', PLANTED.longTailTool], editFollowed: true, ts: '2026-11-03T09:00:00.000Z' }),
      error('s1', SIG, { tool: 'Bash', example: PLANTED.rawError, next: ['Edit'], editFollowed: true, ts: '2026-11-03T09:05:00.000Z' }),
      error('s2', SIG, { tool: 'Bash', example: PLANTED.rawError, next: [PLANTED.longTailTool], ts: '2026-10-27T09:00:00.000Z' }),
    ],
  });
};

describe('isoWeek', () => {
  it('names the week that holds the Thursday, across a year boundary', () => {
    expect(isoWeek('2026-11-03T09:00:00.000Z')).toBe('2026-W45');
    expect(isoWeek('2027-01-01T00:00:00.000Z')).toBe('2026-W53');
    expect(isoWeek('2024-12-30T00:00:00.000Z')).toBe('2025-W01');
    expect(isoWeek('2026-11-08T23:59:59.000Z')).toBe('2026-W45');
    expect(isoWeek('not a time')).toBeUndefined();
  });
});

describe('receiptOf', () => {
  it('states the tool, harnesses, signature, sessions, weeks, and what came next, then the footer', () => {
    const block = receiptOf(planted(), { error: 'npm ERR! failed' }, ago);
    expect(block).not.toBeNull();
    const lines = (block ?? '').split('\n');
    expect(lines[0]).toBe('```markdown');
    expect(lines.at(-1)).toBe('```');
    expect(lines.at(-2)).toBe(RECEIPT_FOOTER);
    expect(RECEIPT_FOOTER).toBe('from my local oars record, manyoars.com');
    expect(block).toContain('- Tool: Bash');
    expect(block).toContain('- Harness: claude-code, codex');
    expect(block).toContain('- Earlier sessions that hit it: 2 (3 times)');
    expect(block).toContain('- Weeks: 2026-W45, 2026-W44');
    expect(block).toContain('Edit x2, other x2');
    expect(block).toContain('npm ERR! failed for');
  });

  it('holds nothing private and no ask, token count, or money', () => {
    const block = receiptOf(planted(), { error: 'npm ERR! failed' }, ago) ?? '';
    for (const value of Object.values(PLANTED)) expect(block).not.toContain(value);
    expect(block).not.toContain('secretserver');
    expect(block).not.toContain('alice');
    expect(block).toContain('<secret>');
    expect(block).not.toMatch(/token|\$|usd|install|star|recommend/i);
  });

  it('names an unlisted tool other, and keeps the fence whole around backticks in the signature', () => {
    const odd = store({
      sessions: [session('s1')],
      errors: [error('s1', 'mcp__secretserver__do_thing | bad `quote` here', { tool: 'mcp__secretserver__do_thing', ts: null })],
    });
    const block = receiptOf(odd, { error: 'bad' }, ago) ?? '';
    expect(block).toContain('- Tool: other');
    expect(block).toContain("bad 'quote' here");
    expect(block).toContain('- Weeks: unknown');
    expect(block).toContain('nothing recorded');
    expect(block.match(/```/g)).toHaveLength(2);
    expect(block).not.toContain('secretserver');
  });

  it('cuts a long signature and names an unlisted harness other', () => {
    const long = store({ sessions: [session('s1')], errors: [error('s1', `Bash | ${'x'.repeat(300)}`, { tool: 'Bash' })] });
    expect(receiptOf(long, { error: 'xxx' }, ago)).toContain(`\`${'x'.repeat(120)}\``);
  });

  it('is null when no earlier session hit the error', () => {
    expect(receiptOf(planted(), { error: 'never seen before' }, ago)).toBeNull();
  });
});

describe('sessionsReceipt', () => {
  it('refuses every form but --error', async () => {
    const deps: SessionsDeps = { sessions: undefined, install: undefined, now: () => NOW };
    for (const query of [{ path: 'a.ts' }, { error: 'x', path: 'a.ts' }, { error: 'x', cls: 'edit-verify' }, { error: 'x', sinceDays: 3 }, { form: 'text', text: 'x' } as const]) {
      await expect(sessionsReceipt(deps, query)).rejects.toThrow('--receipt answers one error');
    }
  });

  it('prints the miss line over an empty store and the block over a store that holds the error', async () => {
    const staged = stage();
    const deps: SessionsDeps = { sessions: staged.runtime, install: undefined, now: () => NOW };
    const miss = await sessionsReceipt(deps, { error: 'never seen before' });
    expect(miss.text).toBe(RECEIPT_MISS);
    expect(miss.document).toEqual({ ok: true, receipt: null });
    await sessionsDeposit(deps, { allow: ['proj'], allowFiles: [], redactDomains: [] });
    const hit = await sessionsReceipt(deps, { error: 'unexpected EOF while looking for matching quote' });
    expect(hit.text.startsWith('```markdown\n')).toBe(true);
    expect(hit.text).toContain(RECEIPT_FOOTER);
  });
});

const field = (value: unknown, key: string): unknown => (typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined);

describe('the MCP recall tool', () => {
  it('does not gain the receipt: its schema keeps its inputs and names none', async () => {
    const staged = stage();
    const tools = field(field(await handleMessage(staged.runtime, () => NOW, { jsonrpc: '2.0', id: 1, method: 'tools/list' }), 'result'), 'tools');
    expect(JSON.stringify(tools)).not.toMatch(/receipt/i);
    const properties = Array.isArray(tools) ? field(field(tools[0], 'inputSchema'), 'properties') : undefined;
    expect(Object.keys(typeof properties === 'object' && properties !== null ? properties : {}).sort()).toEqual(['class', 'entity', 'error', 'family', 'path', 'prefix', 'sinceDays', 'text']);
  });
});
