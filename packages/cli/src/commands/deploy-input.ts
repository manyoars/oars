import { readFile } from 'node:fs/promises';
import type { components } from '@manyoars/oars-client';
import { CliError, ExitCode } from '../errors.js';
import type { AgentTemplate } from './templates.js';

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
  /** `--price`: starter prices to pick from a template (all of them by default). */
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

/** The register body of an --image or --manifest deploy. */
const imageOrFileRequest = async (flags: DeployFlags): Promise<RegisterWorkloadRequest> => {
  if (flags.image !== undefined) return requestFromFlags(flags, flags.image);
  if (flags.manifestFile !== undefined) return requestFromFile(flags, flags.manifestFile);
  throw usage('Pass exactly one of --template, --image or --manifest.');
};

/** The flags that describe an --image deploy; a template or a manifest file holds its own. */
const refuseImageFlags = (flags: DeployFlags, source: string): void => {
  const given = (['name', 'port', 'public', 'cpuMillicores', 'memoryMib'] as const).filter((key) => flags[key] !== undefined);
  if (given.length > 0) throw usage(`--name, --port, --public, --cpu-millicores and --memory-mib describe an --image deploy; ${source} holds its own.`);
};

const requestFromFile = async (flags: DeployFlags, path: string): Promise<RegisterWorkloadRequest> => {
  refuseImageFlags(flags, 'a --manifest file');
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

/** A starter price as the create call takes it. `credits` is left out of a price that has none (the wire may carry null). */
const priceFromTemplate = (price: AgentTemplate['starterPrices'][number]): CreatePriceInput => ({
  priceRef: price.priceRef,
  displayName: price.displayName,
  amountUsd: price.amountUsd,
  kind: price.kind,
  ...(typeof price.credits === 'number' ? { credits: price.credits } : {}),
});

/** `--template`: the entry's manifest, and the starter prices `--price` picked (every one without it, none for `--no-prices`). */
const fromTemplate = (flags: DeployFlags, template: AgentTemplate): DeployInput => {
  const wanted = flags.noPrices ? [] : flags.prices;
  const unknown = wanted.filter((ref) => !template.starterPrices.some((price) => price.priceRef === ref));
  if (unknown.length > 0) {
    throw usage(`Template ${template.templateId} has no starter price ${unknown.join(', ')}; its prices are ${template.starterPrices.map((price) => price.priceRef).join(', ')}.`);
  }
  const chosen = flags.noPrices || flags.prices.length > 0 ? template.starterPrices.filter((price) => wanted.includes(price.priceRef)) : template.starterPrices;
  return { request: flags.alwaysOn === true ? { ...template.manifest, alwaysOn: true } : template.manifest, prices: chosen.map(priceFromTemplate) };
};

/** A catalog entry's id is what the platform serves, so an id it does not list is exit 2 naming the ids it does. */
const findTemplate = async (id: string, resolve: TemplateLookup): Promise<AgentTemplate> => {
  const catalog = await resolve();
  const found = catalog.find((template) => template.templateId === id);
  if (found === undefined) {
    throw usage(`No template ${id}. ${catalog.length === 0 ? 'The catalog is empty.' : `Available: ${catalog.map((template) => template.templateId).join(', ')}.`} List them with: oars templates`);
  }
  return found;
};

/** The checks on a `--template` deploy's flags, then its catalog entry; the flags are all read before the one GET. */
const templateInput = async (flags: DeployFlags, id: string, catalog: TemplateLookup): Promise<DeployInput> => {
  refuseImageFlags(flags, 'the template');
  if (flags.priceFile !== undefined) throw usage('--price-file adds prices to an --image or --manifest deploy; a template brings its own: choose among them with --price, or skip them with --no-prices.');
  if (flags.noPrices && flags.prices.length > 0) throw usage('--price and --no-prices contradict each other.');
  return fromTemplate(flags, await findTemplate(id, catalog));
};

/** Reads the catalog once, when a `--template` deploy has passed every check that needs no network. */
export type TemplateLookup = () => Promise<AgentTemplate[]>;

/**
 * Turns the flags into the calls' bodies. Exactly one of `--template`, `--image`, `--manifest`. Every mistake the flags alone can
 * show is found before any request; only `--template` then reads the catalog (`catalog`), so a typo there costs one GET.
 */
export const loadDeployInput = async (flags: DeployFlags, env: NodeJS.ProcessEnv, catalog: TemplateLookup): Promise<DeployInput> => {
  if ([flags.template, flags.image, flags.manifestFile].filter((source) => source !== undefined).length !== 1) {
    throw usage('Pass exactly one of --template, --image or --manifest.');
  }
  const picked = flags.template === undefined ? undefined : await templateInput(flags, flags.template, catalog);
  if (picked === undefined && (flags.prices.length > 0 || flags.noPrices)) {
    throw usage("--price and --no-prices choose among a template's starter prices; use --price-file with --image or --manifest.");
  }
  const base = picked?.request ?? (await imageOrFileRequest(flags));
  const secrets = [...(base.secrets ?? []), ...secretsFrom(flags, env)];
  return {
    request: secrets.length === 0 ? base : { ...base, secrets },
    prices: picked?.prices ?? (flags.priceFile === undefined ? [] : await pricesFromFile(flags.priceFile)),
  };
};
