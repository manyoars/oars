// Brief 2 of docs/pool-deposit-title.md section 5: `sample-pack --deposits`. Fixtures only: no real store, no network, and every folder is a temp one.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { redactTranscript } from '../../cli/src/sessions/redact.js';
import { deposit, loadStore, paths, type SessionsRuntime } from '../../cli/src/sessions/store.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SESSION = '11111111-1111-4111-8111-111111111111';
const line = (value: object): string => JSON.stringify(value);
const at = (n: number): string => `2026-06-01T10:00:${String(n).padStart(2, '0')}.000Z`;
// What a depositor's machine holds before `oars pool deposit` redacts it: an email address, a home path, and a key-shaped value.
const SECRET = 'AKIAIOSFODNN7EXAMPLE';
const original = (): string =>
  [
    line({ type: 'user', uuid: '11111111-b001-4222-8222-222222222222', parentUuid: null, isSidechain: false, timestamp: at(1), version: '2.1.300', sessionId: SESSION, cwd: '/home/dana/work/app', message: { role: 'user', content: `mail dana@example.com about ${SECRET}` } }),
    line({ type: 'assistant', uuid: '11111111-a001-4222-8222-222222222222', parentUuid: '11111111-b001-4222-8222-222222222222', isSidechain: false, timestamp: at(2), version: '2.1.300', sessionId: SESSION, requestId: 'req_011C11111111x1', message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 10, output_tokens: 20 } } }),
  ].join('\n') + '\n';

interface Folder {
  root: string;
  runtime: SessionsRuntime;
}

/** A pulled account folder as `pull-deposits` lays it out (`<account>/projects/deposit/<sha256>.jsonl`), and the throwaway store that captures it. */
const pulled = (text: string): Folder & { sha: string } => {
  const root = mkdtempSync(join(tmpdir(), 'oars-deposits-'));
  dirs.push(root);
  const sha = createHash('sha256').update(text).digest('hex');
  const projectsRoot = join(root, 'acct', 'projects');
  mkdirSync(join(projectsRoot, 'deposit'), { recursive: true });
  writeFileSync(join(projectsRoot, 'deposit', `${sha}.jsonl`), text);
  return { root, sha, runtime: { storeDir: join(root, 'store'), projectsRoot, sources: [], stdin: process.stdin, stdout: { write: () => true } } };
};

const captured = async (folder: Folder): Promise<Awaited<ReturnType<typeof loadStore>>> => {
  await deposit(folder.runtime, { allow: [], redactDomains: [], now: () => Date.parse('2026-06-10T00:00:00Z') });
  return loadStore(folder.runtime.storeDir);
};

describe('the two assumptions of the deposit input (docs/pool-deposit-title.md section 2)', () => {
  it('capture reads a redacted Raw Copy', async () => {
    const redacted = redactTranscript(original(), [], ['dana']);
    // The redactor ran: the address and the key are gone, so what is captured below is the redacted text and not the original.
    expect(redacted.masked).toBeGreaterThan(0);
    expect(redacted.text).not.toContain('dana@example.com');
    expect(redacted.text).not.toContain(SECRET);
    const folder = pulled(redacted.text);
    const store = await captured(folder);
    expect(store.sessions).toHaveLength(1);
    expect(store.sessions[0]).toMatchObject({ project: 'deposit', userTurns: 1, assistantTurns: 1, badLines: 0 });
    // The turns are those of the unredacted transcript: redaction costs capture nothing.
    const plain = await captured(pulled(original()));
    expect(store.sessions[0]).toMatchObject({ userTurns: plain.sessions[0]?.userTurns, assistantTurns: plain.sessions[0]?.assistantTurns, lines: plain.sessions[0]?.lines });
  });

  it('a captured line keeps sessionId, while the store names the session by the file', async () => {
    const redacted = redactTranscript(original(), [], ['dana']);
    const folder = pulled(redacted.text);
    const store = await captured(folder);
    // The store's session id is the file name, here the Raw Copy's hash: the harness id is not what names a pulled session, so the builder must read it from the line.
    expect(store.sessions[0]?.session).toBe(folder.sha);
    const archived = readFileSync(join(paths(folder.runtime.storeDir).raw, 'deposit', `${folder.sha}.jsonl`), 'utf8');
    const ids = archived.split('\n').filter((row) => row !== '').map((row) => (JSON.parse(row) as { sessionId?: unknown }).sessionId);
    expect(ids).toEqual([SESSION, SESSION]);
  });
});
