import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mayRecord, runCodexHook, savedList } from './codex-hook.js';
import { cleanHook, payloadOf, stageHook, type HookStore } from './codex-hook-support.js';

afterEach(cleanHook);

// The consent gate is the one deposit applies to a source (`allow.allows('codex')`), plus the folder test against the saved denials alone.
const record = async (store: HookStore, cwd: string = join(store.root, 'work', 'app')): Promise<number> => {
  await runCodexHook(JSON.stringify(payloadOf('PostToolUse', { cwd })), store.runtime);
  return store.rows().length;
};

describe('the saved list gates every row', () => {
  it('writes nothing under a saved --deny codex', async () => {
    const store = stageHook();
    store.saveState(JSON.stringify({ allow: ['!codex'] }));
    expect(await record(store)).toBe(0);
    expect(store.notes()).toEqual([]);
  });

  it('writes nothing when the list has allow entries and none names codex', async () => {
    const store = stageHook();
    store.saveState(JSON.stringify({ allow: ['~/work/', '*-projects-*'] }));
    expect(await record(store)).toBe(0);
  });

  it('writes nothing when the payload folder is one a saved --deny names', async () => {
    const store = stageHook();
    const denied = join(store.root, 'work', 'private');
    store.saveState(JSON.stringify({ allow: [`!${denied}/`] }));
    expect(await record(store, join(denied, 'sub'))).toBe(0);
    expect(await record(store, join(store.root, 'work', 'public'))).toBe(1);
  });

  it('writes rows under a saved --allow codex alone, whatever folder the call ran in', async () => {
    const store = stageHook();
    store.saveState(JSON.stringify({ allow: ['codex'] }));
    expect(await record(store)).toBe(1);
    expect(await record(store, join(store.root, 'anywhere'))).toBe(2);
  });

  it('writes nothing from a malformed state.json, because a lost --deny codex must not become capture', async () => {
    const store = stageHook();
    for (const text of ['{not json', '[]', '"text"', '{"allow": "codex"}', '{"allow": [1]}']) {
      store.saveState(text);
      expect(await record(store)).toBe(0);
    }
  });
});

describe('the cases deposit also allows', () => {
  it('records with no state.json, an empty list, or a denials-only list that names another folder', async () => {
    const store = stageHook();
    expect(await record(store)).toBe(1);
    store.saveState(JSON.stringify({ allow: [] }));
    expect(await record(store)).toBe(2);
    store.saveState(JSON.stringify({ files: {} }));
    expect(await record(store)).toBe(3);
    store.saveState(JSON.stringify({ allow: [`!${join(store.root, 'elsewhere')}`] }));
    expect(await record(store)).toBe(4);
  });

  it('records a call with a denial-free list when the payload names no folder', async () => {
    const store = stageHook();
    const payload = payloadOf('PostToolUse');
    delete payload.cwd;
    await runCodexHook(JSON.stringify(payload), store.runtime);
    expect(store.rows()).toHaveLength(1);
  });
});

describe('mayRecord and savedList', () => {
  it('refuses a payload with no folder when the list holds a folder denial, and a list it could not read', () => {
    expect(mayRecord(['!~/secret/'], null)).toBe(false);
    expect(mayRecord(undefined, '/work/app')).toBe(false);
    expect(mayRecord([], null)).toBe(true);
  });

  it('refuses a payload folder under a denied prefix and records one beside it', () => {
    expect(mayRecord(['!/work/private/'], '/work/private/sub')).toBe(false);
    expect(mayRecord(['!/work/private/'], '/work/public')).toBe(true);
  });

  it('reads an unreadable state.json (a folder in its place) as no list', async () => {
    const store = stageHook();
    store.saveState('{"allow":["codex"]}');
    expect(await savedList(store.storeDir)).toEqual(['codex']);
    expect(await savedList(join(store.storeDir, 'nested', 'none'))).toEqual([]);
    mkdirSync(join(store.storeDir, 'other', 'state.json'), { recursive: true });
    expect(await savedList(join(store.storeDir, 'other'))).toBeUndefined();
  });
});
