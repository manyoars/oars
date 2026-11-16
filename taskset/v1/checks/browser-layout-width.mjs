// browser-layout-width: reads public/style.css, applies the rules that match the .layout grid at a 600 px and at a 1280 px
// window (later rule wins; @media min-width, max-width, and range conditions like (width <= 720px), in px, rem, or em), and works
// out the narrowest width the grid needs, reading a % track as a share of the window less the body padding. At 600 px it must fit
// in the window less the body padding; at 1280 px its columns must still resolve to two 340 px columns with a 24 px gap, whatever
// way they are written. It is a stylesheet reader, not a layout engine: it understands px, rem, em, and % tracks, fr, auto, minmax, and repeat, and a grid or
// a wrapping flex container; anything else fails with a message. Wrong neighbor: hiding the overflow (`body { overflow-x: hidden }`),
// which leaves the grid exactly as wide as before.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, expect, fail } from './_shared.mjs';

const BODY_PADDING = 32; // style.css: body { padding: 16px }
const ORIGINAL = { widths: [340, 340], gap: 24 };
const REM = 16; // the browser default root and body font size; style.css sets neither

/** A length in px, rem, or em (16 px each), or a bare 0, as px; null for anything else. */
const lengthPx = (text) => {
  const match = /^(-?\d+(?:\.\d+)?|-?\.\d+)(px|rem|em)?$/.exec(text.trim());
  if (!match) return null;
  const unit = match[2];
  if (unit === undefined) return Number(match[1]) === 0 ? 0 : null;
  return Number(match[1]) * (unit === 'px' ? 1 : REM);
};

/** One media condition in parentheses, as [kind, px] pairs: (min-width: 30em), (width <= 720px), (400px <= width < 720px). */
const conditionOf = (inner) => {
  const feature = /^(min|max)-width\s*:\s*(\S+)$/.exec(inner.trim());
  if (feature) {
    const value = lengthPx(feature[2]);
    return value === null ? [['never', 0]] : [[feature[1], value]];
  }
  const range = /^(?:(\S+)\s*(<=?|>=?)\s*)?width(?:\s*(<=?|>=?|=)\s*(\S+))?$/.exec(inner.trim());
  if (!range || (range[1] === undefined && range[3] === undefined)) return [];
  const out = [];
  const edge = (kind, text, strict) => {
    const value = lengthPx(text);
    if (value === null) return out.push(['never', 0]);
    // A strict bound sits just inside the edge, so < 720px and <= 720px differ at exactly 720 only.
    return out.push([kind, kind === 'max' ? value - (strict ? 0.01 : 0) : value + (strict ? 0.01 : 0)]);
  };
  if (range[1] !== undefined) edge(range[2].startsWith('<') ? 'min' : 'max', range[1], range[2].length === 1);
  if (range[3] !== undefined) {
    if (range[3] === '=') {
      edge('min', range[4], false);
      edge('max', range[4], false);
    } else {
      edge(range[3].startsWith('<') ? 'max' : 'min', range[4], range[3].length === 1);
    }
  }
  return out;
};

/** `@media not all and (min-width: 721px)`: its one condition inverted. Anything bigger under `not` stays unreadable (never applies). */
const negated = (head, conditions) => {
  if (!/^@media\s+not\b/i.test(head)) return conditions;
  if (conditions.length !== 1 || conditions[0][0] === 'never') return [['never', 0]];
  const [kind, value] = conditions[0];
  return [kind === 'min' ? ['max', value - 0.01] : ['min', value + 0.01]];
};

