import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classify, errorKey, extractSession, firstInformative, normalize, signatureOf, type Extract } from './extract.js';
import { entropy, makeRedactor } from './redact.js';
import { EXTRACTOR_VERSION } from './schema.js';
import { FIXTURES } from './test-support.js';

const redact = makeRedactor();
const extractFixture = (name: string): Extract => {
  const text = readFileSync(join(FIXTURES, 'proj', `${name}.jsonl`), 'utf8');
  return extractSession({ text, session: name, project: 'proj', rev: 1, at: '2026-06-10T00:00:00.000Z', bytes: text.length, redact });
};
const NAMES = readdirSync(join(FIXTURES, 'proj')).map((file) => file.replace(/\.jsonl$/, '')).sort();

const field = (value: unknown, key: string): unknown => (typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined);
const golden: unknown = JSON.parse(readFileSync(join(FIXTURES, 'golden.json'), 'utf8'));

describe('parity with the reference scripts (golden.json from parse_sessions, error_signatures, prompt_graphs, cost_per_class)', () => {
  const all = NAMES.map(extractFixture);

  it('matches parse_sessions.py per session', () => {
    for (const extract of all) {
      const expected = field(field(golden, 'sessions'), extract.session.session);
      const { session } = extract;
      expect({
        lines: session.lines,
        bad_lines: session.badLines,
        user_turns: session.userTurns,
        assistant_turns: session.assistantTurns,
        bash_cmds: session.bashCmds,
        tools: session.tools,
        files_touched: session.files,
        searches: session.searches,
        tldrs: session.tldrs,
        confidences: session.confidences,
      }).toEqual({
        lines: field(expected, 'lines'),
        bad_lines: field(expected, 'bad_lines'),
        user_turns: field(expected, 'user_turns'),
        assistant_turns: field(expected, 'assistant_turns'),
        bash_cmds: field(expected, 'bash_cmds'),
        tools: field(expected, 'tools'),
        files_touched: field(expected, 'files_touched'),
        searches: field(expected, 'searches'),
        tldrs: field(expected, 'tldrs'),
        confidences: field(expected, 'confidences'),
      });
    }
  });

  it('matches error_signatures.py', () => {
    const errors = all.flatMap((extract) => extract.errors);
    const bySig = new Map<string, Set<string>>();
    for (const error of errors) bySig.set(error.sig, new Set([...(bySig.get(error.sig) ?? []), error.session]));
    const expected = field(golden, 'errors');
    expect(errors.length).toBe(field(expected, 'error_results'));
    expect(new Set(errors.map((error) => error.session)).size).toBe(field(expected, 'sessions_with_error'));
    expect(bySig.size).toBe(field(expected, 'distinct_signatures'));
    expect(Object.fromEntries([...bySig].filter(([, sessions]) => sessions.size > 1).map(([sig, sessions]) => [sig, sessions.size]))).toEqual(field(expected, 'recurring'));
    expect(errors.filter((error) => error.editFollowed).length).toBe(field(expected, 'edit_followed'));
  });

  it('matches prompt_graphs.py', () => {
    const prompts = all.flatMap((extract) => extract.prompts);
    const expected = field(golden, 'graph');
    const sum = (pick: (prompt: (typeof prompts)[number]) => number): number => prompts.reduce((total, prompt) => total + pick(prompt), 0);
    const classes: { [cls: string]: number } = {};
    const bigrams: { [pair: string]: number } = {};
    const recovery: { [pair: string]: number } = {};
    for (const prompt of prompts) {
      classes[prompt.cls] = (classes[prompt.cls] ?? 0) + 1;
      for (const [pair, count] of Object.entries(prompt.bigrams)) bigrams[pair] = (bigrams[pair] ?? 0) + count;
      if (prompt.recovery.length > 0) recovery[prompt.recovery.join('>')] = (recovery[prompt.recovery.join('>')] ?? 0) + 1;
    }
    expect(prompts.length).toBe(field(expected, 'prompts'));
    expect(sum((prompt) => prompt.tools.length)).toBe(field(expected, 'tools'));
    expect(sum((prompt) => prompt.errors)).toBe(field(expected, 'errors'));
    expect(sum((prompt) => prompt.thinking)).toBe(field(expected, 'thinking'));
    expect(sum((prompt) => prompt.sideTools)).toBe(field(expected, 'side_tools'));
    expect(classes).toEqual(field(expected, 'classes'));
    expect(bigrams).toEqual(field(expected, 'bigrams'));
    expect(recovery).toEqual(field(expected, 'recovery'));
  });

  it('matches cost_per_class.py', () => {
    const prompts = all.flatMap((extract) => extract.prompts);
    const expected = field(golden, 'cost');
    const sum = (pick: (prompt: (typeof prompts)[number]) => number): number => prompts.reduce((total, prompt) => total + pick(prompt), 0);
    expect(prompts.length).toBe(field(expected, 'prompts'));
    expect(sum((prompt) => prompt.usage.input)).toBe(field(expected, 'input'));
    expect(sum((prompt) => prompt.usage.cacheWrite)).toBe(field(expected, 'cache_write'));
    expect(sum((prompt) => prompt.usage.cacheRead)).toBe(field(expected, 'cache_read'));
    expect(sum((prompt) => prompt.usage.output)).toBe(field(expected, 'output'));
    expect(sum((prompt) => prompt.usage.thinking)).toBe(field(expected, 'thinking'));
  });
});

