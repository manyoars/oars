import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

/** What `oars login` keeps: the Keycloak refresh token and the platform access token the exchange returned for it. */
export interface StoredCredentials {
  issuerUrl: string;
  apiUrl: string;
  email: string;
  refreshToken: string;
  accessToken: string;
  /** When `accessToken` stops working (ISO 8601). */
  expiresAt: string;
}

export interface CredentialStore {
  /** Undefined when nobody is logged in, including when the file is unreadable as credentials. */
  read: () => Promise<StoredCredentials | undefined>;
  /** Replaces the file atomically, owner-only. */
  write: (credentials: StoredCredentials) => Promise<void>;
  delete: () => Promise<void>;
}

const hasString = <K extends string>(value: object, key: K): value is Record<K, string> => key in value && typeof Reflect.get(value, key) === 'string';

const isStoredCredentials = (value: unknown): value is StoredCredentials =>
  typeof value === 'object' &&
  value !== null &&
  hasString(value, 'issuerUrl') &&
  hasString(value, 'apiUrl') &&
  hasString(value, 'email') &&
  hasString(value, 'refreshToken') &&
  hasString(value, 'accessToken') &&
  hasString(value, 'expiresAt');

const isMissing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';

/** `%APPDATA%` on Windows (the user-profile ACL keeps it private), `$XDG_CONFIG_HOME` or `~/.config` elsewhere. */
export const defaultConfigDir = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): string => {
  if (platform === 'win32') return env.APPDATA ?? join(home, 'AppData', 'Roaming');
  return env.XDG_CONFIG_HOME ?? join(home, '.config');
};

/**
 * Keeps the credentials in `<dir>/oars/credentials.json`, mode 0600 (design §3.4). A write goes to a fresh sibling file, is
 * synced, then renamed over the old one, so a crash leaves either the old credentials or the new, never half of either.
 */
export const fileCredentialStore = (dir: string): CredentialStore => {
  const folder = join(dir, 'oars');
  const file = join(folder, 'credentials.json');
  return {
    read: async () => {
      let text: string;
      try {
        text = await readFile(file, 'utf8');
      } catch (error) {
        if (isMissing(error)) return undefined;
        throw error;
      }
      try {
        const parsed: unknown = JSON.parse(text);
        return isStoredCredentials(parsed) ? parsed : undefined;
      } catch {
        return undefined;
      }
    },
    write: async (credentials) => {
      await mkdir(folder, { recursive: true, mode: 0o700 });
      const temp = join(folder, `credentials.${randomUUID()}.tmp`);
      try {
        const handle = await open(temp, 'wx', 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(credentials, null, 2)}\n`);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temp, file);
      } catch (error) {
        await rm(temp, { force: true });
        throw error;
      }
    },
    delete: () => rm(file, { force: true }),
  };
};
