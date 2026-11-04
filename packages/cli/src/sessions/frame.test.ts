import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { captureSession } from './extract.js';
import { closedFrame, closedStack, frameIdOf, repoFilesFromIndex, repoSizeOf, stackOf, utcDay } from './frame.js';
import { LITERAL } from './public-vocabulary.js';
import type { Frame } from './schema.js';
import { deposit, loadStore } from './store.js';
import { addProject, cleanup, folders, NOW, stage } from './test-support.js';

const base: Frame = {
  harness: 'claude-code',
  harnessVersion: '2.1.300',
  model: 'claude-opus-5-5',
  effort: 'high',
  day: '2026-11-03',
  platform: 'win32',
  shell: 'bash',
  stack: { languages: ['typescript'], frameworks: ['vite'], size: 'm' },
};

describe('frameIdOf', () => {
  it('is 16 hex characters and the same for the same fields in any key order', () => {
    const reordered: Frame = { stack: { size: 'm', frameworks: ['vite'], languages: ['typescript'] }, shell: 'bash', platform: 'win32', day: '2026-11-03', effort: 'high', model: 'claude-opus-5-5', harnessVersion: '2.1.300', harness: 'claude-code' };
    expect(frameIdOf(base)).toMatch(/^[0-9a-f]{16}$/);
    expect(frameIdOf(reordered)).toBe(frameIdOf(base));
  });

  it('changes with every field, so a frame is one exact coordinate', () => {
    const variants: Frame[] = [
      { ...base, harness: 'cursor' },
      { ...base, harnessVersion: '2.1.301' },
      { ...base, model: 'claude-sonnet-5-5' },
      { ...base, effort: 'low' },
      { ...base, day: '2026-11-04' },
      { ...base, platform: 'linux' },
      { ...base, shell: 'powershell' },
      { ...base, stack: { ...base.stack, languages: ['java'] } },
      { ...base, stack: { ...base.stack, frameworks: [] } },
      { ...base, stack: { ...base.stack, size: 'xl' } },
    ];
    expect(new Set([frameIdOf(base), ...variants.map(frameIdOf)]).size).toBe(variants.length + 1);
  });
});

describe('utcDay', () => {
  it('reads the day in UTC, not in the offset the timestamp was written in', () => {
    expect(utcDay('2026-05-28T23:30:00-05:00')).toBe('2026-05-29');
    expect(utcDay('2026-05-29T00:30:00+05:00')).toBe('2026-05-28');
    expect(utcDay('2026-05-28T20:26:59.000Z')).toBe('2026-05-28');
  });

  it('is null with no usable timestamp', () => {
    expect(utcDay(null)).toBeNull();
    expect(utcDay(undefined)).toBeNull();
    expect(utcDay('')).toBeNull();
    expect(utcDay('not a date')).toBeNull();
  });
});

describe('closedStack', () => {
  it('drops a value outside the vocabulary and sorts what stays', () => {
    expect(closedStack({ languages: ['typescript', 'acme-lang', 'java'], frameworks: ['vite', 'acme-framework'], size: 'huge' })).toEqual({ languages: ['java', 'typescript'], frameworks: ['vite'], size: null });
  });

  it('keeps a size in the vocabulary', () => {
    expect(closedStack({ languages: [], frameworks: [], size: 'xl' }).size).toBe('xl');
  });
});