/** Rules in source order: { media: [[min, max]...], selectors, decls: [[property, value]...] }. */
const parse = (css) => {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  const read = (from, media) => {
    let i = from;
    while (i < text.length) {
      const open = text.indexOf('{', i);
      const close = text.indexOf('}', i);
      if (close !== -1 && (open === -1 || close < open)) return close + 1;
      if (open === -1) return text.length;
      const head = text.slice(i, open).trim();
      if (head.startsWith('@media')) {
        const conditions = negated(head, [...head.matchAll(/\(([^()]*)\)/g)].flatMap((m) => conditionOf(m[1])));
        i = read(open + 1, [...media, ...conditions, ...(conditions.length === 0 ? [['never', 0]] : [])]);
      } else {
        const end = text.indexOf('}', open);
        const decls = text
          .slice(open + 1, end)
          .split(';')
          .map((d) => d.split(/:(.*)/s))
          .filter((d) => d.length > 1)
          .map(([name, value]) => [name.trim().toLowerCase(), value.trim().replace(/\s*!important$/, '')]);
        rules.push({ media, selectors: head.split(',').map((s) => s.trim()), decls });
        i = end + 1;
      }
    }
    return i;
  };
  read(0, []);
  return rules;
};

const applies = (media, width) => media.every(([kind, px]) => (kind === 'min' ? width >= px : kind === 'max' ? width <= px : false));

const ANCESTORS = /^(?:(?:html|body)\s+)+/i;
const nameOf = (s) => s.replace(ANCESTORS, '').replace(/^[a-z]+(?=\.)/, '');
/** Type selectors in front of the class (`body .layout`, `div.layout`): each makes the rule win over a plainer one, order aside. */
const typeCount = (s) => (ANCESTORS.exec(s)?.[0].trim().split(/\s+/).length ?? 0) + (/^[a-z]+(?=\.)/.test(s.replace(ANCESTORS, '')) ? 1 : 0);

/** The value each property of `selector` has at `width`; `tag.class` counts as the class, and `body .layout` (a descendant of body or html) too. */
const styleOf = (rules, selector, width) => {
  const style = {};
  const hits = [];
  for (const rule of rules) {
    if (!applies(rule.media, width)) continue;
    const found = rule.selectors.filter((s) => nameOf(s) === selector);
    if (found.length > 0) hits.push({ weight: Math.max(...found.map(typeCount)), decls: rule.decls });
  }
  // Stable: a rule with more type selectors wins over an earlier or later plainer one; equal weight, the later rule wins.
  for (const hit of hits.sort((a, b) => a.weight - b.weight)) for (const [name, value] of hit.decls) style[name] = value;
  return style;
};

const tokens = (value) => {
  const out = [];
  let depth = 0;
  let current = '';
  for (const char of value.trim()) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (/\s/.test(char) && depth === 0) {
      if (current) out.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (current) out.push(current);
  return out;
};

const splitArgs = (inner) => {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const char of inner) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  parts.push(current.trim());
  return parts;
};

/** `repeat(<whole number>, ...)` expanded; every other token kept. */
const expandTracks = (value) =>
  tokens(value).flatMap((token) => {
    const repeat = /^repeat\((.*)\)$/s.exec(token);
    if (!repeat) return [token];
    const [count, list] = splitArgs(repeat[1]);
    return /^\d+$/.test(count) ? Array.from({ length: Number(count) }, () => tokens(list)).flat() : [token];
  });

const px = lengthPx;

/** A length in px, rem, em, or % (of `available`, the container's width), as px; null when it is none of these. */
const sized = (text, available) => {
  const percent = /^(\d+(?:\.\d+)?)%$/.exec(text.trim());
  return percent ? (Number(percent[1]) / 100) * available : lengthPx(text);
};

/** The narrowest width a track can have in a container `available` px wide: its minimum length, else 0. */
const minTrack = (token, available) => {
  const fixed = sized(token, available);
  if (fixed !== null) return fixed;
  if (/^(\d+(\.\d+)?fr|auto|min-content|max-content)$/.test(token)) return 0;
  const minmax = /^minmax\((.*)\)$/s.exec(token);
  if (minmax) return sized(splitArgs(minmax[1])[0], available) ?? 0;
  return fail(`cannot read the grid track ${token}`);
};