describe('extractSession', () => {
  it('records the errors fixture: signatures, the following tools, and the edit-follow flag', () => {
    const { errors, prompts, session } = extractFixture('errors-a');
    expect(session.v).toBe(EXTRACTOR_VERSION);
    expect(errors.map((error) => error.sig)).toEqual(['Bash | bash: -c: line <n>: unexpected EOF while looking for matching quote', 'Write | File has not been read yet. Read it first before writing to it.']);
    expect(errors[0]).toMatchObject({ tool: 'Bash', next: ['Write', 'Read'], editFollowed: true, harnessVersion: '2.1.300', prompt: 0, cls: 'edit-verify', v: EXTRACTOR_VERSION });
    expect(errors[1]?.next).toEqual(['Read', 'Edit']);
    expect(prompts.map((prompt) => prompt.cls)).toEqual(['edit-verify', 'edit-only', 'no-tools']);
    expect(prompts[0]).toMatchObject({ model: 'claude-opus-5-5', efforts: ['high'], errors: 2, thinking: 1, shape: 'Read>Bash>Write>Read>Edit>Bash', v: EXTRACTOR_VERSION });
    expect(prompts[0]?.wallSec).toBeGreaterThan(0);
    expect(prompts[0]?.contextFingerprint).toMatch(/^-\.[0-9a-f]{12}$/);
    expect(prompts[0]?.explore).toBe(2);
    expect(prompts[0]?.act).toBe(4);
  });

  it('keeps the TLDR and Confidence markers, URLs, searches, and skill attribution', () => {
    const { session, prompts } = extractFixture('tldr');
    expect(session.tldrs).toEqual(['Retry-After is seconds or a date.']);
    expect(session.confidences).toEqual(['high, two sources agree']);
    expect(session.searches).toEqual(['retry-after header semantics']);
    expect(session.urls).toEqual(['https://example.com/docs/retry?token=<secret>']);
    expect(prompts[0]?.skills).toEqual(['deep-dive']);
    expect(prompts.map((prompt) => prompt.cls)).toEqual(['research', 'orchestration']);
  });

  it('counts sidechain tools apart from the main line', () => {
    const { prompts, errors } = extractFixture('sidechain');
    expect(prompts[0]?.sideTools).toBe(1);
    expect(prompts[0]?.tools).toEqual(['Read', 'Bash']);
    // The sidechain Grep error still counts as an error result (error_signatures.py reads every line), the main-line count does not include it.
    expect(errors.map((error) => error.tool)).toEqual(['Grep', 'Bash']);
    expect(prompts[0]?.errors).toBe(1);
  });

  it('counts an unparseable line and goes on', () => {
    const { session, skeleton } = extractFixture('sidechain');
    expect(session.badLines).toBe(1);
    expect(skeleton.leaves).toBe(session.lines);
    expect(skeleton.lines.length).toBe(session.lines - 1);
  });

  it('writes a skeleton with hashes in place of content, and a stable Merkle root', () => {
    const first = extractFixture('errors-a').skeleton;
    const second = extractFixture('errors-a').skeleton;
    expect(first.merkleRoot).toMatch(/^[0-9a-f]{64}$/);
    expect(first.merkleRoot).toBe(second.merkleRoot);
    const text = JSON.stringify(first);
    expect(text).not.toContain('echo ok');
    expect(text).not.toContain('fix the failing build');
    expect(first.lines.every((line) => line.hashes.every((hash) => /^[0-9a-f]{64}$/.test(hash)))).toBe(true);
    const tool = first.lines.find((line) => line.tools.length > 0);
    expect(tool?.tools[0]).toEqual({ id: 't1', name: 'Read' });
    expect(tool?.requestId).toBe('req_errors-a_1');
    expect(extractSession({ text: '', session: 'e', project: 'p', rev: 1, at: 'x', bytes: 0, redact }).skeleton.merkleRoot).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes the root when a raw line changes, and handles an odd leaf count', () => {
    const base = ['{"type":"x"}', '{"type":"y"}', '{"type":"z"}'];
    const root = (lines: string[]): string => extractSession({ text: lines.join('\n'), session: 's', project: 'p', rev: 1, at: 'x', bytes: 0, redact }).skeleton.merkleRoot;
    expect(root(base)).not.toBe(root([base[0] ?? '', base[1] ?? '', '{"type":"w"}']));
  });

  it('never writes raw content beyond the two truncations, and redacts the prompt head', () => {
    const { prompts, errors } = extractFixture('errors-a');
    expect(prompts[0]?.head).toBe('fix the failing build in /work/app/src/main.ts, token=<secret> is set');
    const long = JSON.stringify({ type: 'user', timestamp: '2026-06-10T00:00:00Z', message: { role: 'user', content: 'x'.repeat(500) } });
    expect(extractSession({ text: long, session: 's', project: 'p', rev: 1, at: 'x', bytes: 0, redact }).prompts[0]?.head).toHaveLength(300);
    const withTool = [long, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: {} }] } }), JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', is_error: true, content: `${'e'.repeat(300)}\nsecond line` }] } })];
    const extract = extractSession({ text: withTool.join('\n'), session: 's', project: 'p', rev: 1, at: 'x', bytes: 0, redact });
    expect(extract.prompts[0]?.head).toHaveLength(300);
    expect(extract.errors[0]?.example).toHaveLength(160);
    expect(JSON.stringify(extract)).not.toContain('second line');
    expect(errors[1]?.example.length).toBeLessThanOrEqual(160);
  });
});