describe('stackOf', () => {
  it('reads the language mix from touched files, the top three by count, and never a path', () => {
    const paths = ['/home/alice/secret-project/a.ts', 'b.ts', 'c.ts', 'd.tsx', 'e.java', 'f.java', 'g.py', 'i.unknownext', 'Makefile'];
    const stack = stackOf({ paths, programs: [], size: null });
    expect(stack.languages).toEqual(['java', 'python', 'typescript']);
    expect(JSON.stringify(stack)).not.toContain('alice');
  });

  it('breaks a tie for the third language by name, so the mix does not depend on file order', () => {
    const one = stackOf({ paths: ['a.ts', 'b.java', 'c.py', 'd.go'], programs: [], size: null });
    const two = stackOf({ paths: ['d.go', 'c.py', 'b.java', 'a.ts'], programs: [], size: null });
    expect(one.languages).toEqual(two.languages);
  });

  it('names frameworks from a touched manifest and from a program, only from the closed list', () => {
    const stack = stackOf({ paths: ['/x/pom.xml', 'web/vite.config.ts', '/x/acme.config.ts'], programs: ['kubectl', 'acme-deploy'], size: null });
    expect(stack.frameworks).toEqual(['kubernetes', 'maven', 'vite']);
  });

  it('buckets the repository size by file count', () => {
    const size = repoSizeOf;
    expect([null, 0, 99, 100, 999, 1000, 9999, 10000, 99999, 100000].map(size)).toEqual([null, 'xs', 'xs', 's', 's', 'm', 'm', 'l', 'l', 'xl']);
  });
});

describe('closedFrame', () => {
  it('leaves public names alone', () => {
    expect(closedFrame(base)).toEqual(base);
  });

  it('turns a private model name, a free-form version, and an unknown effort into the literal', () => {
    const frame = closedFrame({ ...base, model: 'acme-internal-llm', harnessVersion: 'C:/Users/alice/build', effort: 'acme' });
    expect(frame).toMatchObject({ model: LITERAL, harnessVersion: LITERAL, effort: LITERAL });
  });

  it('keeps null as null', () => {
    expect(closedFrame({ ...base, model: null, harnessVersion: null, effort: null })).toMatchObject({ model: null, harnessVersion: null, effort: null });
  });

  it.each(['2.1.0', '2.1.0-beta.1', '1.2.3-rc1', '3.0.0-canary.20261103', '1.2.3+4'])('keeps %s, a published version shape', (harnessVersion) => {
    expect(closedFrame({ ...base, harnessVersion }).harnessVersion).toBe(harnessVersion);
  });

  it.each(['2.1.0-acmecorp', '2.1.0+acmecorp', '2.1.0.acmecorp', '2.1.0-beta.acmecorp', '2.1.0-rcacme'])('masks %s, a version holding a private word', (harnessVersion) => {
    expect(closedFrame({ ...base, harnessVersion }).harnessVersion).toBe(LITERAL);
  });

  it.each(['claude-opus-5-5', 'claude-fable-5-1', 'claude-haiku-4-5-20251001', 'claude-3-5-sonnet-20241022', 'claude-3-opus-20240229', 'gpt-5.1-codex-max', 'gpt-4o-mini', 'o3-mini', 'gemini-2.5-pro', 'grok-code-fast-1', 'deepseek-r1', 'composer-1', 'cursor-small', 'default', 'auto'])('keeps %s, a published model shape', (model) => {
    expect(closedFrame({ ...base, model }).model).toBe(model);
  });

  it.each(['claude-acme-proxy', 'claude-opus-acme', 'claude-opus-5-acme-tuned', 'claude-3-acme', 'claude', 'gpt-4o-acme', 'ft:gpt-4o:acme::abc', 'gemini-corp-tuned', 'o3-acme', 'composer-acme'])('masks %s, a known family holding a private name', (model) => {
    expect(closedFrame({ ...base, model }).model).toBe(LITERAL);
  });
});