/** The width a track takes when the container has room to spare: its length, or a minmax's maximum; null for fr, auto, and the like. */
const roomyTrack = (token, available) => {
  const fixed = sized(token, available);
  if (fixed !== null) return fixed;
  const minmax = /^minmax\((.*)\)$/s.exec(token);
  if (!minmax) return null;
  const [low, high] = splitArgs(minmax[1]);
  const top = sized(high, available);
  return top === null ? null : Math.max(top, sized(low, available) ?? 0);
};

const gapOf = (style) => {
  const value = style['column-gap'] ?? style['grid-column-gap'] ?? style.gap ?? style['grid-gap'];
  if (value === undefined) return 0;
  const first = tokens(value).at(-1);
  const gap = px(first) ?? (first === '0' ? 0 : null);
  return gap ?? fail(`cannot read the gap ${value}`);
};

/**
 * What `repeat(auto-fit | auto-fill, <length>)` gives the page's two panels in a container `available` px wide: as many tracks of
 * that length as fit, the panels taking the first two (an empty track holds no panel). null for a track that is not a fixed length.
 */
const autoTracks = (track, available, gap) => {
  const fixed = sized(track, available);
  if (fixed === null || fixed <= 0) return null;
  const fit = Math.max(1, Math.floor((available + gap) / (fixed + gap)));
  return Array.from({ length: Math.min(fit, ORIGINAL.widths.length) }, () => fixed);
};

/** The narrowest width .layout needs, and the track list it uses, at `width`. */
const layoutAt = (rules, width) => {
  const style = styleOf(rules, '.layout', width);
  const display = style.display ?? 'block';
  if (display === 'flex') {
    expect((style['flex-wrap'] ?? 'nowrap') !== 'nowrap', `at ${width} px .layout is a flex row that does not wrap`);
    return { needs: 0, columns: 'flex-wrap' };
  }
  if (display !== 'grid') return { needs: 0, columns: display };
  const tracks = expandTracks(style['grid-template-columns'] ?? '1fr');
  const auto = tracks.length === 1 && /^repeat\(auto-(fit|fill),/.test(tracks[0]);
  const columns = auto ? [tracks[0].replace(/^repeat\(auto-(fit|fill),\s*/, '').replace(/\)$/, '')] : tracks;
  const available = width - BODY_PADDING;
  const widths = columns.map((token) => (auto ? minTrack(token.trim(), available) : minTrack(token, available)));
  const gaps = auto ? 0 : (columns.length - 1) * gapOf(style);
  const gap = gapOf(style);
  const resolved = auto ? autoTracks(columns[0].trim(), available, gap) : columns.map((token) => roomyTrack(token, available));
  return { needs: widths.reduce((sum, w) => sum + w, 0) + gaps, columns: tracks.join(' '), gap, resolved };
};

await check('browser-layout-width', async (run) => {
  const rules = parse(readFileSync(join(run, 'public', 'style.css'), 'utf8'));
  for (const width of [600, 1280]) {
    const panel = styleOf(rules, '.panel', width);
    for (const name of ['width', 'min-width']) {
      const fixed = px(panel[name] ?? '');
      expect(fixed === null || fixed <= width - BODY_PADDING, `at ${width} px .panel has ${name} ${panel[name]}`);
    }
  }
  const narrow = layoutAt(rules, 600);
  expect(narrow.needs <= 600 - BODY_PADDING, `at 600 px the panels need ${narrow.needs} px, the window has ${600 - BODY_PADDING} px to give`);
  const wide = layoutAt(rules, 1280);
  const same =
    wide.resolved !== null &&
    wide.resolved.length === ORIGINAL.widths.length &&
    wide.resolved.every((w, index) => w !== null && Math.abs(w - ORIGINAL.widths[index]) < 0.5) &&
    wide.gap === ORIGINAL.gap;
  expect(same, `at 1280 px the grid is "${wide.columns}" with gap ${wide.gap}, it was two ${ORIGINAL.widths[0]} px columns with gap ${ORIGINAL.gap}`);
  return `needs ${narrow.needs} px at 600, unchanged at 1280`;
});
