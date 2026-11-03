import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter, once } from 'node:events';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { text as streamText } from 'node:stream/consumers';
import { run } from '../cli.js';
import { ExitCode } from '../errors.js';
import { harness, removeTestDirs } from '../test-support.js';
import { answerOf, claudeEvaluator, readsOf, runClaude, EVALUATOR_MODEL, WORDINGS, type ClaudeExec, type ClaudeSpawnOptions, type GoldEvaluator, type SpawnClaude } from './gold-arms.js';
import { ARMS, confidenceLevel, isGoldDocument, readTurns, renderShown, viewOf, type GoldDocument, type GoldEntry, type TurnCall } from './gold.js';
import { makeRedactor } from './redact.js';
import { addProject, cleanup, stage } from './test-support.js';

afterEach(() => {
  cleanup();
  removeTestDirs();
});

const redact = makeRedactor();
const line = (value: object): string => JSON.stringify(value);
const user = (text: string): string => line({ type: 'user', timestamp: '2026-06-01T00:00:00Z', cwd: '/w', message: { role: 'user', content: text } });
const said = (text: string): string => line({ type: 'assistant', requestedModel: 'm-a', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const edit = (id: string): string => line({ type: 'assistant', cwd: '/w', requestedModel: 'm-a', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Edit', input: { file_path: '/w/a.ts', old_string: 'a', new_string: 'b' } }] } });
const result = (id: string): string => line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });

describe('runClaude', () => {
  // A folder that does not exist, so a seam that is not taken cannot reach a real claude.
  const env = { PATH: join(tmpdir(), 'oars-no-such-folder') };
  const spawned = (): { spawn: SpawnClaude; child: EventEmitter; stdin: PassThrough; stdout: PassThrough; calls: Array<{ command: string; args: readonly string[]; options: ClaudeSpawnOptions }> } => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdin, stdout });
    const calls: Array<{ command: string; args: readonly string[]; options: ClaudeSpawnOptions }> = [];
    return {
      child,
      stdin,
      stdout,
      calls,
      spawn: (command, args, options) => {
        calls.push({ command, args, options });
        return child;
      },
    };
  };

  it('runs from the temp folder under the 180 s kill, sends the text on stdin, and resolves with what stdout said', async () => {
    const fake = spawned();
    const pending = runClaude(['-p'], { stdin: 'the request', env }, fake.spawn);
    expect(fake.calls).toEqual([{ command: 'claude', args: ['-p'], options: { cwd: tmpdir(), env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, timeout: 180_000 } }]);
    expect(await streamText(fake.stdin)).toBe('the request');
    fake.stdout.write('{"a":');
    fake.stdout.end('1}');
    await once(fake.stdout, 'end');
    fake.child.emit('close', 0);
    expect(await pending).toEqual({ code: 0, stdout: '{"a":1}' });
  });

  it('reads a killed call, whose exit code is null, as exit 1, which fails the run', async () => {
    const fake = spawned();
    const pending = runClaude(['-p'], { stdin: '', env }, fake.spawn);
    fake.child.emit('close', null, 'SIGTERM');
    expect(await pending).toEqual({ code: 1, stdout: '' });

    const killed = spawned();
    const ask = claudeEvaluator((args, options) => runClaude(args, options, killed.spawn), env).ask({ system: 's', user: 'u' });
    killed.child.emit('close', null, 'SIGTERM');
    await expect(ask).rejects.toThrow('claude -p failed: exit 1');
  });

  it('rejects with the install hint when the child cannot start', async () => {
    const fake = spawned();
    const pending = runClaude(['-p'], { stdin: '', env }, fake.spawn);
    fake.child.emit('error', new Error('spawn claude ENOENT'));
    await expect(pending).rejects.toThrow(/^Cannot run `claude`: .*Windows npm shim cannot be spawned.*native `claude` binary must be on your PATH/);
  });

  it('takes a broken stdin pipe quietly, since the exit code is what counts', async () => {
    const fake = spawned();
    const pending = runClaude(['-p'], { stdin: '', env }, fake.spawn);
    expect(() => fake.stdin.emit('error', new Error('EPIPE'))).not.toThrow();
    fake.child.emit('close', 1);
    expect(await pending).toEqual({ code: 1, stdout: '' });
  });

  it('spawns for real by default: a binary not on PATH rejects with the install hint', async () => {
    await expect(runClaude(['--version'], { stdin: '', env })).rejects.toThrow('Cannot run `claude`');
  });
});

