import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { callPositions, captureSession } from './extract.js';
import { makeRedactor } from './redact.js';
import type { StepObservation, ToolObservation } from './schema.js';
import { deposit, loadStore } from './store.js';
import { cleanup, NOW, stage } from './test-support.js';

afterEach(cleanup);

const line = (value: object): string => JSON.stringify(value);

interface Call {
  name?: string;
  command?: string;
  input?: object;
  failed?: boolean;
}

const at = (second: number): string => `2026-05-29T04:30:${String(second).padStart(2, '0')}Z`;

/** Each prompt in turn, each call in its own response, answered one second later. */
const transcript = (prompts: ReadonlyArray<readonly Call[]>): string => {
  const lines: string[] = [];
  let id = 0;
  for (const calls of prompts) {
    lines.push(line({ type: 'user', timestamp: at(0), message: { role: 'user', content: 'p' } }));
    for (const call of calls) {
      id += 1;
      const toolUseId = `t${String(id)}`;
      const input = call.input ?? { command: call.command ?? 'ls' };
      lines.push(line({ type: 'assistant', timestamp: at(1), message: { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: call.name ?? 'Bash', input }] } }));
      lines.push(line({ type: 'user', timestamp: at(2), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, is_error: call.failed === true, content: 'r' }] } }));
    }
  }
  return lines.join('\n');
};

const capture = (text: string): ToolObservation[] => captureSession({ text, session: 's', project: 'p', rev: 1, at: 'x', bytes: 1, redact: makeRedactor([]) }).tools;
const stepsOfPrompts = (prompts: ReadonlyArray<readonly Call[]>): StepObservation[] => capture(transcript(prompts)).flatMap((tool) => tool.steps ?? []);
const programs = (command: string): string[] =>
  stepsOfPrompts([[{ command }]]).map((step) => {
    const { identity } = step;
    if (identity === null || !('program' in identity)) return '';
    return identity.sub === null ? identity.program : `${identity.program} ${identity.sub}`;
  });

const edgesOf = (step: StepObservation | undefined, kind: string): Array<[number, number]> => (step?.edges ?? []).filter((edge) => edge.kind === kind).map((edge) => [edge.n, edge.seg]);

