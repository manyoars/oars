// The serve floors are bindings, not constants. An unset binding is the default; a malformed, non-integer, or under-1 one is the default too, with one logged line, so a bad binding can never serve below the floor the deploy meant.
import { describe, expect, it } from 'vitest';
import { FIRST_ORDER_FAMILIES } from '../../cli/src/sessions/read.js';
import type { Cell } from '../../cli/src/sessions/cells.js';
import { cellFloor, clears, clustersOf, DEFAULT_CLEAR_FLOOR, DEFAULT_DISCLOSURE_FLOOR, DEFAULT_FLOORS, DEFAULT_PUBLIC_FLOOR, floorFor, floorsOf, wireFloors } from './floors.js';
import { wranglerConfig, fieldOf } from './test-pool.js';

const parse = (env: Parameters<typeof floorsOf>[0]): { floors: ReturnType<typeof floorsOf>; lines: string[] } => {
  const lines: string[] = [];
  const floors = floorsOf(env, (line) => lines.push(line));
  return { floors, lines };
};

describe('the defaults', () => {
  it('are 5, 1, and 2, and wrangler.jsonc states the same three numbers', () => {
    expect([DEFAULT_PUBLIC_FLOOR, DEFAULT_CLEAR_FLOOR, DEFAULT_DISCLOSURE_FLOOR]).toEqual([5, 1, 2]);
    expect(fieldOf(wranglerConfig().parsed, 'vars')).toMatchObject({ PUBLIC_FLOOR: String(DEFAULT_PUBLIC_FLOOR), CLEAR_FLOOR: String(DEFAULT_CLEAR_FLOOR), DISCLOSURE_FLOOR: String(DEFAULT_DISCLOSURE_FLOOR) });
  });

  it('are what unset bindings give, with nothing logged', () => {
    expect(parse({})).toEqual({ floors: DEFAULT_FLOORS, lines: [] });
    expect(parse({ PUBLIC_FLOOR: '', CLEAR_FLOOR: '', DISCLOSURE_FLOOR: '', PUBLIC_FLOOR_FAMILIES: '' })).toEqual({ floors: DEFAULT_FLOORS, lines: [] });
  });
});

describe.each([
  { binding: 'PUBLIC_FLOOR', key: 'public', fallback: 5 },
  { binding: 'DISCLOSURE_FLOOR', key: 'disclosure', fallback: 2 },
] as const)('$binding', ({ binding, key, fallback }) => {
  it.each(['1', '3', '10', '250'])('takes the valid value %s, and logs nothing', (value) => {
    const { floors, lines } = parse({ [binding]: value });
    expect(floors[key]).toBe(Number(value));
    expect(lines).toEqual([]);
  });

  it('does not let the other binding move', () => {
    const { floors } = parse({ [binding]: '9' });
    expect(floors[key === 'public' ? 'disclosure' : 'public']).toBe(key === 'public' ? 2 : 5);
    expect(floors.clear).toBe(1);
  });

  it.each(['abc', '5.5', '5x', '0x5', '1e1', '+5', ' ', '٣', '9007199254740993', 'Infinity', 'NaN', '[5]'])('takes the default for the malformed value %j, with one line naming the binding', (value) => {
    const { floors, lines } = parse({ [binding]: value });
    expect(floors[key]).toBe(fallback);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(binding);
  });

  it.each(['0', '-1', '-5', '00', '0.5'])('takes the default for the under-1 value %s, with one line', (value) => {
    const { floors, lines } = parse({ [binding]: value });
    expect(floors[key]).toBe(fallback);
    expect(lines).toHaveLength(1);
  });

  it('reads a value with surrounding blanks as the number it holds', () => {
    expect(parse({ [binding]: ' 4 ' }).floors[key]).toBe(4);
  });
});

describe('CLEAR_FLOOR', () => {
  it.each(['1', '2', '5'])('takes the valid value %s, and logs nothing', (value) => {
    expect(parse({ CLEAR_FLOOR: value })).toMatchObject({ floors: { clear: Number(value), public: 5 }, lines: [] });
  });

  it('may equal a lowered public floor, and not pass it', () => {
    expect(parse({ PUBLIC_FLOOR: '3', CLEAR_FLOOR: '3' })).toMatchObject({ floors: { clear: 3, public: 3 }, lines: [] });
    const above = parse({ PUBLIC_FLOOR: '3', CLEAR_FLOOR: '4' });
    expect(above.floors.clear).toBe(3);
    expect(above.lines).toHaveLength(1);
    expect(above.lines[0]).toContain('CLEAR_FLOOR');
  });

  it('is refused above the public floor, which it falls back to, with one line', () => {
    const { floors, lines } = parse({ CLEAR_FLOOR: '6' });
    expect(floors.clear).toBe(5);
    expect(lines).toEqual(['CLEAR_FLOOR is 6, above the public floor of 5: using 5.']);
  });

  it.each(['0', '-1', 'abc', '1.5', '5x'])('is refused for %s, falls back to the public floor and fails closed, with one line', (value) => {
    const { floors, lines } = parse({ CLEAR_FLOOR: value });
    expect(floors.clear).toBe(5);
    expect(lines).toEqual([expect.stringContaining('CLEAR_FLOOR')]);
  });

  it('is 1 when unset, whatever the public floor, and never exceeds a public floor of 1', () => {
    expect(parse({ PUBLIC_FLOOR: '3' }).floors.clear).toBe(1);
    expect(parse({ PUBLIC_FLOOR: '1' }).floors.clear).toBe(1);
  });
});

