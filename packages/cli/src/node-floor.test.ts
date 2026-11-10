import { describe, expect, it } from 'vitest';
import { MIN_NODE, exitIfTooOld, nodeFloorMessage } from './node-floor.js';
import pkg from '../package.json' with { type: 'json' };

describe('the Node floor', () => {
  it('says the one line on an older Node', () => {
    expect(nodeFloorMessage('22.13.0')).toBe('oars needs Node 22.23.4 or newer; this is Node 22.13.0.');
    expect(nodeFloorMessage('22.23')).toBe('oars needs Node 22.23.4 or newer; this is Node 22.23.');
  });
  it('says nothing on the floor or above', () => {
    expect(nodeFloorMessage('22.23.4')).toBeUndefined();
    expect(nodeFloorMessage('22.24.0')).toBeUndefined();
    expect(nodeFloorMessage('24.0.0')).toBeUndefined();
    expect(nodeFloorMessage('26.1.2')).toBeUndefined();
  });
  it('the bin writes the one line plus a newline and exits 1 under the floor', () => {
    const written: unknown[] = [];
    const codes: number[] = [];
    exitIfTooOld('22.13.0', (text) => written.push(text), (code) => codes.push(code));
    expect(written).toEqual(['oars needs Node 22.23.4 or newer; this is Node 22.13.0.\n']);
    expect(codes).toEqual([1]);
  });
  it('the bin neither writes nor exits on the floor version', () => {
    const written: unknown[] = [];
    const codes: number[] = [];
    exitIfTooOld('22.23.4', (text) => written.push(text), (code) => codes.push(code));
    expect(written).toEqual([]);
    expect(codes).toEqual([]);
  });
  it('matches engines.node', () => {
    expect(pkg.engines.node).toBe(`>=${MIN_NODE}`);
  });
});
