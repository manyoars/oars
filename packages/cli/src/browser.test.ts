import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openBrowser } from './browser.js';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn }));

/** A child process that reports a successful spawn on the next microtask, once the caller has listened. */
const spawned = () => {
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
  queueMicrotask(() => child.emit('spawn'));
  return child;
};

beforeEach(() => {
  spawn.mockReset();
  spawn.mockImplementation(spawned);
});

describe('openBrowser', () => {
  it.each(['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,<script>1</script>', 'ftp://example.com/x'])(
    'refuses %s before any process is spawned',
    async (url) => {
      await expect(openBrowser(url)).rejects.toThrow('Refusing to open');
      expect(spawn).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['win32', 'rundll32', ['url.dll,FileProtocolHandler']],
    ['darwin', 'open', []],
    ['linux', 'xdg-open', []],
  ] as const)('opens an https URL on %s with %s, the URL as one argument and no shell', async (platform, command, lead) => {
    const url = 'https://sso.test/device?user_code=ABCD&client_id=oars-cli';
    await openBrowser(url, platform);
    expect(spawn).toHaveBeenCalledExactlyOnceWith(command, [...lead, url], { stdio: 'ignore', detached: true });
  });

  it('opens an http URL (a local Keycloak)', async () => {
    await openBrowser('http://localhost:8180/realms/aor/device', 'linux');
    expect(spawn).toHaveBeenCalledOnce();
  });

  it('detaches the child so the CLI can exit while the browser stays open', async () => {
    const child = spawned();
    spawn.mockReturnValueOnce(child);
    await openBrowser('https://sso.test/device', 'linux');
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it('rejects with the spawn error when the opener is missing', async () => {
    const failure = new Error('spawn xdg-open ENOENT');
    spawn.mockImplementationOnce(() => {
      const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
      queueMicrotask(() => child.emit('error', failure));
      return child;
    });
    await expect(openBrowser('https://sso.test/device', 'linux')).rejects.toBe(failure);
  });
});
