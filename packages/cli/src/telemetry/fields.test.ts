import { describe, expect, it } from 'vitest';
import { frameWords, harnessWord } from './fields.js';

describe('frameWords', () => {
  it('names the harness from the closed list, and any other name as other', () => {
    expect(harnessWord('codex')).toBe('codex');
    expect(harnessWord('acme-private')).toBe('other');
  });

  it('carries the harness a caller names, and none for the scheduled nightly, which runs under no harness', () => {
    expect(frameWords(undefined, '2.1.300', null)).toEqual({ harnessVersion: '2.1.300' });
  });

  it('always carries the harness, and the version and model only when seen', () => {
    expect(frameWords('claude-code', undefined, null)).toEqual({
      harness: 'claude-code',
    });
    expect(frameWords('codex', '2.1.300', 'claude-opus-4-5')).toEqual({
      harness: 'codex',
      harnessVersion: '2.1.300',
      model: 'claude-opus-4-5',
    });
  });
});
