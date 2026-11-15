// The card's own sentences about its tables: what `unknown` means, why the model table totals less than the intervention table, and what "what followed" counts.
import { describe, expect, it } from 'vitest';
import { cardOf } from './skeleton-card.js';
import type { TraceInput } from './skeleton-trace.js';

const PACK = { olderThanDays: 7, built: '2026-11-14T00:00:00Z', redactionVersion: '4', reasoning: 'stripped' };
const CENSUS = { sessions: 2, harness: { 'claude-code': 2 }, harnessVersion: {}, model: { 'claude-opus-5-5': 3 }, errorCode: {}, recovery: { 'edit followed': 1 }, intervention: { none: 2, unknown: 3 }, promptClass: {}, turnBucket: { '2': 2 } };
const MATCH = (n: number): string => String(n).repeat(64);
const prompt = (intervention: string, model: string | null): object => ({ intervention, frame: { model } });
// Session 1: a middle prompt with no model, then a last prompt. Session 2: two prompts, one of them `unknown` and not last.
const KEPT: TraceInput[] = [
  { matchId: MATCH(1), skeleton: { transcripts: [{ prompts: [prompt('none', 'claude-opus-5-5'), prompt('none', null), prompt('unknown', 'claude-opus-5-5')], tools: [] }] } },
  { matchId: MATCH(2), skeleton: { transcripts: [{ prompts: [prompt('unknown', 'claude-opus-5-5'), prompt('unknown', null)], tools: [] }] } },
];
const lines = (text: string): string[] => text.split('\n');

describe('the card defines unknown where the intervention table starts', () => {
  const card = cardOf(PACK, CENSUS, KEPT);
  const at = lines(card).indexOf('**Prompts per human intervention**');

  it('puts the definition between the table title and its rows', () => {
    const next = lines(card).findIndex((row, index) => index > at + 1 && row.startsWith('- `'));
    const block = lines(card).slice(at, next).join('\n');
    expect(at).toBeGreaterThan(-1);
    expect(block).toContain('`unknown` means the pack cannot say what the next human prompt did to the work.');
    expect(block).toContain('It is not a judgment of the work.');
    expect(block).toContain('https://github.com/manyoars/oars/blob/main/docs/sessions-store.md');
  });

  it('names the three causes in plain words', () => {
    const block = lines(card).slice(at, at + 6).join('\n');
    expect(block).toContain('the prompt is the last one of its transcript');
    expect(block).toContain('the prompt is the record of an interrupt');
    expect(block).toContain('the next prompt ran a shell command that was recorded without the detail needed to tell whether it undid work');
  });

  it('prints the count of unknown prompts that are last prompts, computed from the kept sessions', () => {
    expect(card).toContain('Last prompts among the `unknown` ones in this pack: 2 of 3.');
    const none = cardOf(PACK, CENSUS, [{ matchId: MATCH(1), skeleton: { transcripts: [{ prompts: [prompt('unknown', 'a'), prompt('none', 'a')] }, { prompts: [prompt('none', 'a')] }] } }]);
    expect(none).toContain('Last prompts among the `unknown` ones in this pack: 0 of 1.');
  });

  it('prints no count when the card holds no kept session to count from', () => {
    const bare = cardOf(PACK, CENSUS);
    expect(bare).toContain('`unknown` means the pack cannot say');
    expect(bare).not.toContain('in this pack:');
  });
});