describe('repoFilesFromIndex', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  const repo = (index: Buffer | undefined): string => {
    const root = mkdtempSync(join(tmpdir(), 'oars-frame-'));
    dirs.push(root);
    if (index !== undefined) {
      mkdirSync(join(root, '.git'));
      writeFileSync(join(root, '.git', 'index'), index);
    }
    return root;
  };
  const header = (signature: string, entries: number): Buffer => {
    const buffer = Buffer.alloc(12);
    buffer.write(signature, 0, 'latin1');
    buffer.writeUInt32BE(2, 4);
    buffer.writeUInt32BE(entries, 8);
    return buffer;
  };

  it('reads the entry count from the index header without running git', () => {
    expect(repoFilesFromIndex(repo(header('DIRC', 4321)))).toBe(4321);
  });

  it('follows a linked worktree or submodule from its .git file to its index, absolute or relative', () => {
    const gitDir = repo(header('DIRC', 77));
    const absolute = repo(undefined);
    writeFileSync(join(absolute, '.git'), `gitdir: ${join(gitDir, '.git')}\n`);
    expect(repoFilesFromIndex(absolute)).toBe(77);
    mkdirSync(join(gitDir, 'nested'));
    writeFileSync(join(gitDir, 'nested', '.git'), 'gitdir: ../.git\n');
    expect(repoFilesFromIndex(join(gitDir, 'nested'))).toBe(77);
  });

  it('is null when a .git file points nowhere or says nothing', () => {
    const pointsNowhere = repo(undefined);
    writeFileSync(join(pointsNowhere, '.git'), 'gitdir: ./missing\n');
    expect(repoFilesFromIndex(pointsNowhere)).toBeNull();
    const saysNothing = repo(undefined);
    writeFileSync(join(saysNothing, '.git'), 'not a pointer\n');
    expect(repoFilesFromIndex(saysNothing)).toBeNull();
  });

  it('is null with no index, a short one, or the wrong signature', () => {
    expect(repoFilesFromIndex(repo(undefined))).toBeNull();
    expect(repoFilesFromIndex(repo(Buffer.from('DI')))).toBeNull();
    expect(repoFilesFromIndex(repo(header('NOPE', 4)))).toBeNull();
  });
});

const line = (value: object): string => JSON.stringify(value);
const present = (frame: Frame | undefined): Frame => {
  if (frame === undefined) throw new Error('expected a frame');
  return frame;
};
const redact = (text: string): string => text;