describe('PUBLIC_FLOOR_FAMILIES', () => {
  it('parses family=floor pairs into a map keyed by read family', () => {
    const { floors, lines } = parse({ PUBLIC_FLOOR_FAMILIES: 'live=3, tool-day = 8' });
    expect(floors.families).toEqual({ live: 3, 'tool-day': 8 });
    expect(lines).toEqual([]);
  });

  it('accepts every family a bundle serves, and refuses the names beside them', () => {
    for (const family of FIRST_ORDER_FAMILIES) expect(parse({ PUBLIC_FLOOR_FAMILIES: `${family}=2` }).floors.families).toEqual({ [family]: 2 });
    for (const name of ['fit-environment', 'lead-lag', 'Live', 'constructor', '', '__proto__']) {
      const { floors, lines } = parse({ PUBLIC_FLOOR_FAMILIES: `${name}=2` });
      expect(floors.families, name).toEqual({});
      expect(lines, name).toHaveLength(1);
    }
  });

  it('refuses the whole list at an unknown name, with one line that names it, and applies none of the rest', () => {
    const { floors, lines } = parse({ PUBLIC_FLOOR_FAMILIES: 'live=3,lve=4,cost=6' });
    expect(floors.families).toEqual({});
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"lve"');
    expect(floorFor(floors, 'live')).toBe(5);
  });

  it.each(['live', 'live=', '=3', 'live=0', 'live=-1', 'live=2.5', 'live=abc', 'live=3=4', 'live=3,', 'live=3,live=4'])('refuses the malformed list %j', (value) => {
    const { floors, lines } = parse({ PUBLIC_FLOOR_FAMILIES: value });
    expect(floors.families).toEqual({});
    expect(lines).toHaveLength(1);
  });

  it('is one family on its own floor and no other', () => {
    const { floors } = parse({ PUBLIC_FLOOR: '5', PUBLIC_FLOOR_FAMILIES: 'live=3' });
    expect(floorFor(floors, 'live')).toBe(3);
    for (const family of FIRST_ORDER_FAMILIES.filter((name) => name !== 'live')) expect(floorFor(floors, family), family).toBe(5);
  });

  it('follows a public floor that moves, for every family without its own', () => {
    const { floors } = parse({ PUBLIC_FLOOR: '8', PUBLIC_FLOOR_FAMILIES: 'live=3' });
    expect([floorFor(floors, 'live'), floorFor(floors, 'cost')]).toEqual([3, 8]);
  });
});

describe('what the bundle states', () => {
  it('names both floors and only the families on a floor of their own', () => {
    expect(wireFloors(DEFAULT_FLOORS)).toEqual({ public: 5, disclosure: 2, clear: 1 });
    expect(wireFloors({ public: 3, disclosure: 2, clear: 3, families: { 'tool-day': 8, live: 3, cost: 6 } })).toEqual({ public: 3, disclosure: 2, clear: 3, families: { cost: 6, 'tool-day': 8 } });
  });

  it('is the same bytes for the same bindings, whatever order the families were written in', () => {
    const one = wireFloors(parse({ PUBLIC_FLOOR_FAMILIES: 'tool-day=8,live=3' }).floors);
    const two = wireFloors(parse({ PUBLIC_FLOOR_FAMILIES: 'live=3,tool-day=8' }).floors);
    expect(JSON.stringify(one)).toBe(JSON.stringify(two));
  });
});

describe('the one place a cell\'s count is taken', () => {
  const cell = (clusters: number, sessions: number): Cell => ({ motifId: 'm', frameBucket: 'f', grain: 'day', day: '2026-11-02', sessions, clusters, ok: 0, failed: 0, tokens: 0, durationMs: 0, exposed: false });

  it('is the cell\'s held count of accounts, and not its sessions', () => {
    expect(clustersOf(cell(4, 400))).toBe(4);
  });

  it('clears a floor at the count and above', () => {
    expect([clears(cell(2, 9), 3), clears(cell(3, 9), 3), clears(cell(4, 9), 3)]).toEqual([false, true, true]);
  });
});

describe('the floor of a cell\'s class', () => {
  it('is the clear floor for a clear cell at the public floor, and the read\'s floor for a thresholded one', () => {
    expect([cellFloor(DEFAULT_FLOORS, 5, 'clear'), cellFloor(DEFAULT_FLOORS, 5, 'thresholded'), cellFloor(DEFAULT_FLOORS, 3, 'clear')]).toEqual([1, 5, 1]);
  });

  it('is the read\'s floor for both classes when the clear floor is the public floor', () => {
    const one = { ...DEFAULT_FLOORS, clear: 5 };
    expect([cellFloor(one, 5, 'clear'), cellFloor(one, 5, 'thresholded'), cellFloor(one, 8, 'clear')]).toEqual([5, 5, 8]);
  });

  it('reads the clear floor from its binding', () => {
    expect(floorsOf({ PUBLIC_FLOOR: '3', CLEAR_FLOOR: '2' }, () => undefined).clear).toBe(2);
  });

  it('takes the gap below the public floor to every read\'s floor, and never goes under 1', () => {
    const lowered = { ...DEFAULT_FLOORS, clear: 3 };
    expect([cellFloor(lowered, 5, 'clear'), cellFloor(lowered, 8, 'clear'), cellFloor(lowered, 2, 'clear'), cellFloor(lowered, 8, 'thresholded')]).toEqual([3, 6, 1, 8]);
  });
});
