import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import root from '../../../vitest.config.js';
import workspace from '../vitest.config.js';

const rootDir = fileURLToPath(new URL('../../../', import.meta.url));
const cliDir = fileURLToPath(new URL('../', import.meta.url));

// A workspace run that skips the root config fell back to vitest's 5 s default (t1113); this pins the two configs to the same limits and setup file.
describe('packages/cli vitest config', () => {
  it('uses the root testTimeout and hookTimeout', () => {
    expect(root.test?.testTimeout).toBeGreaterThan(5_000);
    expect(workspace.test?.testTimeout).toBe(root.test?.testTimeout);
    expect(workspace.test?.hookTimeout).toBe(root.test?.hookTimeout);
  });

  it('resolves to the same setup file as the root', () => {
    const rootSetup = [root.test?.setupFiles ?? []].flat().map((f) => resolve(rootDir, f));
    const cliSetup = [workspace.test?.setupFiles ?? []].flat().map((f) => resolve(cliDir, f));
    expect(cliSetup).toEqual(rootSetup);
  });
});