describe('one step per shell segment', () => {
  it.each([
    ['&&', 'git add . && git status', ['git add', 'git status']],
    ['||', 'git status || echo no', ['git status', 'echo']],
    [';', 'ls; pwd', ['ls', 'pwd']],
    ['a pipe', 'cat f | grep x | wc -l', ['cat', 'grep', 'wc']],
    ['a subshell', '(cd web && npm test) && pwd', ['cd', 'npm test', 'pwd']],
    ['a nested subshell', '(ls; (pwd))', ['ls', 'pwd']],
    ['a background job', 'ls & pwd', ['ls', 'pwd']],
    ['a new line', 'ls\npwd', ['ls', 'pwd']],
    ['a shell told to run a list', 'bash -c "git status && ls"', ['git status', 'ls']],
    ['a quoted &&', 'echo "a && b"', ['echo']],
    ['a quoted ;', "echo 'a; b'", ['echo']],
    ['a quoted pipe', 'grep "a|b" f', ['grep']],
    ['a quoted paren', 'echo "(a)"', ['echo']],
    ['an escaped ;', 'echo a\\;b', ['echo']],
    ['a command with an assignment first', 'FOO=1 git status && BAR=2 ls', ['git status', 'ls']],
    ['one plain command', 'git status', ['git status']],
  ])('splits at %s', (_name, command, expected) => {
    expect(programs(command)).toEqual(expected);
  });

  it('ties the steps of one call by seg, from 0, under one n', () => {
    const steps = stepsOfPrompts([[{ command: 'ls' }, { command: 'ls && pwd' }]]);
    expect(steps.map((step) => [step.n, step.seg])).toEqual([[0, 0], [1, 0], [1, 1]]);
  });

  it('gives a non-shell call one step', () => {
    const steps = stepsOfPrompts([[{ name: 'Read', input: { file_path: '/a && /b' } }]]);
    expect(steps.map((step) => step.seg)).toEqual([0]);
  });

  it('says a failure only of the segments the call status reports', () => {
    const steps = stepsOfPrompts([[{ command: 'cat f | grep x', failed: true }, { command: 'cat f | grep x' }]]);
    expect(steps.map((step) => step.status)).toEqual(['none', 'error', 'none', 'ok']);
  });

  it('leaves the segments of a failed && chain unsettled, since the result does not say which failed; the failure stays on the call', () => {
    const tools = capture(transcript([[{ command: 'git add . && npm test', failed: true }, { command: 'git add .' }]]));
    expect(tools.map((tool) => tool.status)).toEqual(['error', 'ok']);
    const steps = tools.flatMap((tool) => tool.steps ?? []);
    expect(steps.map((step) => step.status)).toEqual(['none', 'none', 'ok']);
    expect(edgesOf(steps[2], 'after-error')).toEqual([[0, 1]]);
    expect(edgesOf(steps[2], 'retried')).toEqual([]);
  });

  it('keeps a single-segment failure as it was, and a passing chain ok in every segment', () => {
    const steps = stepsOfPrompts([[{ command: 'npm test', failed: true }, { command: 'git add . && npm test' }]]);
    expect(steps.map((step) => step.status)).toEqual(['error', 'ok', 'ok']);
  });

  it('marks a call cost allocated only where its response made several calls', () => {
    const use = (id: string) => ({ type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } });
    const answer = (id: string) => line({ type: 'user', timestamp: at(2), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'r' }] } });
    const reply = (requestId: string, uses: string[]) => line({ type: 'assistant', requestId, timestamp: at(1), message: { id: `m-${requestId}`, role: 'assistant', content: uses.map(use), usage: { input_tokens: 1, output_tokens: 1000 } } });
    const text = [line({ type: 'user', timestamp: at(0), message: { role: 'user', content: 'p' } }), reply('r1', ['a', 'b']), answer('a'), answer('b'), reply('r2', ['c']), answer('c')].join('\n');
    const costs = capture(text).flatMap((tool) => tool.steps ?? []).map((step) => step.cost);
    expect(costs.map((cost) => cost.tokens)).toEqual([500, 500, 1000]);
    expect(costs.map((cost) => cost.allocated)).toEqual([true, true, undefined]);
  });

  it('keeps the last 50 commands of a call', () => {
    const steps = stepsOfPrompts([[{ command: ['git status', ...Array.from({ length: 50 }, () => 'ls')].join(' && ') }]]);
    expect(steps.map((step) => step.seg)).toEqual(Array.from({ length: 50 }, (_, seg) => seg));
    expect(steps.every((step) => step.identity !== null && 'program' in step.identity && step.identity.program === 'ls')).toBe(true);
  });

  it('holds status none on a call with no result in the file', () => {
    const text = line({ type: 'assistant', timestamp: at(1), message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Read', input: {} }] } });
    expect(capture(text)[0]?.steps?.[0]?.status).toBe('none');
  });
});