describe('confidenceLevel', () => {
  it('orders the words, reads a range as its middle, and leaves anything else unread', () => {
    expect(confidenceLevel('Confidence: low')).toBe(0);
    expect(confidenceLevel('**Confidence:** medium, because the test is thin')).toBe(1);
    expect(confidenceLevel('Confidence: moderate')).toBe(1);
    expect(confidenceLevel('Confidence: high on the wiring; the rest is untested')).toBe(2);
    expect(confidenceLevel('Confidence: medium-high.')).toBe(1.5);
    expect(confidenceLevel('Confidence: low to medium')).toBe(0.5);
    expect(confidenceLevel('Confidence:')).toBeNull();
    expect(confidenceLevel('Confidence: 80%')).toBeNull();
    expect(confidenceLevel(null)).toBeNull();
  });
});

describe('answerOf', () => {
  it('takes a leading yes or no in any case, and calls anything else other', () => {
    expect(answerOf('yes')).toBe('yes');
    expect(answerOf(' **No.**\n')).toBe('no');
    expect(answerOf('unclear')).toBe('other');
    expect(answerOf('Nothing to judge')).toBe('other');
    expect(answerOf('')).toBe('other');
  });
});

describe('readsOf', () => {
  const turns = readTurns(
    [
      user('do the thing'),
      said('Working on it. Confidence: low'),
      edit('e1'),
      result('e1'),
      said('Done, and the test passes.\n**Confidence:** high on the wiring\nmail me at a@b.example'),
      user('[Request interrupted by user]'),
      user('that broke the build'),
      said('Sorry.'),
      user('last ask'),
      edit('e2'),
      result('e2'),
    ].join('\n'),
  );

  it('takes the closing reply, its last Confidence line, and the next prompt that is not a marker', () => {
    const reads = readsOf(turns, 0, makeRedactor(['b.example']));
    expect(reads.claim).toContain('Done, and the test passes.');
    expect(reads.claim).not.toContain('b.example');
    expect(reads.confidence).toBe('**Confidence:** high on the wiring');
    expect(readsOf(readTurns([user('a'), said('Working. Confidence: low')].join('\n')), 0, redact).confidence).toBeNull();
    expect(reads.later).toBe('that broke the build');
  });

  it('reads nothing where the turn has no reply and no later prompt', () => {
    expect(readsOf(turns, 3, redact)).toEqual({ claim: null, confidence: null, later: null });
  });

  it('skips a blank closing reply for the last one with text, and caps what it keeps', () => {
    const long = readTurns([user('ask'), said('x'.repeat(9000)), said('   ')].join('\n'));
    const { claim } = readsOf(long, 0, redact);
    expect(claim).toHaveLength(4000);
    const lengthy = readTurns([user('ask'), said(`Confidence: ${'x'.repeat(500)}`), user('y'.repeat(9000))].join('\n'));
    const reads = readsOf(lengthy, 0, redact);
    expect(reads.confidence).toHaveLength(200);
    expect(reads.later).toHaveLength(2000);
  });
});

describe('the arms', () => {
  const entry = (extra: Partial<GoldEntry>): GoldEntry => ({
    id: 'G1',
    session: 's',
    index: 0,
    project: 'p',
    model: 'm',
    cls: 'code',
    subagents: 0,
    signals: { verify: 'none', stopped: null, commits: 0, redo: false },
    shown: '',
    ...extra,
  });
  const read = (name: string, value: GoldEntry): number | null => ARMS.find((arm) => arm.arm === name)?.read(value) ?? null;

  it('has no reading where a sidecar has none, or the reader said neither', () => {
    for (const name of ['confidence', 'claim', 'evaluator', 'later']) expect(read(name, entry({}))).toBeNull();
    expect(read('later', entry({ answers: { later: 'other' } }))).toBeNull();
  });

  it('reads a yes above a no, and a higher Confidence above a lower one', () => {
    for (const name of ['claim', 'evaluator', 'later'] as const) {
      expect(read(name, entry({ answers: { [name]: 'yes' } }))).toBe(1);
      expect(read(name, entry({ answers: { [name]: 'no' } }))).toBe(0);
    }
    expect(read('confidence', entry({ reads: { claim: null, confidence: 'Confidence: high', later: null } }))).toBe(2);
    expect(read('confidence', entry({ reads: { claim: null, confidence: 'Confidence: maybe', later: null } }))).toBeNull();
  });
});

