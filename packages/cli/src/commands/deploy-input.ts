import { readFile } from 'node:fs/promises';
import type { components } from '@manyoars/oars-client';
import { CliError, ExitCode } from '../errors.js';

type RegisterWorkloadRequest = components['schemas']['RegisterWorkloadRequest'];
type WorkloadServiceSpec = components['schemas']['WorkloadServiceSpec'];
type CreatePriceInput = components['schemas']['CreatePriceInput'];
type PriceKind = components['schemas']['PriceKind'];
type EnvVar = components['schemas']['EnvVar'];

/** What `oars deploy` is told to deploy, as the flags give it. A flag the developer did not pass is undefined. */
export interface DeployFlags {
  template?: string;
  image?: string;
  manifestFile?: string;
  name?: string;
  port?: number;
  public?: boolean;
  cpuMillicores?: number;
  memoryMib?: number;
  alwaysOn?: boolean;
  /** `--price`: starter prices to pick from a template. */
  prices: string[];
  /** `--no-prices`. */
  noPrices: boolean;
  priceFile?: string;
  /** `NAME=value` entries. */
  secrets: string[];
  /** Names of environment variables to read. */
  secretsFromEnv: string[];
}

/** The register body and the prices to create, validated and ready to send. */
export interface DeployInput {
  request: RegisterWorkloadRequest;
  prices: CreatePriceInput[];
}

const usage = (message: string): CliError => new CliError(message, ExitCode.USAGE, 'usage');

const DIGEST = /@sha256:[0-9a-f]{64}$/;
const PRICE_KINDS: readonly PriceKind[] = ['ONE_TIME', 'RECURRING_MONTHLY', 'CREDIT_PACK'];

const isObject = (value: unknown): value is object => typeof value === 'object' && value !== null && !Array.isArray(value);
const has = (value: object, key: string, type: 'string' | 'number'): boolean => typeof Reflect.get(value, key) === type;

const isService = (value: unknown): value is WorkloadServiceSpec =>
  isObject(value) && has(value, 'name', 'string') && has(value, 'image', 'string') && has(value, 'cpuMillicores', 'number') && has(value, 'memoryMib', 'number');

const isRegisterRequest = (value: unknown): value is RegisterWorkloadRequest => {
  if (!isObject(value) || !has(value, 'name', 'string')) return false;
  const services: unknown = Reflect.get(value, 'services');
  return Array.isArray(services) && services.length > 0 && services.every(isService);
};

const isPriceKind = (value: unknown): value is PriceKind => PRICE_KINDS.some((kind) => kind === value);

const isPrice = (value: unknown): value is CreatePriceInput =>
  isObject(value) && has(value, 'priceRef', 'string') && has(value, 'displayName', 'string') && has(value, 'amountUsd', 'string') && isPriceKind(Reflect.get(value, 'kind'));

const isPrices = (value: unknown): value is CreatePriceInput[] => Array.isArray(value) && value.every(isPrice);

/** A JSON file's parsed content; a file that cannot be read or parsed is exit 2 naming it. */
const readJson = async (path: string): Promise<unknown> => {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw usage(`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw usage(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
};

/** The platform deploys what a digest names; a tag can move, so a service without one is refused before any request. */
const requireDigest = (image: string): void => {
  if (!DIGEST.test(image)) {
    throw usage(`${image} is not pinned by digest. Print one with: docker buildx imagetools inspect ${image}\nthen deploy <name>@sha256:<64 hex digits>.`);
  }
};

const secretsFrom = (flags: DeployFlags, env: NodeJS.ProcessEnv): EnvVar[] => [
  ...flags.secrets.map((entry) => {
    const at = entry.indexOf('=');
    // The entry may be the secret itself, so the message does not echo it.
    if (at < 1) throw usage('--secret takes NAME=value; use --secret-from-env NAME to read the value from the environment.');
    return { name: entry.slice(0, at), value: entry.slice(at + 1) };
  }),
  ...flags.secretsFromEnv.map((name) => {
    const value = env[name];
    if (value === undefined || value === '') throw usage(`--secret-from-env ${name}: the environment variable ${name} is not set.`);
    return { name, value };
  }),
];

const requestFromFlags = (flags: DeployFlags, image: string): RegisterWorkloadRequest => {
  if (flags.name === undefined) throw usage('--image needs --name <name>.');
  requireDigest(image);
  return {
    name: flags.name,
    ...(flags.alwaysOn === true ? { alwaysOn: true } : {}),
    services: [{ name: 'app', image, port: flags.port ?? 8080, public: flags.public ?? false, cpuMillicores: flags.cpuMillicores ?? 250, memoryMib: flags.memoryMib ?? 256 }],
  };
};

const requestFromFile = async (flags: DeployFlags, path: string): Promise<RegisterWorkloadRequest> => {
  const given = (['name', 'port', 'public', 'cpuMillicores', 'memoryMib'] as const).filter((key) => flags[key] !== undefined);
  if (given.length > 0) throw usage('--name, --port, --public, --cpu-millicores and --memory-mib describe an --image deploy; a --manifest file holds its own.');
  const parsed = await readJson(path);
  if (!isRegisterRequest(parsed)) {
    throw usage(`${path} is not a workload manifest: it needs a name and services, each with name, image, cpuMillicores and memoryMib.`);
  }
  for (const service of parsed.services) requireDigest(service.image);
  return flags.alwaysOn === true ? { ...parsed, alwaysOn: true } : parsed;
};

const pricesFromFile = async (path: string): Promise<CreatePriceInput[]> => {
  const parsed = await readJson(path);
  if (!isPrices(parsed)) {
    throw usage(`${path} must be a JSON array of prices, each with priceRef, displayName, amountUsd (a decimal string) and kind (ONE_TIME, RECURRING_MONTHLY or CREDIT_PACK).`);
  }
  return parsed;
};

const baseRequest = async (flags: DeployFlags): Promise<RegisterWorkloadRequest> => {
  if (flags.image !== undefined) return requestFromFlags(flags, flags.image);
  if (flags.manifestFile !== undefined) return requestFromFile(flags, flags.manifestFile);
  throw usage('--template is not available yet: the public API does not publish the template catalog. Deploy with --image <name@sha256:...> --name <name>, or with --manifest <file>.');
};

/**
 * Turns the flags into the calls' bodies without touching the network, so a mistake costs nothing. Exactly one of
 * `--template`, `--image`, `--manifest`; `--template` waits for the public template catalog (the `oars templates` brief).
 */
export const loadDeployInput = async (flags: DeployFlags, env: NodeJS.ProcessEnv): Promise<DeployInput> => {
  if ([flags.template, flags.image, flags.manifestFile].filter((source) => source !== undefined).length !== 1) {
    throw usage('Pass exactly one of --template, --image or --manifest.');
  }
  const base = await baseRequest(flags);
  if (flags.prices.length > 0 || flags.noPrices) throw usage("--price and --no-prices choose among a template's starter prices; use --price-file with --image or --manifest.");
  const secrets = [...(base.secrets ?? []), ...secretsFrom(flags, env)];
  return {
    request: secrets.length === 0 ? base : { ...base, secrets },
    prices: flags.priceFile === undefined ? [] : await pricesFromFile(flags.priceFile),
  };
};
