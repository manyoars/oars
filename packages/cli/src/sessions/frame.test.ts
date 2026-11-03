import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { captureSession } from './extract.js';
import { closedFrame, closedStack, frameIdOf, repoFilesFromIndex, stackOf, utcDay } from './frame.js';
import { LITERAL } from './public-vocabulary.js';
import type { Frame } from './schema.js';

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
    const stack = stackOf({ paths, programs: [], repoFiles: null });
    expect(stack.languages).toEqual(['java', 'python', 'typescript']);
    expect(JSON.stringify(stack)).not.toContain('alice');
  });

  it('breaks a tie for the third language by name, so the mix does not depend on file order', () => {
    const one = stackOf({ paths: ['a.ts', 'b.java', 'c.py', 'd.go'], programs: [], repoFiles: null });
    const two = stackOf({ paths: ['d.go', 'c.py', 'b.java', 'a.ts'], programs: [], repoFiles: null });
    expect(one.languages).toEqual(two.languages);
  });

  it('names frameworks from a touched manifest and from a program, only from the closed list', () => {
    const stack = stackOf({ paths: ['/x/pom.xml', 'web/vite.config.ts', '/x/acme.config.ts'], programs: ['kubectl', 'acme-deploy'], repoFiles: null });
    expect(stack.frameworks).toEqual(['kubernetes', 'maven', 'vite']);
  });

  it('buckets the repository size by file count', () => {
    const size = (repoFiles: number | null): string | null => stackOf({ paths: [], programs: [], repoFiles }).size;
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
});

describe('repoFilesFromIndex', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
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