describe('claudeEvaluator', () => {
  const init = (apiKeySource: string): string => line({ type: 'system', subtype: 'init', apiKeySource });
  const replied = (text: string): string => line({ type: 'result', subtype: 'success', is_error: false, result: text });
  const scripted = (stdout: string, code = 0): { exec: ClaudeExec; calls: Array<{ args: readonly string[]; stdin: string; env: NodeJS.ProcessEnv }> } => {
    const calls: Array<{ args: readonly string[]; stdin: string; env: NodeJS.ProcessEnv }> = [];
    return {
      calls,
      exec: (args, options) => {
        calls.push({ args, ...options });
        return Promise.resolve({ code, stdout });
      },
    };
  };
  const env = { ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 't', ANTHROPIC_BASE_URL: 'u', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CODE_USE_FOUNDRY: '1', PATH: '/bin' };

  it('asks one isolated, toolless turn on the named model, with no key in its environment and the text on stdin', async () => {
    const { exec, calls } = scripted([init('none'), replied('yes')].join('\n'));
    expect(await claudeEvaluator(exec, env).ask({ system: 'the wording', user: 'the text' })).toBe('yes');
    const [call] = calls;
    expect(call?.stdin).toBe('the text');
    expect(call?.env).toEqual({ PATH: '/bin' });
    const args = call?.args ?? [];
    expect(args).not.toContain('the text');
    expect(args[args.indexOf('--model') + 1]).toBe(EVALUATOR_MODEL);
    expect(args[args.indexOf('--system-prompt') + 1]).toBe('the wording');
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('');
    expect(args[args.indexOf('--settings') + 1]).toBe('{"disableAllHooks":true}');
    for (const flag of ['-p', '--no-session-persistence', '--strict-mcp-config', '--disable-slash-commands']) expect(args).toContain(flag);
  });

  it('refuses a call that a key paid for, and says plainly when a call failed', async () => {
    await expect(claudeEvaluator(scripted([init('ANTHROPIC_API_KEY'), replied('yes')].join('\n')).exec, env).ask({ system: 's', user: 'u' })).rejects.toThrow('not the subscription');
    await expect(claudeEvaluator(scripted('', 1).exec, env).ask({ system: 's', user: 'u' })).rejects.toThrow('exit 1');
    await expect(claudeEvaluator(scripted(`not json\n${init('none')}\n${line({ type: 'result', is_error: true, result: 'limit reached' })}`).exec, env).ask({ system: 's', user: 'u' })).rejects.toThrow('limit reached');
    await expect(claudeEvaluator(scripted(init('none')).exec, env).ask({ system: 's', user: 'u' })).rejects.toThrow('no result');
  });

  it('is ready only on a claude.ai login with first-party routing', async () => {
    // Pretty-printed, as the real command prints it.
    const status = (value: object): ClaudeExec => scripted(JSON.stringify(value, null, 2)).exec;
    await expect(claudeEvaluator(status({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' }), env).ready()).resolves.toBeUndefined();
    await expect(claudeEvaluator(status({ loggedIn: true, authMethod: 'apiKey', apiProvider: 'firstParty' }), env).ready()).rejects.toThrow('subscription login');
    await expect(claudeEvaluator(status({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'bedrock' }), env).ready()).rejects.toThrow('subscription login');
    await expect(claudeEvaluator(scripted('[]').exec, env).ready()).rejects.toThrow('subscription login');
    await expect(claudeEvaluator(scripted('not json').exec, env).ready()).rejects.toThrow('subscription login');
  });
});

describe('oars sessions gold arms', () => {
  const setup = () => {
    const staged = stage();
    const h = harness();
    h.deps.sessions = staged.runtime;
    return { ...h, staged };
  };
  const hidden = (session: string): string[] => [user(`${session} ask`), edit(`${session}-e`), result(`${session}-e`), said(`${session} is done.\nConfidence: medium`)];

  const sampled = async (h: ReturnType<typeof setup>): Promise<{ file: string; sidecar: string }> => {
    addProject(h.staged, 'gold', 'one', [...hidden('one'), user('thanks, good')]);
    addProject(h.staged, 'gold', 'two', hidden('two'));
    expect(await run(['sessions', 'deposit', '--allow', 'gold'], h.deps)).toBe(ExitCode.OK);
    const dir = join(h.staged.root, 'review');
    mkdirSync(dir, { recursive: true });
    expect(await run(['sessions', 'gold', 'sample', '--size', '10', '--out-dir', dir, '--seed', 's'], h.deps)).toBe(ExitCode.OK);
    const date = new Date(h.deps.now()).toISOString().slice(0, 10);
    h.out.length = 0;
    return { file: join(dir, `outcome-gold-${date}.md`), sidecar: join(dir, `outcome-gold-${date}.arms.json`) };
  };
  const sidecarOf = (file: string): GoldDocument => {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!isGoldDocument(value)) throw new Error('not a sidecar');
    return value;
  };

  const answering = (answer: (system: string, text: string) => string): GoldEvaluator & { asked: Array<{ system: string; user: string }> } => {
    const asked: Array<{ system: string; user: string }> = [];
    return {
      asked,
      ready: () => Promise.resolve(),
      ask: (call) => {
        asked.push(call);
        return Promise.resolve(answer(call.system, call.user));
      },
    };
  };

  it('fills the sidecar, leaves the gold file alone, records the hashed wording and model, and prints only coverage', async () => {
    const h = setup();
    const { file, sidecar } = await sampled(h);
    const before = readFileSync(file, 'utf8');
    const evaluator = answering(() => 'yes');
    h.staged.runtime.evaluator = evaluator;
    expect(await run(['sessions', 'gold', 'arms', file], h.deps)).toBe(ExitCode.OK);
    expect(readFileSync(file, 'utf8')).toBe(before);

    const document = sidecarOf(sidecar);
    const first = document.entries.find((entry) => entry.shown.includes('one ask'));
    const second = document.entries.find((entry) => entry.shown.includes('two ask'));
    expect(first?.reads).toEqual({ claim: 'one is done.\nConfidence: medium', confidence: 'Confidence: medium', later: 'thanks, good' });
    expect(first?.answers).toEqual({ evaluator: 'yes', claim: 'yes', later: 'yes' });
    expect(second?.reads?.later).toBeNull();
    expect(second?.answers).toEqual({ evaluator: 'yes', claim: 'yes' });
    expect(document.evaluators?.model).toBe(EVALUATOR_MODEL);
    for (const arm of ['evaluator', 'claim', 'later'] as const) {
      const row = document.evaluators?.wordings.find((wording) => wording.arm === arm);
      expect(row?.wording).toBe(WORDINGS[arm]);
      expect(row?.sha256).toBe(createHash('sha256').update(WORDINGS[arm]).digest('hex'));
    }

    // The evaluator reads exactly what the judge reads; the claim reader and the later reader read only their own text.
    const asked = (system: string): string[] => evaluator.asked.filter((call) => call.system === system).map((call) => call.user).sort();
    expect(asked(WORDINGS.evaluator)).toEqual(document.entries.map((entry) => entry.shown).sort());
    expect(asked(WORDINGS.claim).every((text) => !text.includes('ask'))).toBe(true);
    expect(asked(WORDINGS.later)).toEqual(['thanks, good']);

    const text = h.out.join('');
    expect(text).toMatch(/evaluator\s+2 of 2/);
    expect(text).toMatch(/claim\s+2 of 2/);
    expect(text).toMatch(/confidence\s+2 of 2/);
    expect(text).toMatch(/later\s+1 of 2/);
    expect(text).toContain(EVALUATOR_MODEL);
    expect(text).not.toContain('AUROC');

    h.out.length = 0;
    expect(await run(['sessions', 'gold', 'score', file], h.deps)).toBe(ExitCode.OK);
    expect(h.out.join('')).toMatch(/later\s+1 of 2/);
  });

  it('reads the evaluator per model once judgments exist, and its AUROC follows the judgments', async () => {
    const h = setup();
    const { file, sidecar } = await sampled(h);
    // The evaluator says yes to one prompt and no to the other.
    h.staged.runtime.evaluator = answering((system, text) => (system === WORDINGS.evaluator && text.includes('two ask') ? 'no' : 'yes'));
    expect(await run(['sessions', 'gold', 'arms', file], h.deps)).toBe(ExitCode.OK);
    const entries = sidecarOf(sidecar).entries;
    const idOf = (ask: string): string | undefined => entries.find((entry) => entry.shown.includes(ask))?.id;
    const blank = readFileSync(file, 'utf8');
    const filled = (one: string, two: string): string => {
      let current: string | undefined;
      return blank
        .split('\n')
        .map((text) => {
          current = /^### (G[0-9]+)$/.exec(text)?.[1] ?? current;
          if (text !== 'Judgment: yes|no') return text;
          return `Judgment: ${current === idOf('one ask') ? one : two}`;
        })
        .join('\n');
    };
    const evaluatorRow = async (): Promise<RegExpMatchArray | null> => {
      h.out.length = 0;
      expect(await run(['sessions', 'gold', 'score', file], h.deps)).toBe(ExitCode.OK);
      return h.out.join('').match(/^ +evaluator +([0-9]+) +([0-9]+) +[0-9]+% +([0-9.]+)/m);
    };

    // The judge agrees with the evaluator on both, so it ranks them perfectly.
    writeFileSync(file, filled('yes', 'no'));
    expect((await evaluatorRow())?.slice(1)).toEqual(['2', '1', '1.00']);
    expect(h.out.join('')).toContain('Judged 2 of 2');
    expect(h.out.join('')).toContain('m-a: 2 judged, base rate 50%');

    // The judge disagrees on both, so it ranks them backward.
    writeFileSync(file, filled('no', 'yes'));
    expect((await evaluatorRow())?.slice(1)).toEqual(['2', '1', '0.00']);
  });

  it('resumes: a rerun asks only what is left, and a failed call keeps what was saved and exits nonzero', async () => {
    const h = setup();
    const { file, sidecar } = await sampled(h);
    let calls = 0;
    h.staged.runtime.evaluator = {
      ready: () => Promise.resolve(),
      ask: () => {
        calls += 1;
        return calls === 1 ? Promise.resolve('no') : Promise.reject(new Error('limit reached'));
      },
    };
    expect(await run(['sessions', 'gold', 'arms', file], h.deps)).toBe(ExitCode.UNEXPECTED);
    expect(h.err.join('')).toContain('limit reached');
    expect(h.err.join('')).toContain('Rerun');
    const saved = sidecarOf(sidecar).entries.flatMap((entry) => Object.values(entry.answers ?? {}));
    expect(saved).toEqual(['no']);

    const evaluator = answering(() => 'yes');
    h.staged.runtime.evaluator = evaluator;
    expect(await run(['sessions', 'gold', 'arms', file], h.deps)).toBe(ExitCode.OK);
    expect(evaluator.asked).toHaveLength(4);
    const after = sidecarOf(sidecar).entries.flatMap((entry) => Object.values(entry.answers ?? {}));
    expect(after.filter((answer) => answer === 'no')).toHaveLength(1);
    expect(after).toHaveLength(5);

    evaluator.asked.length = 0;
    expect(await run(['sessions', 'gold', 'arms', file], h.deps)).toBe(ExitCode.OK);
    expect(evaluator.asked).toHaveLength(0);
  });

  it('refuses to mix readings when the recorded wording differs', async () => {
    const h = setup();
    const { file, sidecar } = await sampled(h);
    const evaluator = answering(() => 'yes');
    h.staged.runtime.evaluator = evaluator;
    const document = sidecarOf(sidecar);
    document.evaluators = { model: EVALUATOR_MODEL, wordings: [{ arm: 'evaluator', wording: 'old', sha256: 'old' }] };
    writeFileSync(sidecar, JSON.stringify(document));
    expect(await run(['sessions', 'gold', 'arms', file], h.deps)).toBe(ExitCode.USAGE);
    expect(h.err.join('')).toContain('mix');
    expect(evaluator.asked).toHaveLength(0);
  });

  it('counts a prompt whose transcript changed, and still gives the evaluator what the judge saw', async () => {
    const h = setup();
    const { file, sidecar } = await sampled(h);
    addProject(h.staged, 'gold', 'one', [user('rewritten'), said('gone')]);
    const evaluator = answering(() => 'yes');
    h.staged.runtime.evaluator = evaluator;
    expect(await run(['sessions', 'gold', 'arms', file], h.deps)).toBe(ExitCode.OK);
    expect(h.out.join('')).toContain('1 prompts');
    const first = sidecarOf(sidecar).entries.find((entry) => entry.shown.includes('one ask'));
    expect(first?.reads).toBeUndefined();
    expect(first?.answers).toEqual({ evaluator: 'yes' });
  });

  it('reads the raw archive once the harness has dropped a session: a term only raw holds still excludes, and a clean session is drawn and read', async () => {
    const h = setup();
    addProject(h.staged, 'gold', 'clean', [...hidden('clean'), user('thanks, good')]);
    addProject(h.staged, 'gold', 'named', [...hidden('named'), said('a note about Acme-Term here')]);
    addProject(h.staged, 'gold', 'sub', hidden('sub'));
    const agents = join(h.staged.projectsRoot, 'gold', 'sub', 'subagents');
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, 'agent-1.jsonl'), `${said('from acme-term, in lower case')}\n`);
    expect(await run(['sessions', 'deposit', '--allow', 'gold'], h.deps)).toBe(ExitCode.OK);
    rmSync(join(h.staged.projectsRoot, 'gold'), { recursive: true });
    h.out.length = 0;

    const dir = join(h.staged.root, 'raw-only');
    expect(await run(['sessions', 'gold', 'sample', '--exclude-term', 'ACME-term', '--out-dir', dir, '--seed', 's'], h.deps)).toBe(ExitCode.OK);
    const sampledText = h.out.join('');
    expect(sampledText).toContain('Excluded 2 sessions');
    expect(sampledText).toContain('Passed over 0 prompts');
    const date = new Date(h.deps.now()).toISOString().slice(0, 10);
    const file = join(dir, `outcome-gold-${date}.md`);
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('clean ask');
    expect(text).not.toContain('named ask');
    expect(text).not.toContain('sub ask');

    h.staged.runtime.evaluator = answering(() => 'yes');
    expect(await run(['sessions', 'gold', 'arms', file], h.deps)).toBe(ExitCode.OK);
    const [entry] = sidecarOf(join(dir, `outcome-gold-${date}.arms.json`)).entries;
    expect(entry?.reads).toEqual({ claim: 'clean is done.\nConfidence: medium', confidence: 'Confidence: medium', later: 'thanks, good' });
  });

  it('stops before any call when the evaluator is not ready, and when none is configured', async () => {
    const h = setup();
    const { file } = await sampled(h);
    const evaluator = answering(() => 'yes');
    evaluator.ready = () => Promise.reject(new Error('no subscription login'));
    h.staged.runtime.evaluator = evaluator;
    expect(await run(['sessions', 'gold', 'arms', file], h.deps)).toBe(ExitCode.UNEXPECTED);
    expect(evaluator.asked).toHaveLength(0);
    h.err.length = 0;
    h.staged.runtime.evaluator = undefined;
    expect(await run(['sessions', 'gold', 'arms', file], h.deps)).toBe(ExitCode.UNEXPECTED);
    expect(h.err.join('')).toContain('evaluator');
  });
});

describe('the display caps (t748 Item 1)', () => {
  const editCall = (file: string): TurnCall => ({ name: 'Edit', input: { file_path: file, old_string: 'a', new_string: 'b' }, cwd: '/w', ok: true, result: 'ok' });
  const readCall = (file: string): TurnCall => ({ name: 'Read', input: { file_path: file }, cwd: '/w', ok: true, result: 'ok' });

  it('names how many files past the cap are not shown', () => {
    const calls = Array.from({ length: 14 }, (_, position) => editCall(`/w/f${String(position)}.ts`));
    const shown = renderShown(viewOf([{ index: 0, request: 'ask', calls, replies: [] }], 0, redact));
    expect(shown).toContain('- and 2 more files');
    expect(shown).not.toContain('f13.ts');
    const one = calls.slice(1);
    expect(renderShown(viewOf([{ index: 0, request: 'ask', calls: one, replies: [] }], 0, redact))).toContain('- and 1 more file');
  });

  it('names how many actions past the cap are not shown', () => {
    const calls = Array.from({ length: 15 }, (_, position) => readCall(`/w/f${String(position)}.ts`));
    const view = viewOf([{ index: 0, request: 'ask', calls, replies: [] }], 0, redact);
    expect(view.actions).toHaveLength(13);
    expect(view.actions.at(-1)).toBe('and 3 more');
  });
});
