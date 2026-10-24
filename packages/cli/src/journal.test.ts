import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fileJournalStore, stepKey } from './journal.js';
import { harness, useServer } from './test-support.js';

useServer();

const journalFolder = (dir: string): string => join(dir, 'oars', 'journal');

describe('stepKey', () => {
  it('maps one step to one fixed lowercase 64-hex value', () => {
    expect(stepKey('K', 'register')).toBe('6b18a43fe3ae4d0f343321e01ab154b26fdd0b32f7aacf4f1c9d3f197974b59c');
    expect(stepKey('K', 'price:calls-100')).toBe('264747aef940d2654c5d43b4560a04c6089322bf15423e77e44f13a63c58c083');
    expect(stepKey('K', 'deploy')).toBe('78413f283e0efd102f9c5950800ce2d37fd4e0f526592b3414ba552458a008b5');
  });
});

describe('fileJournalStore', () => {
  it('round-trips a record by base key and deletes it', async () => {
    const store = fileJournalStore(harness().configDir);
    expect(await store.read('K')).toBeUndefined();
    await store.write({ base: 'K', steps: [{ step: 'register', status: 201 }] });
    expect(await store.read('K')).toEqual({ base: 'K', steps: [{ step: 'register', status: 201 }] });
    expect(await store.read('other')).toBeUndefined();
    await store.delete('K');
    expect(await store.read('K')).toBeUndefined();
  });

  it('names the file by the key hash, so a key with path characters stays inside the journal folder', async () => {
    const dir = harness().configDir;
    await fileJournalStore(dir).write({ base: '../../x/y', steps: [] });
    const files = readdirSync(journalFolder(dir));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f]{64}\.json$/);
    expect(JSON.parse(readFileSync(join(journalFolder(dir), files[0] ?? ''), 'utf8'))).toEqual({ base: '../../x/y', steps: [] });
  });

  it('reads a torn file, or one for another key, as no record', async () => {
    const dir = harness().configDir;
    const store = fileJournalStore(dir);
    await store.write({ base: 'K', steps: [] });
    const file = join(journalFolder(dir), readdirSync(journalFolder(dir))[0] ?? '');
    writeFileSync(file, '{"base":"K","steps":');
    expect(await store.read('K')).toBeUndefined();
    writeFileSync(file, JSON.stringify({ base: 'someone-else', steps: [] }));
    expect(await store.read('K')).toBeUndefined();
  });
});