describe('request-id dedupe (register A22)', () => {
  const usage = { input_tokens: 1, cache_creation_input_tokens: 10, cache_read_input_tokens: 100, output_tokens: 5, output_tokens_details: { thinking_tokens: 2 } };
  const run = (assistants: object[]): Extract => {
    const prompt = JSON.stringify({ type: 'user', timestamp: '2026-06-10T00:00:00Z', message: { role: 'user', content: 'go' } });
    const lines = assistants.map((extra) => JSON.stringify({ type: 'assistant', timestamp: '2026-06-10T00:00:01Z', ...extra }));
    return extractSession({ text: [prompt, ...lines].join('\n'), session: 's', project: 'p', rev: 1, at: 'x', bytes: 0, redact });
  };
  const line = (requestId: string | undefined, id: string | undefined): object => ({ requestId, message: { id, role: 'assistant', usage, content: [{ type: 'text', text: 'x' }] } });

  it('counts one API response once when its lines share a request id', () => {
    const { prompts, session } = run([line('r1', 'm1'), line('r1', 'm1'), line('r2', 'm2')]);
    expect(prompts[0]?.usage).toEqual({ input: 2, cacheWrite: 20, cacheRead: 200, output: 10, thinking: 4 });
    expect(session.usage.cacheWrite).toBe(20);
    expect(prompts[0]?.turns).toBe(3);
  });

  it('falls back to the message id, and counts lines with neither id every time', () => {
    expect(run([line(undefined, 'm1'), line(undefined, 'm1')]).prompts[0]?.usage.output).toBe(5);
    expect(run([line(undefined, undefined), line(undefined, undefined)]).prompts[0]?.usage.output).toBe(10);
  });

  it('treats an empty request id as absent, so two such lines do not collapse into one response', () => {
    expect(run([line('', 'm1'), line('', 'm2')]).prompts[0]?.usage.output).toBe(10);
    expect(run([line('', ''), line('', '')]).prompts[0]?.usage.output).toBe(10);
    expect(run([line('', 'm1'), line('', 'm1')]).prompts[0]?.usage.output).toBe(5);
  });
});

