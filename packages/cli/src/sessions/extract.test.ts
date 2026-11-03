import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { captureSession, classify, errorKey, firstInformative, hashPath, normalize, pathKey, shellTarget, signatureOf, targetOf } from './extract.js';
import { extractSession, type Extract } from './derive.js';
import { entropy, makeRedactor } from './redact.js';
import { CAPTURE_VERSION, EXTRACTOR_VERSION } from './schema.js';
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
    expect(session.cv).toBe(CAPTURE_VERSION);
    expect(errors.map((error) => error.sig)).toEqual(['Bash | bash: -c: line <n>: unexpected EOF while looking for matching quote', 'Write | File has not been read yet. Read it first before writing to it.']);
    expect(errors[0]).toMatchObject({ tool: 'Bash', next: ['Write', 'Read'], editFollowed: true, harnessVersion: '2.1.300', prompt: 0, cls: 'edit-verify', v: EXTRACTOR_VERSION });
    expect(errors[1]?.next).toEqual(['Read', 'Edit']);
    expect(prompts.map((prompt) => prompt.cls)).toEqual(['edit-verify', 'edit-only', 'no-tools']);
    expect(prompts[0]).toMatchObject({ model: 'claude-opus-5-5', efforts: ['high'], errors: 2, thinking: 1, shape: 'Read>Bash>Write>Read>Edit>Bash', v: EXTRACTOR_VERSION });
    expect(prompts[0]?.wallSec).toBeGreaterThan(0);
    // The fixture holds an environment attachment only: version 4 keeps no environment fingerprint (the session's `env` replaces it).
    expect(prompts[0]?.contextFingerprint).toBeNull();
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