describe('the frame on captured records', () => {
  const text = [
    line({ type: 'user', timestamp: '2026-05-28T23:30:00-05:00', version: '2.1.300', cwd: '/w', message: { role: 'user', content: 'first prompt' } }),
    line({ type: 'assistant', timestamp: '2026-05-29T04:30:01Z', version: '2.1.300', requestedModel: 'claude-opus-5-5', effort: 'high', message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'src/a.ts' } }] } }),
    line({ type: 'user', timestamp: '2026-05-30T01:00:00Z', version: '2.1.301', message: { role: 'user', content: 'second prompt' } }),
    line({ type: 'assistant', timestamp: '2026-05-30T01:00:01Z', version: '2.1.301', requestedModel: 'claude-sonnet-5-5', effort: 'low', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'PowerShell', input: { command: 'git status' } }] } }),
  ].join('\n');
  const capture = captureSession({ text, session: 's', project: 'p', rev: 1, at: '2026-05-31T00:00:00Z', bytes: text.length, redact, runtime: { oars: '1', node: 'v', os: 'linux' } });

  it('puts one frame on each prompt, with its own day, model, effort, and version', () => {
    expect(capture.prompts.map((prompt) => prompt.frame)).toEqual([
      { harness: 'claude-code', harnessVersion: '2.1.300', model: 'claude-opus-5-5', effort: 'high', day: '2026-05-29', platform: 'linux', shell: 'powershell', stack: { languages: ['typescript'], frameworks: [], size: null } },
      { harness: 'claude-code', harnessVersion: '2.1.301', model: 'claude-sonnet-5-5', effort: 'low', day: '2026-05-30', platform: 'linux', shell: 'powershell', stack: { languages: ['typescript'], frameworks: [], size: null } },
    ]);
    expect(capture.prompts[0]?.frameId).toBe(frameIdOf(present(capture.prompts[0]?.frame)));
    expect(capture.prompts[0]?.frameId).not.toBe(capture.prompts[1]?.frameId);
  });

  it('names the harness the capture was told about', () => {
    const cursor = captureSession({ text, session: 's', project: 'p', rev: 1, at: 'x', bytes: 1, redact, harness: 'cursor', runtime: { oars: '1', node: 'v', os: 'linux' } });
    expect(cursor.prompts[0]?.frame?.harness).toBe('cursor');
  });

  it('gives the session a frame too, for a call before any prompt', () => {
    const headless = line({ type: 'assistant', timestamp: '2026-05-29T04:30:01Z', version: '2.1.300', requestedModel: 'claude-opus-5-5', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.py' } }] } });
    const result = captureSession({ text: headless, session: 's', project: 'p', rev: 1, at: 'x', bytes: 1, redact, runtime: { oars: '1', node: 'v', os: 'linux' } });
    expect(result.prompts).toEqual([]);
    expect(result.session.frame).toMatchObject({ model: 'claude-opus-5-5', day: '2026-05-29', stack: { languages: ['python'] } });
    expect(result.session.frameId).toBe(frameIdOf(present(result.session.frame)));
  });

  it('falls back to the message model when a line names no requested model', () => {
    const old = [
      line({ type: 'user', timestamp: '2026-05-29T04:30:00Z', message: { role: 'user', content: 'p' } }),
      line({ type: 'assistant', timestamp: '2026-05-29T04:30:01Z', message: { role: 'assistant', model: 'claude-opus-4-5', content: [] } }),
      line({ type: 'assistant', timestamp: '2026-05-29T04:30:02Z', message: { role: 'assistant', model: '<synthetic>', content: [] } }),
    ].join('\n');
    const result = captureSession({ text: old, session: 's', project: 'p', rev: 1, at: 'x', bytes: 1, redact });
    expect(result.prompts[0]?.frame?.model).toBe('claude-opus-4-5');
  });

  it('gives a grown transcript the shell and stack of the whole file, so an earlier prompt can change frame at the new rev', () => {
    const prompt = (second: number): string => line({ type: 'user', timestamp: `2026-05-29T04:30:0${String(second)}Z`, message: { role: 'user', content: 'p' } });
    const call = (id: string, name: string, input: object): string => line({ type: 'assistant', timestamp: '2026-05-29T04:30:05Z', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
    const start = [prompt(0), call('a', 'Bash', { command: 'ls' })];
    const grown = [...start, prompt(6), call('b', 'PowerShell', { command: 'ls' }), call('c', 'PowerShell', { command: 'ls' }), call('d', 'Read', { file_path: '/w/a.py' })];
    const first = captureSession({ text: start.join('\n'), session: 's', project: 'p', rev: 1, at: 'x', bytes: 1, redact });
    const again = captureSession({ text: grown.join('\n'), session: 's', project: 'p', rev: 2, at: 'x', bytes: 1, redact });
    expect(first.prompts[0]?.frame).toMatchObject({ shell: 'bash', stack: { languages: [] } });
    expect(again.prompts[0]?.frame).toMatchObject({ shell: 'powershell', stack: { languages: ['python'] } });
    expect(again.prompts[0]?.frameId).not.toBe(first.prompts[0]?.frameId);
    expect(again.tools[0]?.steps?.[0]?.frameId).toBe(again.prompts[0]?.frameId);
  });

  it('reads the repository size only through the probe, and only for a known repository', () => {
    const seen: string[] = [];
    const probe = (root: string): number => {
      seen.push(root);
      return 5000;
    };
    const known = captureSession({ text, session: 's', project: 'p', rev: 1, at: 'x', bytes: 1, redact, repoRoot: () => '/w', repoFiles: probe });
    expect(known.prompts[0]?.frame?.stack.size).toBe('m');
    expect(seen).toEqual(['/w']);
    seen.length = 0;
    expect(captureSession({ text, session: 's', project: 'p', rev: 1, at: 'x', bytes: 1, redact, repoFiles: probe }).prompts[0]?.frame?.stack.size).toBeNull();
    expect(seen).toEqual([]);
  });
});

describe('the frame when a transcript is captured again', () => {
  afterEach(cleanup);
  const options = { allow: ['proj'], redactDomains: [], now: () => NOW };
  const indexHolding = (entries: number): Buffer => {
    const buffer = Buffer.alloc(12);
    buffer.write('DIRC', 0, 'latin1');
    buffer.writeUInt32BE(2, 4);
    buffer.writeUInt32BE(entries, 8);
    return buffer;
  };
  const lines = (cwd: string): string[] => [
    line({ type: 'user', timestamp: '2026-05-29T04:30:00Z', cwd, message: { role: 'user', content: 'p' } }),
    line({ type: 'assistant', timestamp: '2026-05-29T04:30:01Z', cwd, message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } }),
  ];
  const stageRepo = (): { staged: ReturnType<typeof stage>; repo: string; touch: () => void } => {
    const staged = stage();
    const { repo } = folders(staged.root);
    writeFileSync(join(repo, '.git', 'index'), indexHolding(50));
    const file = addProject(staged, 'proj', 'framed', lines(repo));
    return { staged, repo, touch: () => { utimesSync(file, new Date(NOW), new Date(NOW + 1000)); } };
  };
  const framesOf = async (storeDir: string, session = 'framed'): Promise<{ size: string | null | undefined; ids: Array<string | undefined>; rev: number | undefined }> => {
    const store = await loadStore(storeDir);
    const record = store.sessions.find((one) => one.session === session);
    const steps = store.tools.filter((tool) => tool.session === session).flatMap((tool) => tool.steps ?? []);
    return { size: record?.frame?.stack.size, ids: [record?.frameId, ...steps.map((step) => step.frameId)], rev: record?.rev };
  };

  it('keeps every frame id after the repository crosses a size bucket', async () => {
    const { staged, repo, touch } = stageRepo();
    await deposit(staged.runtime, options);
    const first = await framesOf(staged.storeDir);
    expect(first.size).toBe('xs');
    writeFileSync(join(repo, '.git', 'index'), indexHolding(50000));
    touch();
    await deposit(staged.runtime, options);
    const again = await framesOf(staged.storeDir);
    expect(again.rev).toBeGreaterThan(first.rev ?? 0);
    expect(again.ids).toEqual(first.ids);
    expect(again.size).toBe('xs');
  });

  it('keeps every frame id after the repository is gone', async () => {
    const { staged, repo, touch } = stageRepo();
    await deposit(staged.runtime, options);
    const first = await framesOf(staged.storeDir);
    rmSync(repo, { recursive: true, force: true });
    touch();
    await deposit(staged.runtime, options);
    expect((await framesOf(staged.storeDir)).ids).toEqual(first.ids);
  });

  it('holds a null size once logged, rather than reading the repository later', async () => {
    const { staged, repo, touch } = stageRepo();
    rmSync(join(repo, '.git', 'index'));
    await deposit(staged.runtime, options);
    const first = await framesOf(staged.storeDir);
    expect(first.size).toBeNull();
    writeFileSync(join(repo, '.git', 'index'), indexHolding(50));
    touch();
    await deposit(staged.runtime, options);
    expect((await framesOf(staged.storeDir)).ids).toEqual(first.ids);
  });

  it('reads the earlier frame from the log when the state file was lost', async () => {
    const { staged, repo } = stageRepo();
    await deposit(staged.runtime, options);
    const first = await framesOf(staged.storeDir);
    writeFileSync(join(repo, '.git', 'index'), indexHolding(50000));
    rmSync(join(staged.storeDir, 'state.json'));
    await deposit(staged.runtime, { ...options, now: () => NOW + 1 });
    const again = await framesOf(staged.storeDir);
    expect(again.rev).toBeGreaterThan(first.rev ?? 0);
    expect(again.ids).toEqual(first.ids);
  });

  it('reads the repository for a transcript with no earlier capture', async () => {
    const { staged, repo } = stageRepo();
    await deposit(staged.runtime, options);
    writeFileSync(join(repo, '.git', 'index'), indexHolding(50000));
    addProject(staged, 'proj', 'later', lines(repo));
    await deposit(staged.runtime, options);
    expect((await framesOf(staged.storeDir, 'later')).size).toBe('l');
  });
});