describe('redact before truncating (review L7)', () => {
  const key = 'AKIAIOSFODNN7EXAMPLE';
  const pad = 'a '.repeat(145); // 290 characters, so the key straddles character 300
  it('masks a key that straddles the prompt head limit', () => {
    const text = JSON.stringify({ type: 'user', timestamp: '2026-06-10T00:00:00Z', message: { role: 'user', content: `${pad}${key} tail` } });
    const head = extractSession({ text, session: 's', project: 'p', rev: 1, at: 'x', bytes: 0, redact }).prompts[0]?.head ?? '';
    expect(head).not.toContain('AKIA');
    expect(head).toContain('<secret>');
    expect(head.length).toBeLessThanOrEqual(300);
  });

  it('masks a key that straddles the error example, TLDR, and Confidence limits', () => {
    const lines = [
      JSON.stringify({ type: 'user', timestamp: '2026-06-10T00:00:00Z', message: { role: 'user', content: 'go' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: {} }, { type: 'text', text: `TLDR: ${'t'.repeat(385)} ${key}
Confidence: ${'c'.repeat(110)} ${key}` }] } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', is_error: true, content: `${'e'.repeat(145)} ${key}` }] } }),
    ];
    const extract = extractSession({ text: lines.join('\n'), session: 's', project: 'p', rev: 1, at: 'x', bytes: 0, redact });
    expect(extract.session.tldrs.join('')).not.toContain('AKIA');
    expect(extract.session.confidences.join('')).not.toContain('AKIA');
    expect(extract.errors[0]?.example).not.toContain('AKIA');
    expect(extract.errors[0]?.example).toContain('<secret>');
  });
});

describe('redact at the signature cut and on branch names (fix round 2)', () => {
  const key = 'AKIAIOSFODNN7EXAMPLE';
  it('masks a key that straddles the 110-character signature cut', () => {
    const lines = [
      JSON.stringify({ type: 'user', timestamp: '2026-06-10T00:00:00Z', message: { role: 'user', content: 'go' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: {} }] } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', is_error: true, content: `${'e '.repeat(50)}${key} tail` }] } }),
    ];
    const sig = extractSession({ text: lines.join('\n'), session: 's', project: 'p', rev: 1, at: 'x', bytes: 0, redact }).errors[0]?.sig ?? '';
    expect(sig).not.toContain('AKIA');
    expect(sig).toContain('<secret>');
  });

  it('masks an organization domain inside a git branch name', () => {
    const line = JSON.stringify({ type: 'user', timestamp: '2026-06-10T00:00:00Z', gitBranch: 'acme.example-sso', message: { role: 'user', content: 'go' } });
    const masked = extractSession({ text: line, session: 's', project: 'p', rev: 1, at: 'x', bytes: 0, redact: makeRedactor(['acme.example']) });
    expect(masked.session.branches).toEqual(['<org-domain>-sso']);
  });

  it('keys an error the same way for deposit and recall: redact, first line, normalize, redact', () => {
    expect(errorKey('Exit code 1\nmail user123@corp.example failed', redact)).toBe('mail <email> failed');
  });
});

