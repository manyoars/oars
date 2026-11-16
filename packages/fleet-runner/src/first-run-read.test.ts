import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { main, readFirstRun } from './first-run-read.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'first-run-fixtures');
const MODEL = 'anthropic.claude-sonnet-pinned-v1:0';
const MARKER = 'bedrock-key-MARKER-9f3a1c';

interface Files {
  transcript?: string;
  output?: string;
  runBook?: string;
}

const read = (files: Files, extra: string[] = [], modelId = MODEL): Promise<{ code: number; lines: string[] }> => {
  const lines: string[] = [];
  const argv = ['--transcript', join(DIR, files.transcript ?? 'transcript.pass.jsonl'), '--output', join(DIR, files.output ?? 'output.pass.jsonl'), '--run-book', join(DIR, files.runBook ?? 'run-book.jsonl'), '--model-id', modelId, '--allow-server', 'browser', ...extra];
  return main(argv, (line) => lines.push(line)).then((code) => ({ code, lines }));
};

/** The answer and evidence of one question, by the start of its name. */
const answer = (lines: string[], name: string): string => lines.find((text) => text.includes(` ${name}`)) ?? `no line for ${name}`;

/** Inline input for the cases a recorded file would only repeat. */
const inline = (output: string, extra: { transcript?: string; marker?: string; modelId?: string } = {}): string[] =>
  readFirstRun({ transcript: extra.transcript ?? '', output, runBook: '', modelId: extra.modelId ?? 'm', ...(extra.marker === undefined ? {} : { marker: extra.marker }), allowServers: [], allowSkills: [] });

