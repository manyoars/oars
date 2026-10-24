import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { harness, useServer } from './test-support.js';

useServer();

// The two tests run in order: the second looks for what the first left behind.
describe('harness config directories', () => {
  let earlier = '';

  it('creates a directory for each harness', () => {
    earlier = harness().configDir;
    expect(existsSync(earlier)).toBe(true);
  });

  it('removed that directory when the test ended (it holds token-shaped credentials files)', () => {
    expect(earlier).not.toBe('');
    expect(existsSync(earlier)).toBe(false);
  });
});
