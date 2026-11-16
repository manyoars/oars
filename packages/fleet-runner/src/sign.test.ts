import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { RunBook } from './runbook.js';
import { serializeRunBook } from './runbook.js';
import { main, signRunBook, verifyRunBook } from './sign.js';

const bookOf = (status: RunBook['header']['status']): string =>
  serializeRunBook({
    header: { orderId: 'o-1', line: 'retest', taskSetVersion: 'v1', manifestVersion: 'fleet-1', fixtureTag: 't', fixtureCommit: 'c', tools: [], arms: [], sides: [], operator: 'Many Oars Co.', repeats: 3, runCap: 9, startDate: '2026-11-16', endDate: '2026-11-16', status, shortCells: [] },
    runs: [],
  });

const IDENTITY = 'run-book@test.invalid';

// Makes a throwaway Ed25519 key in `dir` with the real ssh-keygen; a missing ssh-keygen fails the test with this message instead of skipping.
const makeKey = (dir: string): { key: string } => {
  const key = join(dir, 'key');
  const made = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', IDENTITY, '-f', key], { encoding: 'utf8' });
  if (made.error !== undefined) throw new Error(`ssh-keygen is required to run this test and was not found on PATH: ${made.error.message}`);
  if (made.status !== 0) throw new Error(`ssh-keygen could not make a key: ${made.stderr}`);
  return { key };
};

const withDir = async (body: (dir: string) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-sign-'));
  try {
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const allowedSignersOf = async (dir: string, key: string): Promise<string> => {
  const [type, material] = (await readFile(`${key}.pub`, 'utf8')).trim().split(' ');
  const file = join(dir, 'allowed_signers');
  await writeFile(file, `${IDENTITY} namespaces="manyoars-runbook" ${type ?? ''} ${material ?? ''}\n`);
  return file;
};

describe('signing a run book', () => {
  it('signs a complete run book, verifies it, and fails verify after one byte changes', async () => {
    await withDir(async (dir) => {
      const { key } = makeKey(dir);
      const allowed = await allowedSignersOf(dir, key);
      const book = join(dir, 'o-1.run-book.jsonl');
      await writeFile(book, bookOf('complete'));
      const signature = await signRunBook(book, key);
      expect(signature).toBe(`${book}.sig`);
      expect(await readFile(signature, 'utf8')).toMatch(/^-----BEGIN SSH SIGNATURE-----/);
      const verified = await verifyRunBook(book, allowed, IDENTITY);
      expect(verified.ok).toBe(true);
      expect(verified.message).toContain('Good');
      const bytes = await readFile(book);
      bytes[bytes.length - 3] = bytes[bytes.length - 3] === 0x30 ? 0x31 : 0x30;
      await writeFile(book, bytes);
      expect((await verifyRunBook(book, allowed, IDENTITY)).ok).toBe(false);
    });
  });

  it('refuses a run book whose header status is not complete, and writes no signature', async () => {
    await withDir(async (dir) => {
      const { key } = makeKey(dir);
      for (const status of ['incomplete', 'voided'] as const) {
        const book = join(dir, `${status}.jsonl`);
        await writeFile(book, bookOf(status));
        await expect(signRunBook(book, key)).rejects.toThrow(`run book status is ${status}, only a complete run book is signed`);
        await expect(readFile(`${book}.sig`)).rejects.toThrow();
      }
      const bad = join(dir, 'bad.jsonl');
      await writeFile(bad, 'not json\n');
      await expect(signRunBook(bad, key)).rejects.toThrow('run book header is not JSON');
    });
  });

  it('verify fails for a signer the allowed-signers file does not name, and names ssh-keygen when it cannot run', async () => {
    await withDir(async (dir) => {
      const { key } = makeKey(dir);
      const book = join(dir, 'o-1.run-book.jsonl');
      await writeFile(book, bookOf('complete'));
      await signRunBook(book, key);
      const other = join(dir, 'other');
      const made = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', other]);
      expect(made.status).toBe(0);
      const wrong = await allowedSignersOf(dir, other);
      expect((await verifyRunBook(book, wrong, IDENTITY)).ok).toBe(false);
      await expect(signRunBook(book, join(dir, 'missing-key'))).rejects.toThrow(/ssh-keygen/);
    });
  });

  it('runs as a command: sign then verify, with a message and exit code 2 for a bad call', async () => {
    await withDir(async (dir) => {
      const { key } = makeKey(dir);
      const allowed = await allowedSignersOf(dir, key);
      const book = join(dir, 'o-1.run-book.jsonl');
      await writeFile(book, bookOf('complete'));
      const lines: string[] = [];
      expect(await main(['sign', book, key], (line) => lines.push(line))).toBe(0);
      expect(lines.at(-1)).toBe(`signature: ${book}.sig`);
      expect(await main(['verify', book, allowed, IDENTITY], (line) => lines.push(line))).toBe(0);
      expect(lines.at(-1)).toMatch(/^verified: /);
      await writeFile(book, bookOf('incomplete'));
      expect(await main(['verify', book, allowed, IDENTITY], (line) => lines.push(line))).toBe(1);
      expect(await main(['sign', book], (line) => lines.push(line))).toBe(2);
      expect(lines.at(-1)).toMatch(/^usage: /);
      expect(await main(['sign', book, key], (line) => lines.push(line))).toBe(2);
      expect(lines.at(-1)).toMatch(/^sign: run book status is incomplete/);
    });
  });

  it('refuses to write a signature inside a git repository', async () => {
    await withDir(async (dir) => {
      const { key } = makeKey(dir);
      const inside = join(dirname(fileURLToPath(import.meta.url)), '..', '.guard-out', 'o-1.run-book.jsonl');
      await expect(signRunBook(inside, key)).rejects.toThrow(/inside a git repository/);
      expect(existsSync(`${inside}.sig`)).toBe(false);
    });
  });
});
