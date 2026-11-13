import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { cardOf } from './card.js';
import { CARD_NOW, cardStore, cardSurvival, PLANTED } from './card-fixture.js';
import { GLYPHS, lit } from './card-font.js';
import { cardPng, cardSvg, encodePng, rasterize } from './card-render.js';

const ASHORE = 'ashore: run oars pool join';
const svg = (): string => cardSvg(cardOf(cardStore(), cardSurvival(), 'week', CARD_NOW), ASHORE);

/** Width, height, and the RGB bytes of a PNG this module wrote (8-bit RGB, filter 0), decoded from its bytes alone. */
const decode = (png: Buffer): { width: number; height: number; rgb: Buffer } => {
  expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  expect(png.subarray(12, 16).toString('latin1')).toBe('IHDR');
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  expect([png[24], png[25]]).toEqual([8, 2]);
  const idat = png.indexOf('IDAT', 33, 'latin1');
  const raw = inflateSync(png.subarray(idat + 4, idat + 4 + png.readUInt32BE(idat - 4)));
  const rgb = Buffer.alloc(width * height * 3);
  for (let row = 0; row < height; row += 1) {
    expect(raw[row * (width * 3 + 1)]).toBe(0);
    raw.copy(rgb, row * width * 3, row * (width * 3 + 1) + 1, (row + 1) * (width * 3 + 1));
  }
  return { width, height, rgb };
};

describe('the font', () => {
  it('holds every printable ASCII character once, five columns each', () => {
    expect(GLYPHS).toHaveLength(95);
    for (const glyph of GLYPHS) expect(glyph).toHaveLength(5);
    expect(GLYPHS[0]).toEqual([0, 0, 0, 0, 0]);
  });

  it('draws an A (apex on the middle column, legs below) and no pixel for a space', () => {
    expect([lit('A', 0, 0), lit('A', 2, 0), lit('A', 0, 3)]).toEqual([false, true, true]);
    expect(lit(' ', 2, 3)).toBe(false);
    expect(lit('é', 2, 3)).toBe(lit('?', 2, 3));
  });
});

describe('cardSvg', () => {
  it('is byte-stable: the same card is the same bytes, and they match the kept snapshot', async () => {
    expect(svg()).toBe(svg());
    await expect(svg()).toMatchFileSnapshot('./fixtures/card-week.svg');
  });

  it('carries the site, the command, the depositor line, and plain-text names with no vendor logo or embedded image', () => {
    const picture = svg();
    for (const line of ['manyoars.com', 'npx @manyoars/oars card', ASHORE, 'claude-opus-5-5 40', 'gpt-5-codex 3', 'claude-code 1']) expect(picture).toContain(line);
    expect(picture).not.toMatch(/<image|<path|<use|<script|href=|data:/);
  });

  it('carries nothing planted in the store', () => {
    for (const planted of Object.values(PLANTED)) expect(svg()).not.toContain(planted);
  });

  it('escapes markup in a line it prints', () => {
    const picture = cardSvg(cardOf(cardStore(), cardSurvival(), 'week', CARD_NOW), 'a&b<c>"d"');
    expect(picture).toContain('a&amp;b&lt;c&gt;&quot;d&quot;');
  });

  it('wraps a value too long for the card onto continuation lines at a comma', () => {
    const card = cardOf(cardStore(), cardSurvival(), 'week', CARD_NOW);
    const long = { ...card, harnesses: ['claude-code', 'cursor', 'codex', 'copilot', 'gemini', 'grok', 'opencode', 'pi', 'vscode-copilot', 'otel'].map((name) => ({ name, sessions: 10 })) };
    const picture = cardSvg(long, ASHORE);
    expect(picture).toContain('otel 10');
    expect(Math.max(...[...picture.matchAll(/x="308" y="\d+"[^>]*>([^<]*)</g)].map((match) => (match[1] ?? '').length))).toBeLessThanOrEqual(68);
  });
});

describe('cardPng', () => {
  it('is a PNG whose size is the size the SVG states, with the card background in the corner and text pixels inside', () => {
    const picture = svg();
    const [, width, height] = /<svg [^>]*width="(\d+)" height="(\d+)"/.exec(picture) ?? [];
    const decoded = decode(cardPng(picture));
    expect([decoded.width, decoded.height]).toEqual([Number(width), Number(height)]);
    expect(decoded.width).toBe(1200);
    expect([...decoded.rgb.subarray(0, 3)]).toEqual([0x0b, 0x1b, 0x2b]);
    const background = Buffer.from([0x0b, 0x1b, 0x2b]);
    let other = 0;
    for (let index = 0; index < decoded.rgb.length; index += 3) if (!decoded.rgb.subarray(index, index + 3).equals(background)) other += 1;
    expect(other).toBeGreaterThan(5000);
  });

  it('is byte-stable', () => {
    expect(cardPng(svg()).equals(cardPng(svg()))).toBe(true);
  });
});

describe('rasterize', () => {
  const tiny = (body: string): string => `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30" viewBox="0 0 40 30">${body}</svg>`;

  it('paints rects in document order and a glyph at its baseline, scaled by the font size', () => {
    const { width, height, rgb } = rasterize(tiny('<rect x="0" y="0" width="40" height="30" fill="#000000"/><rect x="10" y="10" width="5" height="5" fill="#ff0000"/><text x="20" y="20" font-family="monospace" font-size="10" fill="#00ff00">|</text>'));
    expect([width, height]).toEqual([40, 30]);
    const at = (x: number, y: number): number[] => [...rgb.subarray((y * width + x) * 3, (y * width + x) * 3 + 3)];
    expect(at(0, 0)).toEqual([0, 0, 0]);
    expect(at(12, 12)).toEqual([255, 0, 0]);
    // '|' is the middle column (index 2) of the glyph, from the row at the baseline's top (y - 7) to its last row
    expect(at(22, 13)).toEqual([0, 255, 0]);
    expect(at(23, 13)).toEqual([0, 0, 0]);
  });

  it('refuses a size that is not a whole scale of the font', () => {
    expect(() => rasterize(tiny('<text x="1" y="9" font-family="monospace" font-size="15" fill="#ffffff">a</text>'))).toThrow('font size');
  });

  it('refuses an SVG with no size', () => {
    expect(() => rasterize('<svg></svg>')).toThrow('size');
  });
});

describe('encodePng', () => {
  it('writes an IEND chunk with a valid CRC after the pixels', () => {
    const png = encodePng(2, 1, Buffer.from([1, 2, 3, 4, 5, 6]));
    expect(png.subarray(png.length - 12, png.length - 8).readUInt32BE(0)).toBe(0);
    expect(png.subarray(png.length - 8, png.length - 4).toString('latin1')).toBe('IEND');
    expect(png.readUInt32BE(png.length - 4)).toBe(0xae426082);
  });
});
