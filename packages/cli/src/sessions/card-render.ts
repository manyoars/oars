// The crew card as a picture. `cardSvg` writes the SVG; `rasterize` reads back that SVG (the rects and monospace text this file writes, nothing else) into pixels, and
// `encodePng` writes them as a PNG. No renderer dependency: the one on offer (resvg) is MPL-2.0, which `check-licenses` refuses, and the card's picture is only
// rects and text. Both outputs are byte-stable for one card. The names on it are plain text as the session recorded them, with no vendor logo.
import { deflateSync } from 'node:zlib';
import { CARD_COMMAND, CARD_SITE, cardRows, cardTitle, type Card } from './card.js';
import { GLYPH_HEIGHT, GLYPH_WIDTH, lit } from './card-font.js';

const WIDTH = 1200;
const MARGIN = 48;
const TOP = 140;
const PITCH = 36;
const FONT = 20;
const TITLE_FONT = 30;
const VALUE_X = 308;
/** The widest value line, in characters, that fits between VALUE_X and the right margin. */
const WRAP = 68;
const BACKGROUND = '0b1b2b';
const INK = 'e8eef4';
const MUTED = '8fa6ba';
const ACCENT = 'f2b134';

/** A glyph cell is one column wider than the glyph, so a monospace font of size N has this advance at N / 10 pixels per font pixel: 0.6 em. */
const advance = (font: number): number => ((GLYPH_WIDTH + 1) * font) / 10;

const escape = (text: string): string => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const unescape = (text: string): string => text.replaceAll('&quot;', '"').replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&amp;', '&');

/** A value split at its commas into lines of at most `WRAP` characters; a part longer than that stays whole. */
const wrap = (value: string): string[] => {
  const lines: string[] = [];
  for (const part of value.split(', ')) {
    const last = lines.length - 1;
    if (last >= 0 && `${lines[last] ?? ''}, ${part}`.length < WRAP) lines[last] = `${lines[last] ?? ''}, ${part}`;
    else lines.push(part);
  }
  return lines.map((line, index) => (index < lines.length - 1 ? `${line},` : line));
};

const text = (x: number, y: number, font: number, fill: string, body: string): string => `<text x="${String(x)}" y="${String(y)}" font-family="monospace" font-size="${String(font)}" fill="#${fill}">${escape(body)}</text>`;
const rect = (x: number, y: number, width: number, height: number, fill: string): string => `<rect x="${String(x)}" y="${String(y)}" width="${String(width)}" height="${String(height)}" fill="#${fill}"/>`;

export const cardSvg = (card: Card, depositor: string): string => {
  const body: string[] = [];
  let y = TOP;
  let previous = '';
  for (const row of cardRows(card, depositor)) {
    wrap(row.value).forEach((line, index) => {
      // A repeated label (one `tokens` row for each model) prints once.
      if (index === 0 && row.label !== previous) body.push(text(MARGIN, y, FONT, MUTED, row.label));
      body.push(text(VALUE_X, y, FONT, INK, line));
      y += PITCH;
    });
    previous = row.label;
  }
  const height = y + 20 + 60;
  const footerY = height - 30;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${String(WIDTH)}" height="${String(height)}" viewBox="0 0 ${String(WIDTH)} ${String(height)}">`,
    rect(0, 0, WIDTH, height, BACKGROUND),
    text(MARGIN, 72, TITLE_FONT, INK, cardTitle(card)),
    rect(MARGIN, 96, WIDTH - 2 * MARGIN, 2, ACCENT),
    ...body,
    rect(MARGIN, height - 70, WIDTH - 2 * MARGIN, 1, MUTED),
    text(MARGIN, footerY, FONT, ACCENT, CARD_SITE),
    text(WIDTH - MARGIN - Math.round(advance(FONT) * CARD_COMMAND.length), footerY, FONT, ACCENT, CARD_COMMAND),
    '</svg>',
    '',
  ].join('\n');
};

export interface Raster {
  width: number;
  height: number;
  /** 8-bit RGB, row by row. */
  rgb: Buffer;
}

const colorOf = (hex: string): [number, number, number] => [Number.parseInt(hex.slice(0, 2), 16), Number.parseInt(hex.slice(2, 4), 16), Number.parseInt(hex.slice(4, 6), 16)];

const SHAPE =
  /<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)" fill="#([0-9a-f]{6})"\/>|<text x="(\d+)" y="(\d+)" font-family="monospace" font-size="(\d+)" fill="#([0-9a-f]{6})">([^<]*)<\/text>/g;

/** Pixels for the SVG `cardSvg` writes: rects and monospace text in document order, a text's font size a whole multiple of ten. */
export const rasterize = (svg: string): Raster => {
  const size = /<svg [^>]*width="(\d+)" height="(\d+)"/.exec(svg);
  if (size === null) throw new Error('The card SVG has no size.');
  const width = Number(size[1]);
  const height = Number(size[2]);
  const rgb = Buffer.alloc(width * height * 3);
  const paint = (x: number, y: number, color: readonly [number, number, number]): void => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    rgb.set(color, (y * width + x) * 3);
  };
  for (const match of svg.matchAll(SHAPE)) {
    if (match[1] !== undefined) {
      const [x, y, w, h] = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])];
      const color = colorOf(match[5] ?? '');
      for (let row = y; row < y + h; row += 1) for (let column = x; column < x + w; column += 1) paint(column, row, color);
      continue;
    }
    const [x, baseline, font] = [Number(match[6]), Number(match[7]), Number(match[8])];
    if (font % 10 !== 0) throw new Error(`The card SVG has a font size of ${String(font)}; the picture takes a multiple of 10.`);
    const scale = font / 10;
    const color = colorOf(match[9] ?? '');
    Array.from(unescape(match[10] ?? '')).forEach((char, index) => {
      for (let column = 0; column < GLYPH_WIDTH; column += 1) {
        for (let row = 0; row < GLYPH_HEIGHT; row += 1) {
          if (!lit(char, column, row)) continue;
          for (let dy = 0; dy < scale; dy += 1) for (let dx = 0; dx < scale; dx += 1) paint(x + (index * (GLYPH_WIDTH + 1) + column) * scale + dx, baseline - (GLYPH_HEIGHT - 1) * scale + row * scale + dy, color);
        }
      }
    });
  }
  return { width, height, rgb };
};

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let bit = 0; bit < 8; bit += 1) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

const crc32 = (bytes: Buffer): number => {
  let c = 0xffffffff;
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type: string, data: Buffer): Buffer => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
};

/** An 8-bit RGB PNG, unfiltered rows, zlib at level 9 (deterministic for one input). */
export const encodePng = (width: number, height: number, rgb: Buffer): Buffer => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let row = 0; row < height; row += 1) rgb.copy(raw, row * (stride + 1) + 1, row * stride, (row + 1) * stride);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
};

/** The PNG for an SVG `cardSvg` wrote. */
export const cardPng = (svg: string): Buffer => {
  const { width, height, rgb } = rasterize(svg);
  return encodePng(width, height, rgb);
};
