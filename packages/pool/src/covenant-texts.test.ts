// The held covenant: the version proves the text, the held text is the published file, and the screen is the acceptance block the covenant states.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { screenOf, sha256Of } from './covenant.js';
import { COVENANT_FULL_TEXTS, COVENANT_TEXTS } from './covenant-texts.js';

const PLACEHOLDER = '**Version:** `<the COVENANT_VERSION value, set at publication>`.';

const [version, full] = [...COVENANT_FULL_TEXTS.entries()].find(([key]) => key.startsWith('2.0-')) ?? ['', ''];
const held = COVENANT_TEXTS.get(version) ?? '';
const published = readFileSync(fileURLToPath(new URL(`../../../docs/covenant/${version}.md`, import.meta.url)), 'utf8');

describe('the held covenant', () => {
  it('holds exactly one 2.0 text', () => {
    expect([...COVENANT_FULL_TEXTS.keys()].filter((key) => key.startsWith('2.0-'))).toEqual([version]);
    expect([...COVENANT_TEXTS.keys()]).toEqual([...COVENANT_FULL_TEXTS.keys()]);
    expect(version).toMatch(/^2\.0-[0-9a-f]{12}$/u);
  });

  it('is named by the hash of the published text with the Version line holding its placeholder', () => {
    const versionLine = `**Version:** \`${version}\`.`;
    expect(published.split('\n').filter((line) => line === versionLine)).toHaveLength(1);
    const bare = published.replace(versionLine, PLACEHOLDER);
    expect(bare).not.toBe(published);
    expect(`2.0-${sha256Of(bare).slice(0, 12)}`).toBe(version);
  });

  it('holds the published file as its full text, byte for byte', () => {
    expect(full).toBe(published);
  });

  it('holds the published file as its full text, byte for byte', () => {
    expect(full).toBe(published);
  });

  it('keeps the published file as a text with LF endings and no draft marks', () => {
    expect(published).not.toContain('\r');
    expect(published.endsWith('\n')).toBe(true);
    expect(published.startsWith('# Many Oars Co. Contributor Covenant and Data License, version 2\n')).toBe(true);
    expect(published).not.toMatch(/DRAFT|Part D/u);
  });

  it('has no unfilled placeholder in the published file', () => {
    expect(published).not.toContain('<the COVENANT_VERSION');
    expect(published).not.toContain('<version>');
  });

  it('serves a screen of Part A and the acceptance block, with the link and phrase', () => {
    const screen = screenOf(version, COVENANT_TEXTS);
    expect(screen).not.toBeNull();
    expect(screen?.link).toBe(`https://manyoars.com/covenant/${version}`);
    expect(screen?.phrase).toBe('I AGREE');
    expect(screen?.sha256).toBe(sha256Of(held));
    expect(held).not.toContain('<version>');
  });

  it('opens with the published Part A and ends with the acceptance block word for word', () => {
    const partA = published.slice(published.indexOf('## Part A.'), published.indexOf('## Part B.')).trimEnd();
    expect(held.startsWith(`${partA}\n\nMANY OARS POOL COVENANT ${version}\n`)).toBe(true);
    expect(held.slice(partA.length + 2).split('\n')).toEqual([
      `MANY OARS POOL COVENANT ${version}`,
      '',
      'Many Oars Co. may SELL what you deposit and may use it to TRAIN AI MODELS.',
      'Anyone it sells or licenses it to may do the same. You are not paid.',
      'You cannot take a deposit back: opting out stops future deposits only.',
      'If the GDPR or the UK GDPR protects you, you may object to use of your personal data, and',
      'ask to see, correct, or erase your data. See Section 6.6.',
      "You promise you have the right to deposit, including your employer's permission,",
      'and that you are responsible for meeting the terms of the AI tools you used.',
      'Disputes go to individual binding arbitration. No class actions.',
      '',
      `Full text: https://manyoars.com/covenant/${version}`,
      '',
      'You must be 18 or older. To accept, intending to be legally bound, type: I AGREE',
    ]);
  });
});
