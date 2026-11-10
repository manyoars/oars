// The held covenants: each version proves its text, the held text is the published file, and the screen is the acceptance block the covenant states.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { screenOf, sha256Of } from './covenant.js';
import { COVENANT_FULL_TEXTS, COVENANT_TEXTS, COVENANT_VERSION_2, COVENANT_VERSION_2_1 } from './covenant-texts.js';

const PLACEHOLDER = '**Version:** `<the COVENANT_VERSION value, set at publication>`.';

const published = (version: string): string => readFileSync(fileURLToPath(new URL(`../../../docs/covenant/${version}.md`, import.meta.url)), 'utf8');
const flat = (text: string): string => text.replace(/\s+/gu, ' ');
const clause = (version: string, number: string, next: string): string => flat(published(version)).split(`**${number} `)[1]?.split(`**${next} `)[0] ?? '';

describe('the covenant versions held', () => {
  it('holds 2.0 as filed and 2.1 after it, each under its own id', () => {
    expect([...COVENANT_FULL_TEXTS.keys()]).toEqual(['2.0-4c538c50d706', '2.1-ec0ca3f6ff73']);
    expect([...COVENANT_TEXTS.keys()]).toEqual([...COVENANT_FULL_TEXTS.keys()]);
    expect(COVENANT_VERSION_2).toBe('2.0-4c538c50d706');
    expect(COVENANT_VERSION_2_1).toBe('2.1-ec0ca3f6ff73');
  });

  it('serves 2.1 with its id, its link, and the hash of the screen it shows', () => {
    const screen = screenOf(COVENANT_VERSION_2_1, COVENANT_TEXTS);
    expect(screen?.link).toBe('https://manyoars.com/covenant/2.1-ec0ca3f6ff73');
    expect(screen?.sha256).toBe(sha256Of(COVENANT_TEXTS.get(COVENANT_VERSION_2_1) ?? ''));
    expect(screen?.text).toContain('MANY OARS POOL COVENANT 2.1-ec0ca3f6ff73\n');
    expect(screen?.text).not.toContain('2.0-4c538c50d706');
  });

  it('says in 6.4 what erase.ts does, and 2.0 still says what it said', () => {
    const now = clause(COVENANT_VERSION_2_1, '6.4', '6.5');
    expect(now).toContain("It deletes the account's Raw Copies, repository keys, deposit hours, and contributor records");
    expect(now).toContain('It keeps each Deposit, and the record of each machine enrolled under the account, only as an anonymous shape that is no longer tied to the account');
    expect(now).toContain('the acceptance and sign-in records of the account; the telemetry day counts, with the account removed from them; and a hash, size, and date of what was erased');
    expect(now).not.toContain('its repository keys and deposit hours');
    const was = clause(COVENANT_VERSION_2, '6.4', '6.5');
    expect(was).toContain("It replaces the account's deposit records with a marker, deletes the account's Raw Copies");
    expect(was).toContain('its repository keys and deposit hours; its telemetry day counts');
  });

  it('changes only 6.4, 6.6(d), and the Version line: every other line of 2.1 is a line of 2.0', () => {
    const before = published(COVENANT_VERSION_2).split('\n');
    const changed = published(COVENANT_VERSION_2_1).split('\n').filter((line) => !before.includes(line));
    expect(changed).toHaveLength(11);
    expect(changed[0]).toBe(`**Version:** \`${COVENANT_VERSION_2_1}\`.`);
    expect(published(COVENANT_VERSION_2_1)).toContain('Many Oars Co. may sell what you deposit');
  });
});

describe.each([...COVENANT_FULL_TEXTS.entries()])('the held covenant %s', (version, full) => {
  const held = COVENANT_TEXTS.get(version) ?? '';
  const file = published(version);
  const series = version.slice(0, 4);

  it('is named by the hash of the published text with the Version line holding its placeholder', () => {
    expect(version).toMatch(/^2\.[01]-[0-9a-f]{12}$/u);
    const versionLine = `**Version:** \`${version}\`.`;
    expect(file.split('\n').filter((line) => line === versionLine)).toHaveLength(1);
    const bare = file.replace(versionLine, PLACEHOLDER);
    expect(bare).not.toBe(file);
    expect(`${series}${sha256Of(bare).slice(0, 12)}`).toBe(version);
  });

  it('holds the published file as its full text, byte for byte', () => {
    expect(full).toBe(file);
  });

  it('keeps the published file as a text with LF endings and no draft marks', () => {
    expect(file).not.toContain('\r');
    expect(file.endsWith('\n')).toBe(true);
    expect(file.startsWith('# Many Oars Co. Contributor Covenant and Data License, version 2\n')).toBe(true);
    expect(file).not.toMatch(/DRAFT|Part D/u);
  });

  it('has no unfilled placeholder in the published file', () => {
    expect(file).not.toContain('<the COVENANT_VERSION');
    expect(file).not.toContain('<version>');
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
    const partA = file.slice(file.indexOf('## Part A.'), file.indexOf('## Part B.')).trimEnd();
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
