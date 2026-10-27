import { DEFAULT_API_URL } from '@manyoars/oars-client';

export class ConfigError extends Error {}

export interface Config {
  port: number;
  apiUrl: string;
  priceRefs: string[];
  /** Absent only when the dev flag selected the fake billing. */
  sdkKey?: string;
  fakeBilling: boolean;
  /** This agent's own public URL, no trailing slash: where Checkout returns the buyer. */
  publicUrl: string;
}

// Until the agent API can list an agent's own prices (request R1), the refs the starter template ships.
const STARTER_PRICE_REFS = ['calls-100', 'calls-1000'];

/** Fails closed: without AOR_SDK_KEY or OARS_PUBLIC_URL the server does not start, unless OARS_DEV_FAKE_BILLING is exactly `1`. */
export const loadConfig = (env: NodeJS.ProcessEnv): Config => {
  const fakeBilling = env['OARS_DEV_FAKE_BILLING'] === '1';
  const sdkKey = env['AOR_SDK_KEY']?.trim();
  if (!fakeBilling && (sdkKey === undefined || sdkKey === '')) {
    throw new ConfigError('AOR_SDK_KEY is not set; the platform injects it. For local development set OARS_DEV_FAKE_BILLING=1.');
  }
  const port = Number(env['PORT'] ?? '8080');
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new ConfigError(`PORT must be a port number, got "${env['PORT'] ?? ''}"`);
  const refs = (env['OARS_PRICE_REFS'] ?? '')
    .split(',')
    .map((ref) => ref.trim())
    .filter((ref) => ref !== '');
  const publicUrl = env['OARS_PUBLIC_URL']?.trim().replace(/\/+$/, '') ?? '';
  if (publicUrl === '' && !fakeBilling) {
    throw new ConfigError('OARS_PUBLIC_URL is not set; set it to the public https URL of this agent, where Checkout returns the buyer.');
  }
  if (publicUrl !== '' && !/^https?:\/\/[^\s?#]+$/.test(publicUrl)) {
    throw new ConfigError(`OARS_PUBLIC_URL must be an http(s) URL with no query or fragment, got "${publicUrl}"`);
  }
  return {
    port,
    apiUrl: env['OARS_API_URL'] ?? DEFAULT_API_URL,
    priceRefs: refs.length > 0 ? refs : STARTER_PRICE_REFS,
    sdkKey: sdkKey === '' ? undefined : sdkKey,
    fakeBilling,
    publicUrl: publicUrl === '' ? `http://localhost:${String(port)}` : publicUrl,
  };
};
