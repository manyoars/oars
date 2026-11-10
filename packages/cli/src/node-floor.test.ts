import { describe, expect, it } from 'vitest';
import { MIN_NODE_MAJOR, nodeFloorMessage } from './node-floor.js';
import pkg from '../package.json' with { type: 'json' };

describe('the Node floor', () => {
  it('says the one line on an older Node', () => {
    expect(nodeFloorMessage('22.13.0')).toBe('oars needs Node 24 or newer; this is Node 22.13.0.');
  });
  it('says nothing on the floor or above', () => {
    expect(nodeFloorMessage('24.0.0')).toBeUndefined();
    expect(nodeFloorMessage('26.1.2')).toBeUndefined();
  });
  it('matches engines.node', () => {
    expect(pkg.engines.node).toBe(`>=${String(MIN_NODE_MAJOR)}`);
  });
});
