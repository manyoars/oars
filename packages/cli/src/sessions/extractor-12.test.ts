// EXTRACTOR 12: a derived prompt carries the strata of its user-prompt record (the prompt's own `explore` count among them). Derived prompts are a pure function
// of the capture log, so a store written at 11 gets them with strata the next time it is read, and its derived file is written again at 12 from the log alone.
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { EXTRACTOR_VERSION } from './schema.js';
import { deposit, loadStore, paths, refresh } from './store.js';
import { cleanup, NOW, stage } from './test-support.js';

afterEach(cleanup);

describe('EXTRACTOR_VERSION 12', () => {
  it('is 12, the version that gives a derived prompt its strata', () => {
    expect(EXTRACTOR_VERSION).toBe('12');
  });

  it('re-derives a store written at 11 from its log alone, and each derived prompt holds its strata', async () => {
    const staged = stage();
    await deposit(staged.runtime, { allow: ['proj'], redactDomains: [], now: () => NOW });
    const before = await loadStore(staged.storeDir);
    expect(before.prompts.length).toBeGreaterThan(0);
    // The store as version 11 left it: its derived records stamped '11'. The transcripts are gone, so nothing can be read from raw.
    writeFileSync(paths(staged.storeDir).derived, readFileSync(paths(staged.storeDir).derived, 'utf8').replaceAll(`"v":"${EXTRACTOR_VERSION}"`, '"v":"11"'));
    expect(readFileSync(paths(staged.storeDir).derived, 'utf8')).not.toContain(`"v":"${EXTRACTOR_VERSION}"`);
    rmSync(staged.projectsRoot, { recursive: true, force: true });
    await refresh(staged.runtime, [], '2026-06-10T00:00:00.000Z');
    const written = readFileSync(paths(staged.storeDir).derived, 'utf8');
    expect(written).toContain(`"v":"${EXTRACTOR_VERSION}"`);
    expect(written).not.toContain('"v":"11"');
    const after = await loadStore(staged.storeDir);
    expect(after.prompts.length).toBe(before.prompts.length);
    expect(after.prompts.every((prompt) => prompt.strata !== undefined)).toBe(true);
    expect(after.prompts.map((prompt) => prompt.strata)).toEqual(before.prompts.map((prompt) => prompt.strata));
  });
});