describe('cost-state model keys', () => {
  it('records, per model sorted by name, the usage keys its entry reported a nonzero amount on', () => {
    const state = JSON.stringify({
      type: 'cost-state',
      startTime: Date.parse('2026-10-13T15:00:00.000Z'),
      modelUsage: {
        'claude-opus': { inputTokens: 5, cacheCreationInputTokens: 6, cacheReadInputTokens: 7, outputTokens: 8 },
        'claude-haiku-4-5': { inputTokens: 300, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        broken: 'x',
      },
    });
    const { skeleton } = extractSession({ text: state, session: 's', project: 'p', rev: 1, at: 'x', bytes: 0, redact });
    expect(skeleton.lines[0]?.costState?.models).toEqual([
      { model: 'broken', keys: [] },
      { model: 'claude-haiku-4-5', keys: ['input', 'output'] },
      { model: 'claude-opus', keys: ['input', 'cacheWrite', 'cacheRead', 'output'] },
    ]);
    expect(skeleton.lines[0]?.costState).toMatchObject({ input: 305, cacheWrite: 6, cacheRead: 7, output: 28 });
  });

  it('keeps the totals numeric when the only model reports zero cache amounts', () => {
    const state = JSON.stringify({
      type: 'cost-state',
      startTime: Date.parse('2026-10-13T15:00:00.000Z'),
      modelUsage: { 'claude-haiku-4-5': { inputTokens: 300, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
    });
    const { skeleton } = extractSession({ text: state, session: 's', project: 'p', rev: 1, at: 'x', bytes: 0, redact });
    expect(skeleton.lines[0]?.costState).toMatchObject({ cacheWrite: 0, cacheRead: 0 });
    expect(skeleton.lines[0]?.costState?.models).toEqual([{ model: 'claude-haiku-4-5', keys: ['input', 'output'] }]);
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

describe('the tool target (recovery_episodes.py shell_target parity)', () => {
  it('keeps a shell call to its program and subcommand', () => {
    expect(shellTarget('git push -u origin main')).toBe('git push');
    expect(shellTarget(String.raw`cd C:/repo && FOO=1 sudo "C:\Program\npm.exe" --silent ./x $Y run build`)).toBe('npm run');
    expect(shellTarget('cd a; pushd b && ls -la /tmp | wc -l')).toBe('ls');
    expect(shellTarget('& just -f x.just build oars\nsecond line')).toBe('just x.just');
    expect(shellTarget(`git ${'c'.repeat(40)}`)).toBe(`git ${'c'.repeat(30)}`);
    expect(shellTarget('env')).toBe('');
    expect(shellTarget('   ')).toBe('');
  });

  it('hashes a path relative to the working directory, keeps a shell target, and is null otherwise', () => {
    const cwd = String.raw`C:\repo`;
    const hashed = targetOf('Read', { file_path: String.raw`C:\repo\src\a.ts` }, cwd, 'salt', redact);
    expect(hashed.target).toMatch(/^[0-9a-f]{16}$/);
    expect(hashed.base).toBe('cwd');
    expect(targetOf('Edit', { file_path: 'src/a.ts' }, cwd, 'salt', redact)).toEqual(hashed);
    expect(targetOf('Read', { file_path: 'src/a.ts' }, undefined, 'other', redact).target).not.toBe(hashed.target);
    expect(targetOf('Bash', { command: 'git status --short' }, undefined, 'salt', redact)).toEqual({ target: 'git status', base: null });
    expect(targetOf('PowerShell', { command: '' }, undefined, 'salt', redact)).toEqual({ target: null, base: null });
    expect(targetOf('WebFetch', { url: 'https://example.com' }, undefined, 'salt', redact)).toEqual({ target: null, base: null });
  });

  it('hashes from the repository root: one file alike from a nested cwd and a linked worktree (CAPTURE 4)', () => {
    const root = '/work/app';
    const fromRoot = targetOf('Read', { file_path: '/work/app/src/a.ts' }, '/work/app', 'salt', redact, root);
    expect(fromRoot.base).toBe('repo');
    expect(targetOf('Read', { file_path: '/work/app/src/a.ts' }, '/work/app/packages/cli', 'salt', redact, root)).toEqual(fromRoot);
    expect(targetOf('Read', { file_path: 'src/a.ts' }, '/work/app', 'salt', redact, root)).toEqual(fromRoot);
    expect(targetOf('Read', { file_path: '/work/app/.claude/worktrees/t1/src/a.ts' }, '/work/app/.claude/worktrees/t1', 'salt', redact, root)).toEqual(fromRoot);
    expect(pathKey('/work/app/src/a.ts', '/work/app/packages/cli', root)).toEqual({ key: 'src/a.ts', base: 'repo' });
  });

  it('keys the repository root itself, and a bare linked-worktree root, as `.` under the repo base', () => {
    expect(pathKey('/work/app', '/work/app/packages/cli', '/work/app')).toEqual({ key: '.', base: 'repo' });
    expect(pathKey('/work/app/', '/work/app', '/work/app')).toEqual({ key: '.', base: 'repo' });
    expect(pathKey('/work/app/.claude/worktrees/t1', '/work/app/.claude/worktrees/t1', '/work/app')).toEqual({ key: '.', base: 'repo' });
    expect(pathKey('/work/app/.claude/worktrees/t1/src/a.ts', '/work/app', '/work/app')).toEqual({ key: 'src/a.ts', base: 'repo' });
  });

  it('normalizes `../`, `./`, and a trailing slash before keying, and reads an escape from the repository as the cwd base', () => {
    expect(pathKey('../other/a.ts', '/w/app/pkg', '/w/app')).toEqual({ key: 'other/a.ts', base: 'repo' });
    expect(pathKey('./src/a.ts', '/w/app', '/w/app')).toEqual(pathKey('src/a.ts', '/w/app', '/w/app'));
    expect(pathKey('src/', '/w/app', '/w/app')).toEqual({ key: 'src', base: 'repo' });
    expect(pathKey('../../x/n.md', '/w/app/pkg', '/w/app')).toEqual({ key: '/w/x/n.md', base: 'cwd' });
  });

  it('strips a linked-worktree segment at any depth, so a path through a child worktree keys alike with the child checkout from one cwd', () => {
    expect(pathKey('oars/.claude/worktrees/t1/src/a.ts', '/u', '/u')).toEqual(pathKey('oars/src/a.ts', '/u', '/u'));
    expect(pathKey('oars/.claude/worktrees/t1/src/a.ts', '/u', '/u')).toEqual({ key: 'oars/src/a.ts', base: 'repo' });
    expect(pathKey('oars/.claude/worktrees/t1', '/u', '/u')).toEqual({ key: 'oars', base: 'repo' });
  });

  it('matches a UNC root and cwd, whose leading double slash normalize would otherwise collapse', () => {
    expect(pathKey('//wsl$/u/r/src/a.ts', '//wsl$/u/r/pkg', '//wsl$/u/r')).toEqual({ key: 'src/a.ts', base: 'repo' });
    expect(pathKey('//wsl$/u/r', '//wsl$/u/r', '//wsl$/u/r')).toEqual({ key: '.', base: 'repo' });
    expect(pathKey('//wsl$/u/x/a.ts', '//wsl$/u/r', null)).toEqual({ key: '/wsl$/u/x/a.ts', base: 'cwd' });
  });

  it('treats a leading `~/` as absolute, so it is neither joined to the cwd nor read as inside the repository', () => {
    expect(pathKey('~/notes/a.md', '/w/app', '/w/app')).toEqual({ key: '~/notes/a.md', base: 'cwd' });
    expect(pathKey('~/notes/a.md', '/w/app/pkg', '/w/app')).toEqual(pathKey('~/notes/a.md', '/w/other', null));
  });

  it('keeps the working-directory base for a path outside any repository, and says so', () => {
    expect(pathKey('/tmp/x/notes.md', '/tmp/x', null)).toEqual({ key: 'notes.md', base: 'cwd' });
    // A repository is known but the file lies outside it: still the cwd base, the path as written.
    expect(pathKey('/elsewhere/n.md', '/work/app', '/work/app')).toEqual({ key: '/elsewhere/n.md', base: 'cwd' });
    expect(targetOf('Read', { file_path: '/tmp/x/notes.md' }, '/tmp/x', 'salt', redact, null).base).toBe('cwd');
  });

  it('hashes alike under one salt and differently under two (the sid names the salt)', () => {
    const one = hashPath('/work/app/a.ts', '/work/app', '/work/app', 'salt-1');
    expect(hashPath('/work/app/a.ts', '/work/app/x', '/work/app', 'salt-1').hash).toBe(one.hash);
    expect(hashPath('/work/app/a.ts', '/work/app', '/work/app', 'salt-2').hash).not.toBe(one.hash);
  });
});

describe('the version-3 capture records (Item 1, on errors-a.jsonl)', () => {
  // errors-a has no call without a result, so one is appended: a Grep under a third prompt whose result never arrives.
  const unanswered = {
    type: 'assistant',
    uuid: 'errors-a-0022',
    parentUuid: 'errors-a-0021',
    isSidechain: false,
    timestamp: '2026-05-28T20:27:45.000Z',
    version: '2.1.300',
    requestId: 'req_errors-a_10',
    message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 't9', name: 'Grep', input: { pattern: 'x', path: 'src' } }], usage: { input_tokens: 1, output_tokens: 1 } },
  };
  const text = `${readFileSync(join(FIXTURES, 'proj', 'errors-a.jsonl'), 'utf8')}${JSON.stringify(unanswered)}\n`;
  const capture = captureSession({ text, session: 'errors-a', project: 'proj', rev: 1, at: '2026-06-10T00:00:00.000Z', bytes: text.length, redact, salt: 'salt' });
  const base = { kind: 'tool', cv: CAPTURE_VERSION, sid: null, session: 'errors-a', rev: 1, parent: 'errors-a', agentType: null, harnessVersion: '2.1.300', side: false };

  it('writes one tool record per call with every field, one call per status', () => {
    expect(capture.tools.map((tool) => [tool.n, tool.tool, tool.status])).toEqual([
      [0, 'Read', 'ok'], [1, 'Bash', 'error'], [2, 'Write', 'error'], [3, 'Read', 'ok'],
      [4, 'Edit', 'ok'], [5, 'Bash', 'ok'], [6, 'Edit', 'ok'], [7, 'Grep', 'none'],
    ]);
    const [ok, shellError, error] = capture.tools;
    // The fixture's assistant lines carry no cwd, so the target hashes the path as written (relative to the line's cwd when it has one).
    expect(ok).toEqual({ ...base, steps: ok?.steps, n: 0, ts: '2026-05-28T20:26:49.000Z', tool: 'Read', status: 'ok', target: targetOf('Read', { file_path: '/work/app/src/main.ts' }, undefined, 'salt', redact).target, targetBase: 'cwd', keys: ['file_path'], durationMs: 5000, toolUseId: 't1', prompt: 0 });
    // A Bash result is an error by its exit code even when is_error is false.
    expect(shellError).toMatchObject({ tool: 'Bash', status: 'error', keys: ['command'], durationMs: 2000, toolUseId: 't2', prompt: 0 });
    expect(error).toMatchObject({ tool: 'Write', status: 'error', keys: ['content', 'file_path'], toolUseId: 't3', prompt: 0 });
    expect(capture.tools[4]?.keys).toEqual(['file_path', 'new_string', 'old_string']);
    expect(capture.tools[6]).toMatchObject({ toolUseId: 't7', prompt: 1 });
    expect(capture.tools[7]).toEqual({ ...base, steps: capture.tools[7]?.steps, n: 7, ts: '2026-05-28T20:27:45.000Z', tool: 'Grep', status: 'none', target: targetOf('Grep', { path: 'src' }, undefined, 'salt', redact).target, targetBase: 'cwd', keys: ['path', 'pattern'], durationMs: null, toolUseId: 't9', prompt: 2 });
  });

  it('keeps each error line unnormalized, keyed by toolUseId, with the calls before it', () => {
    const [shell, write] = capture.errorLines;
    const raw = 'bash: -c: line 1: unexpected EOF while looking for matching quote';
    expect(normalize(raw)).not.toBe(raw);
    expect(shell).toEqual({ kind: 'error-line', cv: CAPTURE_VERSION, sid: null, session: 'errors-a', rev: 1, toolUseId: 't2', tool: 'Bash', line: raw, ts: '2026-05-28T20:26:59.000Z', harnessVersion: '2.1.300', side: false, prompt: 0, after: 2 });
    expect(write).toMatchObject({ toolUseId: 't3', tool: 'Write', line: 'File has not been read yet. Read it first before writing to it.', after: 3 });
    expect(capture.errorLines).toHaveLength(2);
  });

  it('stamps the skeleton, written at capture, with CAPTURE_VERSION', () => {
    expect(capture.skeleton.v).toBe(CAPTURE_VERSION);
  });
});

describe('one tool call is one tool record (t762)', () => {
  const user = (text: string, cwd: string): string => JSON.stringify({ type: 'user', isSidechain: false, cwd, timestamp: '2026-06-01T00:00:00.000Z', message: { role: 'user', content: text } });
  const call = (id: string, name: string, input: object, cwd: string): string =>
    JSON.stringify({ type: 'assistant', isSidechain: false, cwd, requestId: `r-${id}`, timestamp: '2026-06-01T00:00:01.000Z', message: { role: 'assistant', model: 'm', content: [{ type: 'tool_use', id, name, input }] } });
  const result = (id: string, error = false): string =>
    JSON.stringify({ type: 'user', isSidechain: false, timestamp: '2026-06-01T00:00:02.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: error, content: error ? 'boom' : 'fine' }] } });
  const captureOf = (lines: string[]) => captureSession({ text: lines.join('\n'), session: 's', project: 'proj', rev: 1, at: '', bytes: 0, redact, salt: 'salt' });

  // A resumed session replays the earlier transcript: the same assistant and result lines come again, here from another directory.
  const resumed = captureOf([
    user('first', '/work/app'),
    call('t1', 'Read', { file_path: 'src/a.ts' }, '/work/app'),
    result('t1'),
    call('t2', 'Bash', { command: 'npm test' }, '/work/app'),
    result('t2', true),
    user('resumed', '/work/app/sub'),
    call('t1', 'Read', { file_path: 'src/a.ts' }, '/work/app/sub'),
    result('t1'),
    call('t2', 'Bash', { command: 'npm test' }, '/work/app/sub'),
    result('t2', true),
  ]);

  it('writes the replayed call once, with its status, and not again with status none', () => {
    expect(resumed.tools.map((tool) => [tool.n, tool.toolUseId, tool.tool, tool.status])).toEqual([[0, 't1', 'Read', 'ok'], [1, 't2', 'Bash', 'error']]);
    expect(resumed.tools.map((tool) => tool.prompt)).toEqual([0, 0]);
  });

  it('counts the replayed call once in the session record, and every file hash is the target of a tool record', () => {
    expect(resumed.session.tools).toEqual({ Bash: 1, Read: 1 });
    expect(resumed.session.bashCmds).toBe(1);
    const targets = new Set(resumed.tools.map((tool) => tool.target));
    expect(resumed.session.fileHashes.length).toBeGreaterThan(0);
    for (const hash of resumed.session.fileHashes) expect(targets.has(hash)).toBe(true);
  });

  it('keeps the replayed failure as an error line, and the skeleton of every line', () => {
    expect(resumed.errorLines.map((line) => line.toolUseId)).toEqual(['t2', 't2']);
    expect(resumed.skeleton.lines.flatMap((line) => line.tools.map((tool) => tool.id))).toEqual(['t1', 't2', 't1', 't2']);
  });

  it('still writes a call that has no result yet, and a call with no id once per occurrence', () => {
    const pending = captureOf([user('go', '/work/app'), call('t1', 'Grep', { pattern: 'x' }, '/work/app')]);
    expect(pending.tools.map((tool) => [tool.toolUseId, tool.status])).toEqual([['t1', 'none']]);
    const anonymous = JSON.stringify({ type: 'assistant', isSidechain: false, message: { role: 'assistant', model: 'm', content: [{ type: 'tool_use', name: 'Grep', input: {} }] } });
    expect(captureOf([user('go', '/work/app'), anonymous, anonymous]).tools.map((tool) => [tool.toolUseId, tool.status])).toEqual([[null, 'none'], [null, 'none']]);
  });
});
