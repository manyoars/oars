// t776: a folder off the allowlist that cannot be listed is scope, not a failure: `verify` names it and goes on.
import type * as fsp from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// A real unreadable folder (EACCES) cannot be made portably, so `readdir` fails for one folder.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fsp>();
  const readdir = vi.fn(actual.readdir);
  readdir.mockImplementation(((dir: string, options: object) =>
    typeof dir === 'string' && dir.endsWith('locked-app') ? Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })) : actual.readdir(dir, options)) as typeof actual.readdir);
  return { ...actual, readdir };
});

const { sessionsVerify } = await import('./command.js');
const { deposit, skippedFolders } = await import('./store.js');
const { cleanup, NOW, stage } = await import('./test-support.js');

afterEach(cleanup);

describe('a skipped folder that cannot be listed', () => {
  it('is named with no transcript count, and verify still succeeds', async () => {
    const staged = stage();
    mkdirSync(join(staged.projectsRoot, 'locked-app'));
    await deposit(staged.runtime, { allow: ['proj'], redactDomains: [], now: () => NOW });
    expect(await skippedFolders(staged.runtime)).toEqual({ folders: 1, transcripts: 0, names: ['locked-app'] });
    const verified = await sessionsVerify({ sessions: staged.runtime, install: undefined, now: () => NOW }, { session: undefined });
    expect(verified.report.scope.names).toEqual(['locked-app']);
    expect(verified.failed).toEqual([]);
  });
});
