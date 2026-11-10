import { describe, expect, it } from 'vitest';
import { MIN_NODE_MAJOR, exitIfTooOld, nodeFloorMessage } from './node-floor.js';
import pkg from '../package.json' with { type: 'json' };

describe('the Node floor', () => {
  it('says the one line on an older Node', () => {
    expect(nodeFloorMessage('22.13.0')).toBe('oars needs Node 24 or newer; this is Node 22.13.0.');
  });
  it('says nothing on the floor or above', () => {
    expect(nodeFloorMessage('24.0.0')).toBeUndefined();
    expect(nodeFloorMessage('26.1.2')).toBeUndefined();
  });
  it('the bin writes the one line plus a newline and exits 1 under the floor', () => {
    const written: unknown[] = [];
    const codes: number[] = [];
    exitIfTooOld('22.13.0', (text) => written.push(text), (code) => codes.push(code));
    expect(written).toEqual(['oars needs Node 24 or newer; this is Node 22.13.0.
']);
    expect(codes).toEqual([1]);
  });
  it('the bin neither writes nor exits on the floor version', () => {
    const written: unknown[] = [];
    const codes: number[] = [];
    exitIfTooOld('24.0.0', (text) => written.push(text), (code) => codes.push(code));
    expect(written).toEqual([]);
    expect(codes).toEqual([]);
  });
  it('matches engines.node', () => {
    expect(pkg.engines.node).toBe(`>=${String(MIN_NODE_MAJOR)}`);
  });
});