describe('normalization (error_signatures.py rules)', () => {
  it('replaces paths, hex, numbers, and quotes, and cuts at 110', () => {
    expect(normalize('  /usr/bin/x failed at 0xdeadbeef: line 42 "name" \'q\'  ')).toBe('<path> failed at <n>xdeadbeef: line <n> <q> <q>');
    expect(normalize('C:\\Users\\me\\a.txt not found')).toBe('<path> not found');
    expect(normalize('g'.repeat(7) + ' ' + 'abcdef0123')).toBe('ggggggg <hex>');
    expect(normalize('x'.repeat(200))).toHaveLength(110);
    expect(normalize('é'.repeat(200))).toHaveLength(110);
  });

  it('takes the first informative line', () => {
    expect(firstInformative('\n<tool_use_error>x</tool_use_error>\nExit code 1\n  real problem \nlater')).toBe('real problem');
    expect(firstInformative('Only you see this\nExit code 2\nboom')).toBe('boom');
    expect(firstInformative('<only markup>')).toBe('<only markup>');
    expect(firstInformative('   ')).toBe('');
    expect(signatureOf('Bash', 'Exit code 1\nfailed 3 times', redact)).toBe('Bash | failed <n> times');
  });

  it('classifies prompts by the shared rule', () => {
    expect(classify([])).toBe('no-tools');
    expect(classify(['Agent', 'Skill'])).toBe('orchestration');
    expect(classify(['WebFetch', 'WebSearch'])).toBe('research');
    expect(classify(['Edit', 'Bash'])).toBe('edit-verify');
    expect(classify(['Bash', 'Edit'])).toBe('edit-only');
    expect(classify(['Read', 'Grep'])).toBe('explore-only');
    expect(classify(['Bash', 'PowerShell'])).toBe('shell-only');
    expect(classify(['Read', 'Bash'])).toBe('mixed');
  });
});

describe('redact', () => {
  it('masks secrets by pattern', () => {
    const mask = makeRedactor();
    const cases = [
      'AKIAIOSFODNN7EXAMPLE',
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'github_pat_abcdefghijklmnopqrstuvwxyz0123',
      'sk-ant-api03-abcdefghijklmnopqrstuvwx',
      'sk_live_abcdefghij1234',
      'whsec_abcdefghij1234',
      'xoxb-1234567890-abcdefgh',
      'eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2Q',
      'AIzaSyA-abcdefghijklmnopqrstuvwxyz012345',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----',
    ];
    for (const secret of cases) expect(mask(`before ${secret} after`)).toBe('before <secret> after');
    expect(mask('Authorization: Bearer abcdefghijklmnop1234')).toBe('Authorization: Bearer <secret>');
    expect(mask('curl https://user:hunter2@host/x')).toBe('curl https://<secret>@host/x');
    expect(mask('API_KEY=abcd1234 and "password": "hunter22"')).toBe('API_KEY=<secret> and "password": "<secret>"');
  });

  it('masks emails and the named organization domains, and keeps ordinary text', () => {
    const mask = makeRedactor(['Corp.Example']);
    expect(mask('mail me@acme.io about build.corp.example today')).toBe('mail <email> about <org-domain> today');
    expect(mask('see /home/user/oars/packages/cli/src/sessions/extract.ts line 3')).toBe('see /home/user/oars/packages/cli/src/sessions/extract.ts line 3');
    expect(makeRedactor()('visit build.corp.example')).toBe('visit build.corp.example');
  });

  it('masks a long random-looking token by entropy and leaves a long ordinary word', () => {
    const mask = makeRedactor();
    expect(mask('id aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3z end')).toBe('id <secret> end');
    expect(mask('internationalization_and_localization_support')).toBe('internationalization_and_localization_support');
    expect(entropy('aaaa')).toBe(0);
    expect(entropy('ab')).toBe(1);
  });
});
