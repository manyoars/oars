// A folder off the allowlist that cannot be listed is scope, not a failure: `verify` names it and goes on.
import type * as fsp from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// A real unreadable folder (EACCES) cannot be made portably, so `readdir` fails for one folder.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fsp>();
  const readdir = vi.fn(actual.readdir);
  readdir.mockImplementation((dir, options) =>
    typeof dir === 'string' && (dir.endsWith('locked-app') || dir.endsWith('locked-root')) ? Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })) : actual.readdir(dir, options),
  );
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
    expect(verified.text).toMatch(/1 project folder holds no main transcript; it is never read: not on the allowlist\. Not captured: locked-app\./);
    expect(verified.failed).toEqual([]);
  });

  it('reports an empty scope, and verify still succeeds, when the projects root itself cannot be listed', async () => {
    const staged = stage();
    await deposit(staged.runtime, { allow: ['proj'], redactDomains: [], now: () => NOW });
    const locked = { ...staged.runtime, projectsRoot: join(staged.root, 'locked-root') };
    const verified = await sessionsVerify({ sessions: locked, install: undefined, now: () => NOW }, { session: undefined });
    expect(verified.report.scope).toEqual({ folders: 0, transcripts: 0, names: [] });
    expect(verified.failed).toEqual([]);
  });
});
