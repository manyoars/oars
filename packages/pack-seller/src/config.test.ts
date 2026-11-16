import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, ENV_API_URL, ENV_HOST, ENV_PORT, ENV_SDK_KEY, ENV_SDK_KEY_FILE, loadConfig } from './config.js';
import { start } from './server.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const fileWith = (content: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'pack-seller-'));
  dirs.push(dir);
  const path = join(dir, 'key');
  writeFileSync(path, content);
  return path;
};

const SECRET = 'aorsk_file_secret';
const ok = { [ENV_API_URL]: 'https://api.test', [ENV_SDK_KEY]: 'aorsk_var', [ENV_PORT]: '8790' };

describe('loadConfig', () => {
  it('reads the url, the key from a variable, and the port', () => {
    expect(loadConfig(ok)).toEqual({ apiUrl: 'https://api.test', sdkKey: 'aorsk_var', port: 8790, host: '127.0.0.1' });
  });

  it('reads the key from a file, which wins over the variable', () => {
    expect(loadConfig({ ...ok, [ENV_SDK_KEY_FILE]: fileWith(`${SECRET}\n`) }).sdkKey).toBe(SECRET);
  });

  it('reads the host, and refuses a malformed one naming the variable', () => {
    expect(loadConfig({ ...ok, [ENV_HOST]: '0.0.0.0' }).host).toBe('0.0.0.0');
    expect(() => loadConfig({ ...ok, [ENV_HOST]: 'not a host' })).toThrow(new ConfigError(`${ENV_HOST} is not an IP address.`));
  });

  it.each([ENV_API_URL, ENV_SDK_KEY, ENV_PORT])('names %s when it is missing', (name) => {
    const env: Record<string, string | undefined> = { ...ok, [name]: undefined };
    expect(() => loadConfig(env)).toThrow(new ConfigError(`${name} is not set.`));
  });

  it('refuses a bad url, a bad port, an unreadable key file, and an empty one, naming the variable and never the value', () => {
    expect(() => loadConfig({ ...ok, [ENV_API_URL]: 'not a url' })).toThrow(`${ENV_API_URL} is not a URL.`);
    expect(() => loadConfig({ ...ok, [ENV_PORT]: 'eighty' })).toThrow(`${ENV_PORT} is not a port number.`);
    expect(() => loadConfig({ ...ok, [ENV_PORT]: '70000' })).toThrow(`${ENV_PORT} is not a port number.`);
    expect(() => loadConfig({ ...ok, [ENV_SDK_KEY_FILE]: join(tmpdir(), 'pack-seller-missing-file') })).toThrow(
      `${ENV_SDK_KEY_FILE} names a file that cannot be read.`,
    );
    expect(() => loadConfig({ ...ok, [ENV_SDK_KEY_FILE]: fileWith('  \n') })).toThrow(`${ENV_SDK_KEY_FILE} names an empty file.`);
  });
});

describe('start', () => {
  it('returns one line naming the missing variable and starts nothing', async () => {
    const started = await start({ [ENV_PORT]: '0' });
    expect(started).toEqual({ ok: false, line: `${ENV_API_URL} is not set.` });
  });

  it('listens on the port, answers /health, and closes', async () => {
    const started = await start({ ...ok, [ENV_PORT]: '0' }, { log: () => undefined });
    if (!started.ok) throw new Error(started.line);
    try {
      const response = await fetch(`http://127.0.0.1:${String(started.port)}/health`);
      expect(await response.json()).toEqual({ status: 'ok' });
      const offer = await fetch(`http://127.0.0.1:${String(started.port)}/packs/none/offer`, { method: 'POST', body: 'x'.repeat(9_000) });
      expect(offer.status).toBe(413);
    } finally {
      started.server.close();
    }
  });
});