describe('cost', () => {
  const response = (id: string, output: number | null, blocks: readonly object[]): string =>
    line({ type: 'assistant', timestamp: at(1), requestId: id, message: { role: 'assistant', content: blocks, ...(output === null ? {} : { usage: { output_tokens: output } }) } });
  const use = (id: string, command = 'ls'): object => ({ type: 'tool_use', id, name: 'Bash', input: { command } });

  it('shares a response output among its calls, on each first segment, with the duration', () => {
    const text = [
      response('r1', 100, [use('a', 'ls && pwd'), use('b')]),
      line({ type: 'user', timestamp: at(3), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'r' }] } }),
    ].join('\n');
    const [first, second] = capture(text);
    expect(first?.steps?.map((step) => step.cost)).toEqual([{ tokens: 50, durationMs: 2000, allocated: true }, { tokens: null, durationMs: null }]);
    expect(second?.steps?.[0]?.cost).toEqual({ tokens: 50, durationMs: null, allocated: true });
  });

  it('counts a response once across the lines that repeat its usage', () => {
    const text = [response('r1', 90, [{ type: 'text', text: 'x' }]), response('r1', 90, [use('a')]), response('r1', 90, [use('b')])].join('\n');
    expect(capture(text).map((tool) => tool.steps?.[0]?.cost.tokens)).toEqual([45, 45]);
  });

  it('holds no tokens when a response reports none, and takes a repeated call out of the share', () => {
    expect(capture(response('r1', null, [use('a')]))[0]?.steps?.[0]?.cost.tokens).toBeNull();
    expect(capture(response('r1', 0, [use('a')]))[0]?.steps?.[0]?.cost.tokens).toBeNull();
    const resumed = capture([response('r1', 80, [use('a')]), response('r2', 10, [use('a'), use('b')])].join('\n'));
    expect(resumed.map((tool) => tool.steps?.[0]?.cost.tokens)).toEqual([80, 10]);
  });

  it('reads a usage line with no response id as its own response', () => {
    const noId = (id: string): string => line({ type: 'assistant', timestamp: at(1), message: { role: 'assistant', content: [use(id)], usage: { output_tokens: 7 } } });
    expect(capture([noId('a'), noId('b')].join('\n')).map((tool) => tool.steps?.[0]?.cost.tokens)).toEqual([7, 7]);
  });
});

describe('edges', () => {
  it('links next through segments and calls within a prompt, and not across prompts', () => {
    const steps = stepsOfPrompts([[{ command: 'ls && pwd' }, { name: 'Read', input: { file_path: '/f' } }], [{ command: 'ls' }]]);
    expect(steps.map((step) => edgesOf(step, 'next'))).toEqual([[], [[0, 0]], [[0, 1]], []]);
  });

  it('keeps a sidechain call out of the main line', () => {
    const call = (id: string, side: boolean): string => line({ type: 'assistant', isSidechain: side, timestamp: at(1), message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } }] } });
    const tools = capture([call('a', false), call('b', true), call('c', false)].join('\n'));
    expect(tools.map((tool) => edgesOf(tool.steps?.[0], 'next'))).toEqual([[], [], [[0, 0]]]);
  });

  it('marks the first step after a failed call', () => {
    const steps = stepsOfPrompts([[{ command: 'ls', failed: true }, { command: 'pwd && echo x' }, { command: 'date' }]]);
    expect(steps.map((step) => edgesOf(step, 'after-error'))).toEqual([[], [[0, 0]], [], []]);
  });

  it('marks a retry of the same command after a failure, up to its first clean run', () => {
    const steps = stepsOfPrompts([[{ command: 'npm test', failed: true }, { command: 'ls' }, { command: 'npm test', failed: true }, { command: 'npm test' }, { command: 'npm test' }]]);
    expect(steps.map((step) => edgesOf(step, 'retried'))).toEqual([[], [], [[0, 0]], [[2, 0]], []]);
  });

  it('tells two private commands apart though both read as the literal, and stores neither', () => {
    const steps = stepsOfPrompts([[{ command: 'acme-one go', failed: true }, { command: 'acme-two go' }, { command: 'acme-one go' }]]);
    expect(steps.map((step) => edgesOf(step, 'retried'))).toEqual([[], [], [[0, 0]]]);
    expect(JSON.stringify(steps)).not.toContain('acme');
  });

  it('does not read a command repeated inside one call as its retry', () => {
    const steps = stepsOfPrompts([[{ command: 'ls && ls', failed: true }]]);
    expect(steps.map((step) => edgesOf(step, 'retried'))).toEqual([[], []]);
  });

  it('marks a retry of the same file and of the same address', () => {
    const read = (file_path: string, failed = false): Call => ({ name: 'Read', input: { file_path }, failed });
    expect(stepsOfPrompts([[read('/a', true), read('/b'), read('/a')]]).map((step) => edgesOf(step, 'retried'))).toEqual([[], [], [[0, 0]]]);
    const fetch = (url: string, failed = false): Call => ({ name: 'WebFetch', input: { url }, failed });
    expect(stepsOfPrompts([[fetch('https://a.example/x', true), fetch('https://a.example/y'), fetch('https://a.example/x')]]).map((step) => edgesOf(step, 'retried'))).toEqual([[], [], [[0, 0]]]);
  });

  it('starts every prompt with no retry memory', () => {
    const steps = stepsOfPrompts([[{ command: 'ls', failed: true }], [{ command: 'ls' }]]);
    expect(steps.map((step) => edgesOf(step, 'retried'))).toEqual([[], []]);
    expect(edgesOf(steps[1], 'after-error')).toEqual([]);
  });

  it('holds no parent and no spawn edge on a main transcript', () => {
    const [step] = stepsOfPrompts([[{ command: 'ls' }]]);
    expect(step?.parent).toBeNull();
    expect(edgesOf(step, 'spawned')).toEqual([]);
  });
});

