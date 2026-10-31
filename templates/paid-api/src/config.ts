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
  /** Anonymous `POST /v1/customers` requests allowed per client address per minute. */
  customersPerMinute: number;
  /** True when the server runs behind the oars router, so the client address is the one in CF-Connecting-IP, not the socket's. */
  trustProxy: boolean;
}

export const DEFAULT_CUSTOMERS_PER_MINUTE = 5;

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
  const limit = env['OARS_CUSTOMERS_PER_MINUTE']?.trim() ?? '';
  if (limit !== '' && !/^[1-9][0-9]*$/.test(limit)) {
    throw new ConfigError(`OARS_CUSTOMERS_PER_MINUTE must be a whole number of 1 or more, got "${limit}"`);
  }
  return {
    port,
    apiUrl: env['OARS_API_URL'] ?? DEFAULT_API_URL,
    priceRefs: refs.length > 0 ? refs : STARTER_PRICE_REFS,
    sdkKey: sdkKey === '' ? undefined : sdkKey,
    fakeBilling,
    publicUrl: publicUrl === '' ? `http://localhost:${String(port)}` : publicUrl,
    customersPerMinute: limit === '' ? DEFAULT_CUSTOMERS_PER_MINUTE : Number(limit),
    trustProxy: env['OARS_TRUST_PROXY'] === '1',
  };
};
