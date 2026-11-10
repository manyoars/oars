// A fixture database is written once, closed, and read back in the same test, so durability buys it nothing; a commit that syncs makes the test wait on the disk instead. A shared CI disk turned the sixteen commits of one Cursor fixture into 40 seconds.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openFixtureDb, stageRawCursor } from './test-support.js';

const made: string[] = [];
afterEach(() => {
  for (const folder of made.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const temp = (): string => {
  const folder = mkdtempSync(join(tmpdir(), 'oars-fixture-db-'));
  made.push(folder);
  if (!folder.startsWith(tmpdir())) throw new Error('the test folder is not under the temp folder');
  return folder;
};

describe('a fixture database', () => {
  it('never waits on the disk: no sync on a commit, and the journal in memory', async () => {
    const db = await openFixtureDb(join(temp(), 'state.vscdb'));
    try {
      expect(db.prepare('pragma synchronous').get()).toEqual({ synchronous: 0 });
      expect(db.prepare('pragma journal_mode').get()).toEqual({ journal_mode: 'memory' });
    } finally {
      db.close();
    }
  });

  it('keeps every row it was given, for a reader that opens the file afterward', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const user = await stageRawCursor(temp(), [{ id: 'one', document: { composerId: 'one' } }, { id: 'two', document: { composerId: 'two' } }], []);
    const db = new DatabaseSync(join(user, 'globalStorage', 'state.vscdb'), { readOnly: true });
    try {
      expect(db.prepare('select key from cursorDiskKV order by key').all()).toEqual([{ key: 'composerData:one' }, { key: 'composerData:two' }]);
    } finally {
      db.close();
    }
  });
});
