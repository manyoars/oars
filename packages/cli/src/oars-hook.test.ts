import { afterEach, describe, expect, it, vi } from 'vitest';

// `oars-hook` is a bin on PATH of a cloud image, so it needs the same floor line as `oars`. The floor check is mocked to see that it runs, with this process's Node version, before the hook program is imported.
const order: string[] = [];
const exitIfTooOld = vi.fn(() => {
  order.push('floor');
});

vi.mock('./node-floor.js', () => ({ exitIfTooOld }));
vi.mock('./hook-bin.js', () => {
  order.push('hook');
  return {};
});

describe('the oars-hook entry', () => {
  afterEach(() => {
    order.length = 0;
  });
  it('checks the Node floor before it loads the hook program', async () => {
    await import('./oars-hook.js');
    expect(exitIfTooOld).toHaveBeenCalledWith(process.versions.node, expect.any(Function), expect.any(Function));
    expect(order).toEqual(['floor', 'hook']);
  });
});
