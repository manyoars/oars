import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// CAPTURE_VERSION and EXTRACTOR_VERSION hold the same value today, so a plain assertion cannot tell which one stamps the skeleton.
vi.mock('./schema.js', async (importOriginal) => ({ ...(await importOriginal<object>()), EXTRACTOR_VERSION: 'derived-only' }));

const { captureSession } = await import('./extract.js');
const { makeRedactor } = await import('./redact.js');
const { CAPTURE_VERSION } = await import('./schema.js');
const { FIXTURES } = await import('./test-support.js');

describe('the skeleton stamp', () => {
  it('is CAPTURE_VERSION, not EXTRACTOR_VERSION', () => {
    const text = readFileSync(join(FIXTURES, 'proj', 'errors-a.jsonl'), 'utf8');
    const capture = captureSession({ text, session: 'errors-a', project: 'proj', rev: 1, at: '2026-06-10T00:00:00.000Z', bytes: text.length, redact: makeRedactor(), salt: 'salt' });
    expect(capture.skeleton.v).toBe(CAPTURE_VERSION);
    expect(capture.skeleton.v).not.toBe('derived-only');
  });
});