describe('first-run-read: one passing and one failing recording per question', () => {
  it('prints seven lines and exits 0 on a clean run', async () => {
    const { code, lines } = await read({});
    expect(code).toBe(0);
    expect(lines[0]).toContain('reads only');
    expect(lines).toHaveLength(8);
    expect(lines.slice(1).map((text) => text.split(' ')[0])).toEqual(['yes', 'no', 'no', 'cannot', 'yes', 'yes', 'yes']);
  });

  it('scrub: yes when no tool result shows the key, no when one does (and the line never prints the marker)', async () => {
    expect(answer((await read({}, ['--marker', MARKER])).lines, 'scrub')).toMatch(/^yes .*1 tool results read/);
    const failing = (await read({ transcript: 'transcript.fail.jsonl' }, ['--marker', MARKER])).lines;
    expect(answer(failing, 'scrub')).toMatch(/^no .*transcript line 3/);
    expect(failing.join('\n')).not.toContain(MARKER);
    // The marker alone is enough, without the variable's name.
    const markerOnly = JSON.stringify({ message: { content: [{ type: 'tool_result', content: `x ${MARKER}` }] } });
    expect(answer(inline('', { transcript: markerOnly, marker: MARKER }), 'scrub')).toMatch(/^no /);
    // An empty marker is not searched, and the evidence does not claim it was.
    const clean = JSON.stringify({ message: { content: [{ type: 'tool_result', content: 'ok' }] } });
    expect(answer(inline('', { transcript: clean, marker: '' }), 'scrub')).not.toContain('marker');
  });

  it('scrub: cannot tell when the transcript holds no tool result', async () => {
    expect(answer((await read({ transcript: 'transcript.none.jsonl' })).lines, 'scrub')).toMatch(/^cannot tell .*no tool result to search/);
  });

  it('scrub: takes the marker from FIRST_RUN_MARKER, and the flag wins', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'first-run-marker-'));
    try {
      const transcript = join(folder, 'transcript.jsonl');
      writeFileSync(transcript, `${JSON.stringify({ message: { content: [{ type: 'tool_result', content: `x ${MARKER}` }] } })}\n`);
      const argv = ['--transcript', transcript, '--output', join(DIR, 'output.pass.jsonl'), '--run-book', join(DIR, 'run-book.jsonl'), '--model-id', MODEL];
      const fromEnv: string[] = [];
      await main(argv, (line) => fromEnv.push(line), { FIRST_RUN_MARKER: MARKER });
      expect(answer(fromEnv, 'scrub')).toMatch(/^no /);
      expect(fromEnv.join('\n')).not.toContain(MARKER);
      const flagWins: string[] = [];
      await main([...argv, '--marker', 'other-text'], (line) => flagWins.push(line), { FIRST_RUN_MARKER: MARKER });
      expect(answer(flagWins, 'scrub')).toMatch(/^yes /);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it('(a): no on a run that reached its result, yes on a sign-in prompt, cannot tell with no result and no prompt', async () => {
    expect(answer((await read({})).lines, '(a)')).toMatch(/^no .*result event/);
    expect(answer((await read({ output: 'output.a-fail.jsonl' })).lines, '(a)')).toMatch(/^yes .*Welcome to Claude Code/);
    expect(answer(inline(''), '(a)')).toMatch(/^cannot tell/);
    // The error arm has no `result` string: `errors[]` and `startup_failure_reason` carry the refusal.
    expect(answer((await read({ output: 'output.a-fail-arm.jsonl' })).lines, '(a)')).toMatch(/^yes /);
    expect(answer(inline('{"type":"result","subtype":"error_during_execution","is_error":true,"errors":["Please sign in"]}'), '(a)')).toMatch(/^yes .*Please sign in/);
    expect(answer(inline('{"type":"result","subtype":"error_during_execution","is_error":true,"errors":["disk full"],"startup_failure_reason":"gateway_signin_required"}'), '(a)')).toMatch(/^yes .*startup_failure_reason gateway_signin_required/);
  });

  it("(b): no when init lists only the allowed server, yes when it lists the fixture's own server and skill", async () => {
    expect(answer((await read({})).lines, '(b)')).toMatch(/^no .*\[browser\]/);
    expect(answer((await read({ output: 'output.b-fail.jsonl' })).lines, '(b)')).toMatch(/^yes .*\[fixture-db\].*\[deploy\]/);
    expect(answer(inline('{"type":"system","subtype":"init","mcp_servers":[{"name":"db","source":"project"}],"skills":[]}'), '(b)')).toMatch(/^yes .*\[db \(project\)\]/);
    expect(answer(inline('{"type":"system","subtype":"init","model":"m"}'), '(b)')).toMatch(/^cannot tell .*lacks mcp_servers/);
    expect(answer(inline('{"type":"system","subtype":"init","mcp_servers":[]}'), '(b)')).toMatch(/^cannot tell .*lacks skills/);
  });

  it('(b): cannot tell with no init event', async () => {
    expect(answer((await read({ output: 'output.a-fail.jsonl' })).lines, '(b)')).toMatch(/^cannot tell/);
  });

  it('(c): yes when an error result carries a status, no when it does not, cannot tell on a success', async () => {
    expect(answer((await read({ output: 'output.c-pass.jsonl' })).lines, '(c)')).toMatch(/^yes .*api_error_status 429 on result line 2/);
    expect(answer((await read({ output: 'output.c-fail.jsonl' })).lines, '(c)')).toMatch(/^no .*no api_error_status/);
    expect(answer((await read({})).lines, '(c)')).toMatch(/^cannot tell .*not an error/);
    expect(answer((await read({ output: 'output.a-fail.jsonl' })).lines, '(c)')).toMatch(/^cannot tell .*no result/);
    expect(answer(inline('{"type":"result","subtype":"error_max_turns","is_error":true,"api_error_status":429}'), '(c)')).toMatch(/^cannot tell .*error_max_turns/);
  });

  it('(d): yes with an empty permission_denials, no when a tool was denied, cannot tell with no result', async () => {
    expect(answer((await read({})).lines, '(d)')).toMatch(/^yes /);
    expect(answer((await read({ output: 'output.d-fail.jsonl' })).lines, '(d)')).toMatch(/^no .*tools: Bash/);
    expect(answer((await read({ output: 'output.a-fail.jsonl' })).lines, '(d)')).toMatch(/^cannot tell/);
    const message = '{"type":"system","subtype":"permission_denied","tool_name":"Edit"}\n{"type":"result","subtype":"success","permission_denials":[]}';
    expect(answer(inline(message), '(d)')).toMatch(/^no .*1 permission_denied/);
    expect(answer(inline('{"type":"result","subtype":"error_max_turns","permission_denials":[]}'), '(d)')).toMatch(/^no .*error_max_turns/);
  });

  it('(e): yes when the init model is the ID passed, no when it differs, cannot tell with no init', async () => {
    expect(answer((await read({})).lines, '(e)')).toMatch(/^yes /);
    expect(answer((await read({}, [], 'anthropic.other-model')).lines, '(e)')).toContain(`init model is ${MODEL}, passed anthropic.other-model`);
    expect(answer((await read({}, [], 'anthropic.other-model')).lines, '(e)')).toMatch(/^no /);
    expect(answer((await read({ output: 'output.e-fail.jsonl' })).lines, '(e)')).toMatch(/^no .*anthropic.claude-other-v9:0/);
    expect(answer((await read({ output: 'output.a-fail.jsonl' })).lines, '(e)')).toMatch(/^cannot tell/);
  });

  it('(f): yes with all four token fields and a cache equal to read plus creation, no with a field missing or a different record', async () => {
    expect(answer((await read({})).lines, '(f)')).toMatch(/^yes .*cache read 4000, cache creation 500, run record cacheTokens 4500/);
    expect(answer((await read({ output: 'output.f-fail.jsonl' })).lines, '(f)')).toMatch(/^no .*missing .*cacheCreationInputTokens/);
    expect(answer((await read({ runBook: 'run-book.cache-fail.jsonl' })).lines, '(f)')).toMatch(/^no .*not read plus creation/);
  });

  it('(f): cannot tell with no modelUsage, or with no single run record to compare', async () => {
    expect(answer((await read({ output: 'output.a-fail.jsonl' })).lines, '(f)')).toMatch(/^cannot tell .*no modelUsage/);
    expect(answer((await read({}, ['--run-id', 'absent'])).lines, '(f)')).toMatch(/^cannot tell .*unreadable/);
    expect(answer((await read({}, ['--run-id', 'r-1'])).lines, '(f)')).toMatch(/^yes/);
  });

  it('exits 2 with the usage line, or the reason for an unreadable file', async () => {
    const lines: string[] = [];
    expect(await main(['--transcript', 'x'], (line) => lines.push(line))).toBe(2);
    expect(lines[0]).toMatch(/^usage: first-run-read/);
    const missing = await main(['--transcript', join(DIR, 'absent'), '--output', 'o', '--run-book', 'r', '--model-id', 'm'], (line) => lines.push(line));
    expect(missing).toBe(2);
    expect(lines.at(-1)).toMatch(/^first-run-read: /);
  });
});

describe('first-run-read leaves every file as it was', () => {
  it('has byte-identical inputs after a read', async () => {
    const hashes = (): string[] => readdirSync(DIR).sort().map((name) => `${name} ${createHash('sha256').update(readFileSync(join(DIR, name))).digest('hex')}`);
    const before = hashes();
    await read({ transcript: 'transcript.fail.jsonl', output: 'output.d-fail.jsonl' }, ['--marker', MARKER]);
    await read({});
    expect(hashes()).toEqual(before);
    expect(before.length).toBeGreaterThan(10);
  });
});
