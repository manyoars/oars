import { describe, expect, it } from 'vitest';
import { cardOf, cardText, cardWindow, tweetLink, type Card } from './card.js';
import { CARD_NOW, cardStore, cardSurvival, PLANTED } from './card-fixture.js';
import { prompt, session, store as emptyStore } from './pool-fixture.js';

const week = (): Card => cardOf(cardStore(), cardSurvival(), 'week', CARD_NOW);

describe('cardOf: the counts', () => {
  it('counts the fixture store exactly, inside the window only', () => {
    const card = week();
    expect(card.windowEnd).toBe('2026-11-09');
    expect(card.days).toBe(7);
    expect(card.sessions).toBe(3);
    expect(card.activeDays).toBe(3);
    expect(card.harnesses).toEqual([
      { name: 'claude-code', sessions: 1 },
      { name: 'codex', sessions: 1 },
      { name: 'cursor', sessions: 1 },
    ]);
    expect(card.strokes).toBe(13);
    expect(card.crabs).toBe(4);
    expect(card.movedOn).toEqual({ count: 2, of: 4, share: null });
    expect(card.verifyAfterEdit).toEqual({ count: 30, of: 40, share: 0.75 });
    expect(card.commits).toBe(3);
    expect(card.survived).toEqual({ count: 1, of: 1, share: null });
    expect(card.cost).toEqual({ usd: 1.75, recorded: 2, of: 3 });
  });

  it('mixes models by prompts and sums tokens by model, folding a model that is not a published name into other', () => {
    expect(week().models).toEqual([
      { name: 'claude-opus-5-5', prompts: 40, tokens: 4000 },
      { name: 'gpt-5-codex', prompts: 3, tokens: 300 },
      { name: 'other', prompts: 1, tokens: 50 },
    ]);
  });

  it('folds every model past the third into other', () => {
    const many = cardStore();
    for (const [index, model] of ['gpt-4o', 'gemini-2.5-pro'].entries()) {
      const added = many.prompts[0];
      if (added === undefined) throw new Error('fixture has no prompt');
      many.prompts.push({ ...added, session: 's-claude', index: 100 + index, model });
    }
    const names = cardOf(many, cardSurvival(), 'week', CARD_NOW).models.map((entry) => entry.name);
    expect(names).toEqual(['claude-opus-5-5', 'gpt-5-codex', 'gemini-2.5-pro', 'other']);
  });

  it('reads the month and the year as longer windows over the same store', () => {
    expect(cardOf(cardStore(), cardSurvival(), 'month', CARD_NOW).days).toBe(30);
    const year = cardOf(cardStore(), cardSurvival(), 'year', CARD_NOW);
    expect(year.days).toBe(365);
    expect(year.sessions).toBe(4);
    expect(year.cost?.usd).toBe(100.75);
  });

  it('prints a share under the books floor as too few and a share at it as a percent', () => {
    const text = cardText(week(), 'ashore: run oars pool login');
    expect(text).toContain('verified after edit  75% (30 of 40 edits)');
    expect(text).toContain('moved on             too few (2 of 4 crabs)');
    expect(text).toContain('survived             too few (1 of 1 settled)');
  });

  it('prints cost only where the harness recorded one, and says so when none did', () => {
    expect(cardText(week(), 'x')).toContain('cost                 $1.75 (2 of 3 sessions recorded one)');
    const none = cardStore();
    for (const session of none.sessions) session.costUsd = null;
    expect(cardText(cardOf(none, cardSurvival(), 'week', CARD_NOW), 'x')).toContain('cost                 not recorded by these harnesses');
  });

  it('is zeros over an empty store, with no model, harness, or cost', () => {
    const card = cardOf(emptyStore({}), new Map(), 'week', CARD_NOW);
    expect(card).toMatchObject({ sessions: 0, activeDays: 0, harnesses: [], models: [], strokes: 0, crabs: 0, commits: 0, cost: { usd: null, recorded: 0, of: 0 } });
    expect(card.verifyAfterEdit).toEqual({ count: 0, of: 0, share: null });
  });

  it.each([['week', 7], ['month', 30], ['year', 365]] as const)('reads the %s as the last %i whole UTC dates ending today, one session per date', (period, days) => {
    // One session per UTC date, from days + 1 dates back through today, at noon: the oldest falls one date outside the window.
    const noon = Date.parse('2026-11-09T12:00:00Z');
    const dates = Array.from({ length: days + 1 }, (_, index) => new Date(noon - index * 86_400_000).toISOString());
    const crowded = emptyStore({
      sessions: dates.map((_, index) => session(`s-${String(index)}`)),
      prompts: dates.map((ts, index) => prompt(`s-${String(index)}`, 0, { ts })),
    });
    const card = cardOf(crowded, new Map(), period, CARD_NOW);
    expect(card.activeDays).toBe(days);
    expect(card.sessions).toBe(days);
  });

  it('starts the window at 00:00 UTC of the oldest date, keeping a prompt just after it and dropping one just before', () => {
    const crowded = emptyStore({
      sessions: [session('in'), session('out')],
      prompts: [prompt('in', 0, { ts: '2026-10-11T00:00:00.000Z' }), prompt('out', 0, { ts: '2026-10-10T23:59:59.999Z' })],
    });
    const card = cardOf(crowded, new Map(), 'month', CARD_NOW);
    expect(card).toMatchObject({ sessions: 1, activeDays: 1 });
  });

  it('puts the window at seven, thirty, and 365 days back from now', () => {
    expect(cardWindow('week', CARD_NOW)).toEqual({ days: 7, end: '2026-11-09' });
    expect(cardWindow('year', CARD_NOW).days).toBe(365);
  });
});

describe('what the card never carries', () => {
  const outputs = (): string[] => {
    const card = week();
    return [JSON.stringify(card), cardText(card, 'ashore: run oars pool login'), tweetLink(card), decodeURIComponent(tweetLink(card))];
  };

  it.each(Object.entries(PLANTED))('finds no %s in the card, the text table, or the link', (_kind, planted) => {
    for (const output of outputs()) expect(output).not.toContain(planted);
  });

  it('finds no folder slug, user name, or path separator from the fixture', () => {
    for (const output of outputs()) {
      expect(output).not.toMatch(/alice|secret|C--|sk-live/);
    }
  });
});

describe('tweetLink', () => {
  it('is one x.com intent link holding text only', () => {
    const link = tweetLink(week());
    const url = new URL(link);
    expect(url.origin + url.pathname).toBe('https://x.com/intent/tweet');
    expect([...url.searchParams.keys()]).toEqual(['text']);
    const text = url.searchParams.get('text') ?? '';
    expect(text).toContain('3 sessions');
    expect(text).toContain('13 strokes');
    expect(text).toContain('npx @manyoars/oars card');
    expect(text).toContain('manyoars.com');
    expect(text.length).toBeLessThanOrEqual(280);
  });
});
