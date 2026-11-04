// `readSkeletons(..., lean)` and the verify that uses it (t808): verify holds every skeleton at once and no check reads a line's content hashes.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Store from './store.js';
import { cleanup, NOW, stage } from './test-support.js';

/** Whether each `readSkeletons` call verify made asked for the lean read, and a switch that makes it ask for the full one. */
const asked: Array<boolean | undefined> = [];
const forced = { full: false };

vi.mock('./store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Store>();
  return {
    ...actual,
    readSkeletons: (storeDir: string, only?: string, lean?: boolean) => {
      asked.push(lean);
      return actual.readSkeletons(storeDir, only, forced.full ? false : lean);
    },
  };
});

const { sessionsVerify } = await import('./command.js');
const { deposit, readSkeletons } = await import('./store.js');

afterEach(() => {
  cleanup();
  asked.length = 0;
  forced.full = false;
});
const options = { allow: ['proj'], redactDomains: [], now: () => NOW };

describe('readSkeletons, lean', () => {
  it('empties every line\'s hashes and changes no other field; the default read keeps them', async () => {
    const staged = stage();
    await deposit(staged.runtime, options);
    const full = await readSkeletons(staged.storeDir);
    const lean = await readSkeletons(staged.storeDir, undefined, true);
    expect(full.skeletons.flatMap((skeleton) => skeleton.lines).some((line) => line.hashes.length > 0)).toBe(true);
    expect(lean.unreadable).toBe(full.unreadable);
    expect(lean.skeletons).toHaveLength(full.skeletons.length);
    for (const [at, skeleton] of full.skeletons.entries()) {
      const leaned = lean.skeletons[at];
      expect(leaned).toBeDefined();
      expect({ ...leaned, lines: undefined }).toEqual({ ...skeleton, lines: undefined });
      expect(leaned?.lines.every((line) => line.hashes.length === 0)).toBe(true);
      expect(leaned?.lines.map((line) => ({ ...line, hashes: [] }))).toEqual(skeleton.lines.map((line) => ({ ...line, hashes: [] })));
    }
  });
});

describe('sessionsVerify reads lean', () => {
  it('asks for the lean read of every skeleton, and its report equals the one a full read gives', async () => {
    const staged = stage();
    await deposit(staged.runtime, options);
    const deps = { sessions: staged.runtime, install: undefined, now: () => NOW };
    const lean = await sessionsVerify(deps, { session: undefined });
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((lean) => lean === true)).toBe(true);
    forced.full = true;
    const full = await sessionsVerify(deps, { session: undefined });
    expect(lean.report).toEqual(full.report);
    expect(lean.text).toBe(full.text);
    expect(lean.failed).toEqual(full.failed);
  });

  it('asks for the lean read of the one session as well, and its report equals the one a full read gives', async () => {
    const staged = stage();
    await deposit(staged.runtime, options);
    const deps = { sessions: staged.runtime, install: undefined, now: () => NOW };
    const lean = await sessionsVerify(deps, { session: 'tldr' });
    // The read of every skeleton, then the read of the one asked for.
    expect(asked).toHaveLength(2);
    expect(asked.every((lean) => lean === true)).toBe(true);
    forced.full = true;
    const full = await sessionsVerify(deps, { session: 'tldr' });
    expect(lean.report.sessions).toBe(1);
    expect(lean.report).toEqual(full.report);
    expect(lean.failed).toEqual(full.failed);
  });
});
