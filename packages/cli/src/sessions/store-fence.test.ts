import { appendFileSync, promises, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NOW, cleanup, stage, type Staged } from './test-support.js';

// A deposit that outlives its lock: a waiter breaks the lock after the heartbeat's cap and a second holder writes `state.json`. The default lock
// options are an hour of heartbeat, so the takeover is staged by hand, at the moment the first deposit opens a transcript.
interface Seams {
  open: ((file: string) => void) | undefined;
}
const seams = vi.hoisted((): Seams => ({ open: undefined }));

// A transcript is read whole, so the takeover fires when the first deposit reads one.
vi.mock('node:fs/promises', () => ({
  ...promises,
  readFile: (file: string, encoding: 'utf8') => {
    seams.open?.(file);
    return promises.readFile(file, encoding);
  },
}));

const { compactLog, deposit, depositSession, paths, withLock } = await import('./store.js');

beforeEach(() => {
  seams.open = undefined;
});
afterEach(cleanup);

const options = { allow: ['proj'], redactDomains: [], now: () => NOW };

const recordOf = (text: string): object => {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null) throw new Error('not a record');
  return parsed;
};

const stateOf = (staged: Staged): { allow: string[]; redactDomains: string[] } => {
  const parsed: unknown = JSON.parse(readFileSync(paths(staged.storeDir).state, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || !('allow' in parsed) || !('redactDomains' in parsed)) throw new Error('not a state');
  const { allow, redactDomains } = parsed;
  return { allow: Array.isArray(allow) ? allow.map(String) : [], redactDomains: Array.isArray(redactDomains) ? redactDomains.map(String) : [] };
};

/** The state the second holder writes after it took the broken lock: its own `--allow` and `--redact-domain`, and the lock file with its token. */
const secondHolder = (staged: Staged): void => {
  const { allow, redactDomains } = stateOf(staged);
  const whole = Object.fromEntries(Object.entries(recordOf(readFileSync(paths(staged.storeDir).state, 'utf8'))));
  writeFileSync(paths(staged.storeDir).state, JSON.stringify({ ...whole, allow: [...allow, 'newer'], redactDomains: [...redactDomains, 'b.example'] }));
  writeFileSync(join(staged.storeDir, 'store.lock'), `${String(process.pid + 1)} second-holder-token`);
};

const touchTranscript = (staged: Staged, seconds: number): void => {
  const file = join(staged.projectsRoot, 'proj', 'tldr.jsonl');
  appendFileSync(file, `${JSON.stringify({ type: 'user', timestamp: '2026-06-01T00:00:00Z', message: { role: 'user', content: 'one more prompt' } })}\n`);
  const later = new Date(Date.now() + seconds * 1000);
  utimesSync(file, later, later);
};

describe('a holder that lost the store lock', () => {
  it('does not overwrite the later holder\'s allow and redactDomains in state.json', async () => {
    const staged = stage();
    await deposit(staged.runtime, options);
    touchTranscript(staged, 5);
    let taken = false;
    seams.open = (file) => {
      if (taken || !file.endsWith('tldr.jsonl')) return;
      taken = true;
      secondHolder(staged);
    };
    await expect(deposit(staged.runtime, options)).rejects.toThrow('lost the store lock');
    expect(taken).toBe(true);
    expect(stateOf(staged)).toEqual({ allow: ['proj', 'newer'], redactDomains: ['b.example'] });
    // The first deposit's cleanup leaves the second holder's lock alone.
    expect(readFileSync(join(staged.storeDir, 'store.lock'), 'utf8')).toBe(`${String(process.pid + 1)} second-holder-token`);
  });

  it('does not write state.json from the hook path either', async () => {
    const staged = stage();
    await deposit(staged.runtime, options);
    touchTranscript(staged, 5);
    seams.open = (file) => {
      if (file.endsWith('tldr.jsonl')) secondHolder(staged);
    };
    await expect(depositSession(staged.runtime, join(staged.projectsRoot, 'proj', 'tldr.jsonl'), () => NOW)).rejects.toThrow('lost the store lock');
    expect(stateOf(staged)).toEqual({ allow: ['proj', 'newer'], redactDomains: ['b.example'] });
  });

  it('does not replace the log when it no longer holds the lock', async () => {
    const staged = stage();
    await deposit(staged.runtime, options);
    // A second copy of every record at the next rev leaves the first copy superseded, so a compaction has work.
    const log = paths(staged.storeDir).observations;
    const records = readFileSync(log, 'utf8').split('\n').filter((line) => line !== '');
    const newer = records.map((line) => JSON.stringify({ ...Object.fromEntries(Object.entries(recordOf(line))), rev: 99 }));
    appendFileSync(log, `${newer.join('\n')}\n`);
    const before = readFileSync(log, 'utf8');
    await expect(withLock(staged.storeDir, () => compactLog(staged.storeDir, 0, () => Promise.resolve(false)))).rejects.toThrow('lost the store lock');
    expect(readFileSync(log, 'utf8')).toBe(before);
  });
});
