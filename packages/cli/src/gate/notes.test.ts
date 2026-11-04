import { describe, expect, it } from 'vitest';
import { decide, lineText, LINE_TABLE, type LineFacts } from './notes.js';
import { DEFAULT_POLICY, type Policy } from './policy.js';
import { ARMS, LINE_IDS } from './record.js';

const NOW = Date.parse('2026-11-04T10:00:00.000Z');
const young: LineFacts = { state: 'found', created: '2026-11-01T10:00:00.000Z', noted: false };
const missing: LineFacts = { state: 'not-found', created: null, noted: false };
const policy = (extra: Partial<Policy> = {}, classes: Partial<Policy['classes']> = {}): Policy => ({ ...DEFAULT_POLICY, ...extra, classes: { ...DEFAULT_POLICY.classes, ...classes } });
const shown = (): number => 0.99;
const held = (): number => 0;

describe('the line table', () => {
  it('has one line for each id but none, and the ids and arms are closed', () => {
    expect(Object.keys(LINE_TABLE).sort()).toEqual(LINE_IDS.filter((id) => id !== 'none').sort());
    expect(ARMS).toEqual(['none', 'shown', 'held']);
  });

  it('states the fact and uses no word that judges or sells: no malicious, threat, protect, secure, danger, unsafe, attack, risk, or trust', () => {
    for (const id of LINE_IDS.filter((one) => one !== 'none')) {
      for (const days of [0, 1, 12]) {
        const text = lineText(id, '@scope/pkg', days);
        expect(text, id).toContain('@scope/pkg');
        expect(text, id).not.toMatch(/malicious|threat|protect|secur|danger|unsafe|attack|risk|trust|safe|bad|harm|warn/i);
      }
    }
    expect(lineText('young-name-note', 'left-pad', 3)).toBe('Registry note: left-pad was first published 3 days ago in the registry your package manager uses.');
    expect(lineText('young-name-note', 'left-pad', 1)).toContain('1 day ago');
    expect(lineText('young-name-note', 'left-pad', 0)).toContain('less than a day ago');
    expect(lineText('not-found-note', 'ghost', 0)).toBe('Registry note: ghost was not found in the registry your package manager uses.');
    expect(lineText('not-found-block', 'ghost', 0)).toBe('Blocked by your gate policy: ghost was not found in the registry your package manager uses.');
    expect(lineText('none', 'x', 0)).toBe('');
  });
});

describe('what a row says and shows', () => {
  it('is silent without a reading, for a found name that is not young, and for a young name the policy turns off', () => {
    expect(decide(policy(), undefined, NOW, shown, 'x')).toEqual({ arm: 'none', lineId: 'none', kind: 'none', text: null });
    expect(decide(policy(), { ...young, created: '2026-09-01T00:00:00.000Z' }, NOW, shown, 'x').kind).toBe('none');
    expect(decide(policy(), { ...young, created: null }, NOW, shown, 'x').kind).toBe('none');
    expect(decide(policy(), { ...young, created: 'garbage' }, NOW, shown, 'x').kind).toBe('none');
    expect(decide(policy(), { ...young, created: '2026-11-05T00:00:00.000Z' }, NOW, shown, 'x').kind).toBe('none');
    expect(decide(policy({}, { 'young-name': 'off' }), young, NOW, shown, 'x').kind).toBe('none');
  });

  it('notes a young name by the policy day count, and not a name the session has already seen', () => {
    expect(decide(policy(), young, NOW, shown, 'left-pad')).toEqual({ arm: 'shown', lineId: 'young-name-note', kind: 'note', text: 'Registry note: left-pad was first published 3 days ago in the registry your package manager uses.' });
    expect(decide(policy({ youngDays: 3 }), young, NOW, shown, 'x').kind).toBe('none');
    expect(decide(policy({ youngDays: 4 }), young, NOW, shown, 'x').kind).toBe('note');
    expect(decide(policy(), { ...young, noted: true }, NOW, shown, 'x').kind).toBe('none');
    expect(decide(policy(), { ...young, noted: false }, NOW, shown, 'x').kind).toBe('note');
  });

  it('notes a name not found by default, blocks it only when the policy says block, and says nothing when it is off', () => {
    expect(decide(policy(), missing, NOW, shown, 'ghost')).toMatchObject({ arm: 'shown', lineId: 'not-found-note', kind: 'note' });
    expect(decide(policy({}, { 'not-found': 'block' }), missing, NOW, shown, 'ghost')).toEqual({ arm: 'none', lineId: 'not-found-block', kind: 'block', text: 'Blocked by your gate policy: ghost was not found in the registry your package manager uses.' });
    expect(decide(policy({}, { 'not-found': 'off' }), missing, NOW, shown, 'ghost').kind).toBe('none');
  });

  it('holds back a note when the draw falls inside the share: the arm is held, no text shows, and the withheld line id stays', () => {
    expect(decide(policy(), young, NOW, held, 'x')).toEqual({ arm: 'held', lineId: 'young-name-note', kind: 'none', text: null });
    expect(decide(policy(), missing, NOW, held, 'ghost')).toEqual({ arm: 'held', lineId: 'not-found-note', kind: 'none', text: null });
    expect(decide(policy({ holdbackPercent: 0 }), young, NOW, held, 'x').arm).toBe('shown');
    expect(decide(policy({ holdbackPercent: 100 }), young, NOW, shown, 'x').arm).toBe('held');
    expect(decide(policy({ holdbackPercent: 10 }), young, NOW, () => 0.0999, 'x').arm).toBe('held');
    expect(decide(policy({ holdbackPercent: 10 }), young, NOW, () => 0.1, 'x').arm).toBe('shown');
  });

  it('never holds back a block, and spends no draw on one', () => {
    let draws = 0;
    const counted = (): number => {
      draws += 1;
      return 0;
    };
    expect(decide(policy({ holdbackPercent: 100 }, { 'not-found': 'block' }), missing, NOW, counted, 'ghost')).toMatchObject({ arm: 'none', lineId: 'not-found-block', kind: 'block' });
    expect(draws).toBe(0);
  });
});