describe('a subagent joins the graph of the call that spawned it', () => {
  const main = transcript([[{ command: 'ls' }, { name: 'Agent', input: { prompt: 'x' } }, { command: 'pwd' }]]);
  const agentLines = transcript([[{ command: 'ls && pwd' }, { name: 'Read', input: { file_path: '/f' } }]]);
  const options = { allow: ['proj'], redactDomains: [], now: () => NOW };

  const stageSubagent = (toolUseId: string | null): { staged: ReturnType<typeof stage>; folder: string } => {
    const staged = stage();
    const folder = join(staged.projectsRoot, 'proj');
    writeFileSync(join(folder, 'mainone.jsonl'), `${main}\n`);
    mkdirSync(join(folder, 'mainone', 'subagents'), { recursive: true });
    writeFileSync(join(folder, 'mainone', 'subagents', 'agent-x.jsonl'), `${agentLines}\n`);
    writeFileSync(join(folder, 'mainone', 'subagents', 'agent-x.meta.json'), JSON.stringify({ agentType: 'Explore', toolUseId }));
    return { staged, folder };
  };

  const agentSteps = async (storeDir: string): Promise<StepObservation[]> => (await loadStore(storeDir)).tools.filter((tool) => tool.agentType === 'Explore').flatMap((tool) => tool.steps ?? []);

  it('gives every subagent step the spawning call as parent, and its first step the spawned edge', async () => {
    const { staged } = stageSubagent('t2');
    await deposit(staged.runtime, options);
    const steps = await agentSteps(staged.storeDir);
    expect(steps.map((step) => step.parent)).toEqual([1, 1, 1]);
    expect(steps.map((step) => edgesOf(step, 'spawned'))).toEqual([[[1, 0]], [], []]);
    expect(steps.map((step) => edgesOf(step, 'next'))).toEqual([[], [[0, 0]], [[0, 1]]]);
  });

  it('agrees with the n capture gives the same call', () => {
    const positions = callPositions(main);
    for (const tool of capture(main)) expect(positions.get(tool.toolUseId ?? '')).toBe(tool.n);
  });

  it('skips a broken line or a line without a call, and takes the first copy of a repeated id', () => {
    const use = (id?: string): object => ({ type: 'tool_use', ...(id === undefined ? {} : { id }), name: 'Bash', input: {} });
    const text = ['not json', '[1]', line({ type: 'user' }), line({ message: { content: 'x' } }), line({ message: { content: ['x', use('a'), use(), use('a'), use('b')] } })].join('\n');
    expect([...callPositions(text)]).toEqual([['a', 0], ['b', 2]]);
    expect(capture(text).map((tool) => tool.toolUseId)).toEqual(['a', null, 'b']);
  });

  it('numbers calls as capture does, past a request-body copy and a replayed call', () => {
    const use = (id: string): object => ({ type: 'tool_use', id, name: 'Bash', input: {} });
    const text = [
      line({ type: 'assistant', message: { role: 'assistant', content: [use('a')] } }),
      line({ type: 'api-request-blob', message: { role: 'assistant', content: [use('copied'), use('a')] } }),
      line({ type: 'assistant', message: { role: 'assistant', content: [use('a')] } }),
      line({ type: 'assistant', message: { role: 'assistant', content: [use('b')] } }),
    ].join('\n');
    const positions = callPositions(text);
    expect(positions.has('copied')).toBe(false);
    for (const tool of capture(text)) expect(positions.get(tool.toolUseId ?? '')).toBe(tool.n);
  });

  it('reads the parent from the archive when the harness no longer has it', async () => {
    const { staged, folder } = stageSubagent('t3');
    await deposit(staged.runtime, options);
    rmSync(join(folder, 'mainone.jsonl'));
    writeFileSync(join(folder, 'mainone', 'subagents', 'agent-x.jsonl'), `${agentLines}\n${agentLines}\n`);
    await deposit(staged.runtime, options);
    const steps = await agentSteps(staged.storeDir);
    expect(steps[0]?.parent).toBe(2);
  });

  it('holds no parent when the spawning call is not known', async () => {
    for (const toolUseId of [null, 'no-such-call']) {
      const { staged } = stageSubagent(toolUseId);
      await deposit(staged.runtime, options);
      const steps = await agentSteps(staged.storeDir);
      expect(steps.map((step) => step.parent)).toEqual([null, null, null]);
      expect(steps.flatMap((step) => edgesOf(step, 'spawned'))).toEqual([]);
    }
  });

  it('holds no parent when neither the harness nor the archive has the parent', async () => {
    const staged = stage();
    const dir = join(staged.projectsRoot, 'proj', 'gone', 'subagents');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'agent-y.jsonl'), `${agentLines}\n`);
    writeFileSync(join(dir, 'agent-y.meta.json'), JSON.stringify({ agentType: 'Explore', toolUseId: 't1' }));
    await deposit(staged.runtime, options);
    expect((await agentSteps(staged.storeDir)).map((step) => step.parent)).toEqual([null, null, null]);
  });

  describe('spawned by another subagent', () => {
    // Call ids unique to each file, so finding a call says which transcript was read.
    const calling = (...ids: readonly string[]): string =>
      [
        line({ type: 'user', timestamp: at(0), message: { role: 'user', content: 'p' } }),
        ...ids.map((id) => line({ type: 'assistant', timestamp: at(1), message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } }] } })),
      ].join('\n');
    const place = (dir: string, agent: string, text: string, toolUseId: string): void => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${agent}.jsonl`), `${text}\n`);
      writeFileSync(join(dir, `${agent}.meta.json`), JSON.stringify({ agentType: 'Explore', toolUseId }));
    };
    const stageNested = (): { staged: ReturnType<typeof stage>; dir: string } => {
      const { staged, folder } = stageSubagent('t2');
      const dir = join(folder, 'mainone', 'subagents');
      place(dir, 'agent-x', calling('x1', 'x2'), 't2');
      return { staged, dir };
    };
    const ofAgent = async (storeDir: string, session: string): Promise<{ parents: Array<number | null>; spawned: Array<[number, number]>; spawnedIn: string | null | undefined }> => {
      const store = await loadStore(storeDir);
      const steps = store.tools.filter((tool) => tool.session === session).flatMap((tool) => tool.steps ?? []);
      return { parents: steps.map((step) => step.parent), spawned: steps.flatMap((step) => edgesOf(step, 'spawned')), spawnedIn: store.subagents.find((agent) => agent.session === session)?.spawnedIn };
    };

    it('finds the call in a sibling transcript and names that transcript', async () => {
      const { staged, dir } = stageNested();
      place(dir, 'agent-y', calling('y1', 'y2'), 'x2');
      await deposit(staged.runtime, options);
      expect(await ofAgent(staged.storeDir, 'mainone~agent-y')).toEqual({ parents: [1, 1], spawned: [[1, 0]], spawnedIn: 'mainone~agent-x' });
      expect(await ofAgent(staged.storeDir, 'mainone~agent-x')).toEqual({ parents: [1, 1], spawned: [[1, 0]], spawnedIn: 'mainone' });
    });

    it('finds the call across a workflow folder, both ways', async () => {
      const { staged, dir } = stageNested();
      place(join(dir, 'workflows', 'wf_1'), 'agent-w', calling('w1'), 'x2');
      place(dir, 'agent-v', calling('v1'), 'w1');
      await deposit(staged.runtime, options);
      expect(await ofAgent(staged.storeDir, 'mainone~wf_1~agent-w')).toMatchObject({ parents: [1], spawnedIn: 'mainone~agent-x' });
      expect(await ofAgent(staged.storeDir, 'mainone~agent-v')).toMatchObject({ parents: [0], spawnedIn: 'mainone~wf_1~agent-w' });
    });

    it('takes the main transcript first when a sibling repeats the call', async () => {
      const { staged, dir } = stageNested();
      place(dir, 'agent-a', calling('t3'), 't2');
      place(dir, 'agent-y', calling('y1'), 't3');
      await deposit(staged.runtime, options);
      expect(await ofAgent(staged.storeDir, 'mainone~agent-y')).toMatchObject({ parents: [2], spawnedIn: 'mainone' });
    });

    it('does not read a transcript as its own spawner', async () => {
      const { staged, dir } = stageNested();
      place(dir, 'agent-y', calling('y1'), 'y1');
      await deposit(staged.runtime, options);
      expect(await ofAgent(staged.storeDir, 'mainone~agent-y')).toEqual({ parents: [null], spawned: [], spawnedIn: null });
    });

    it('holds no spawning transcript when no transcript has the call', async () => {
      const { staged, dir } = stageNested();
      place(dir, 'agent-y', calling('y1'), 'no-such-call');
      await deposit(staged.runtime, options);
      expect(await ofAgent(staged.storeDir, 'mainone~agent-y')).toEqual({ parents: [null], spawned: [], spawnedIn: null });
    });

    it('reads a sibling from the archive when the harness no longer has it, and when the parent is gone too', async () => {
      const { staged, dir } = stageNested();
      place(dir, 'agent-y', calling('y1'), 'x2');
      await deposit(staged.runtime, options);
      rmSync(join(dir, 'agent-x.jsonl'));
      rmSync(join(dir, '..', '..', 'mainone.jsonl'));
      writeFileSync(join(dir, 'agent-y.jsonl'), `${calling('y1', 'y2')}\n`);
      await deposit(staged.runtime, options);
      expect(await ofAgent(staged.storeDir, 'mainone~agent-y')).toEqual({ parents: [1, 1], spawned: [[1, 0]], spawnedIn: 'mainone~agent-x' });
    });

    it('agrees when the whole transcript is captured again from the archive', async () => {
      const { staged, dir } = stageNested();
      place(dir, 'agent-y', calling('y1'), 'x2');
      await deposit(staged.runtime, options);
      rmSync(join(staged.projectsRoot, 'proj', 'mainone'), { recursive: true });
      rmSync(join(staged.projectsRoot, 'proj', 'mainone.jsonl'));
      rmSync(join(staged.storeDir, 'state.json'));
      await deposit(staged.runtime, { ...options, now: () => NOW + 1 });
      expect(await ofAgent(staged.storeDir, 'mainone~agent-y')).toEqual({ parents: [1], spawned: [[1, 0]], spawnedIn: 'mainone~agent-x' });
    });

    it('holds no spawning transcript on a main transcript', async () => {
      const { staged } = stageNested();
      await deposit(staged.runtime, options);
      expect((await loadStore(staged.storeDir)).sessions.find((one) => one.session === 'mainone')?.spawnedIn).toBeNull();
    });
  });

  it('reads one parent once for its subagents', async () => {
    const { staged, folder } = stageSubagent('t2');
    writeFileSync(join(folder, 'mainone', 'subagents', 'agent-z.jsonl'), `${agentLines}\n`);
    writeFileSync(join(folder, 'mainone', 'subagents', 'agent-z.meta.json'), JSON.stringify({ agentType: 'Explore', toolUseId: 't3' }));
    await deposit(staged.runtime, options);
    const steps = await agentSteps(staged.storeDir);
    expect(new Set(steps.map((step) => step.parent))).toEqual(new Set([1, 2]));
  });
});
