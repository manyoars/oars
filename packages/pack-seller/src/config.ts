import { readFileSync } from 'node:fs';

export interface Config {
  apiUrl: string;
  sdkKey: string;
  port: number;
}

/** A refused configuration: the message is one line that names the variable and never carries a value. */
export class ConfigError extends Error {}

export const ENV_API_URL = 'OARS_SELLER_API_URL';
export const ENV_SDK_KEY = 'OARS_SELLER_SDK_KEY';
export const ENV_SDK_KEY_FILE = 'OARS_SELLER_SDK_KEY_FILE';
export const ENV_PORT = 'OARS_SELLER_PORT';

type Env = Readonly<Record<string, string | undefined>>;

const present = (env: Env, name: string): string | undefined => {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
};

const need = (env: Env, name: string): string => {
  const value = present(env, name);
  if (value === undefined) throw new ConfigError(`${name} is not set.`);
  return value;
};

const sdkKey = (env: Env): string => {
  const file = present(env, ENV_SDK_KEY_FILE);
  if (file === undefined) return need(env, ENV_SDK_KEY);
  let text: string;
  try {
    text = readFileSync(file, 'utf8').trim();
  } catch {
    throw new ConfigError(`${ENV_SDK_KEY_FILE} names a file that cannot be read.`);
  }
  if (text === '') throw new ConfigError(`${ENV_SDK_KEY_FILE} names an empty file.`);
  return text;
};

/** Reads the whole configuration from the environment; throws a `ConfigError` naming the first variable that is missing or malformed. */
export const loadConfig = (env: Env): Config => {
  const apiUrl = need(env, ENV_API_URL);
  if (!URL.canParse(apiUrl)) throw new ConfigError(`${ENV_API_URL} is not a URL.`);
  const key = sdkKey(env);
  const port = Number(need(env, ENV_PORT));
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new ConfigError(`${ENV_PORT} is not a port number.`);
  return { apiUrl, sdkKey: key, port };
};
