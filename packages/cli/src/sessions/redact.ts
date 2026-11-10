import { randomBytes } from 'node:crypto';
import { homedir, userInfo } from 'node:os';
import { basename } from 'node:path';
import { injectedRule, learnInjected, type InjectedRule, type Json, type JsonObject } from './injected.js';

// Redaction before anything is written to the session store. Deterministic and conservative: it would rather over-mask a
// long random-looking token than let a secret through. Pattern rules first, then emails, the organization domains the
// operator names, and last an entropy rule for long mixed-case tokens no pattern knew.

export const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '<secret>'],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '<secret>'],
  // A synthetic fixture quoted in a session is masked like a real token (a secret scanner flags the prefix, not the value), so the minimums are short and the
  // left guard is a non-alphanumeric: `FAKE_ghp_...` still starts a token where `\b` would miss it.
  [/(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{8,}(?![A-Za-z0-9])/g, '<secret>'],
  [/(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{8,}(?![A-Za-z0-9])/g, '<secret>'],
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}\b/g, '<secret>'],
  [/(?<![A-Za-z0-9])(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{6,}(?![A-Za-z0-9])/g, '<secret>'],
  [/(?<![A-Za-z0-9])whsec_[A-Za-z0-9]{6,}(?![A-Za-z0-9])/g, '<secret>'],
  [/(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{6,}(?![A-Za-z0-9])/g, '<secret>'],
  [/\bAIza[0-9A-Za-z_-]{30,}\b/g, '<secret>'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '<secret>'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 <secret>'],
  // user:password@host inside a URL
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1<secret>@'],
  // NAME=value and "name": "value" where the name says it is a secret. A vendor name before a colon (`1password: ...` in prose) is no key. A plural
  // `tokens` name (`tokens`, `max_tokens`, `inputTokens`) is a count and keeps a bare number, as the JSON walk does; any other `token` name masks a number too.
  [/\b(?!1password(?![A-Za-z0-9_-])["']?\s*:\s)([A-Za-z0-9_-]*(?:password|passwd|secret|api[_-]?key|private[_-]?key|credential)[A-Za-z0-9_-]*)(["']?\s*[=:]\s*)(["']?)[^\s"'&,;]{4,}\3/gi, '$1$2$3<secret>$3'],
  [/\b((?![A-Za-z0-9_-]*tokens(?![A-Za-z0-9_-]))[A-Za-z0-9_-]*token[A-Za-z0-9_-]*)(["']?\s*[=:]\s*)(["']?)[^\s"'&,;]{4,}\3/gi, '$1$2$3<secret>$3'],
  [/\b([A-Za-z0-9_-]*tokens)(["']?\s*[=:]\s*)(["']?)(?!\d+(?![^\s"'&,;]))[^\s"'&,;]{4,}\3/gi, '$1$2$3<secret>$3'],
];

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
// A pinned alias, `foo@npm:bar@1.0.0` or `jsr:@scope/bar@1.0.0`, ends in `bar@1.0.0`, which EMAIL reads as an address. Digits and dots after
// the `@` are a version, never a domain, so that one shape right after `npm:` or `jsr:` (and an optional scope) is kept. An all-numeric four-part tail is an
// IP address, a real host, so it stays masked (as in `extract.ts` `VERSIONED`); any other address stays masked too.
const ALIAS_PREFIX = /(?<![A-Za-z0-9])(?:npm|jsr):(?:@[A-Za-z0-9._~-]+\/)?$|(?<![A-Za-z0-9._%+-])@[A-Za-z0-9._~-]+\/$/;
const DOTTED_VERSION = /@(?!\d+\.\d+\.\d+\.\d+$)\d+(?:\.\d+)+$/;
const TOKEN = /[A-Za-z0-9+_=-]{24,}/g;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Shannon entropy in bits per character. */
export const entropy = (text: string): number => {
  const counts = new Map<string, number>();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
};

const looksRandom = (token: string): boolean => /[a-z]/.test(token) && /[A-Z]/.test(token) && /\d/.test(token) && entropy(token) >= 4;

export type Redactor = (text: string) => string;

/** `domains` are the organization domains to mask (`example.com` also masks `mail.example.com`). */
export const makeRedactor = (domains: readonly string[] = []): Redactor => {
  const domainRule =
    domains.length === 0 ? undefined : new RegExp(`(?:[A-Za-z0-9-]+\\.)*(?:${domains.map((domain) => escapeRegExp(domain.toLowerCase())).join('|')})\\b`, 'gi');
  return (text) => {
    let out = text;
    for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
    out = out.replace(EMAIL, (match, offset: number, whole: string) =>
      DOTTED_VERSION.test(match) && ALIAS_PREFIX.test(whole.slice(0, offset)) ? match : '<email>');
    if (domainRule !== undefined) out = out.replace(domainRule, '<org-domain>');
    return out.replace(TOKEN, (token) => (looksRandom(token) ? '<secret>' : token));
  };
};

// What a whole transcript holds beyond what a slice of one does (t884): home paths and usernames, environment values, and hosts. A raw copy that
// leaves the machine goes through these after `makeRedactor`'s rules. Best effort, not a proof: `docs/sessions-store.md` ("The raw copy") lists what it cannot catch.
const URL_HOST = /(\b[a-z][a-z0-9+.-]*:\/\/)(?:[^\s/@"'\\]*@)?[A-Za-z0-9.-]+(?::\d+)?/gi;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const INTERNAL_NAME = /\b(?:[a-z0-9-]+\.)+(?:internal|local|lan|corp|intranet|home|localdomain)\b/gi;
const UNIX_HOME = /(\/(?:home|Users)\/)(?![<.])[^/\s"'\\]+/g;
const WINDOWS_HOME = /([A-Za-z]:[\\/]+Users[\\/]+)(?![<.])[^\\/\s"']+/gi;
const ENVIRONMENT = /\b((?:export\s+)?[A-Z][A-Z0-9_]{2,}=)(?!<)(?:\\?["'][^"'\\]*\\?["']|[^\s"'\\]+)/g;
// The harness names a project folder after its path: `/Users/name/work` becomes `-Users-name-work`, and `C:\\Users\\name\\work` becomes `C--Users-name-work`. The name runs to the next hyphen, so a hyphenated name is masked whole earlier, by the local-name rule (which also matches each name in this encoded form).
const ENCODED_HOME = /(?<![A-Za-z0-9])((?:[A-Za-z]-)?-(?:Users|home)-)(?!<)[^-\s"'\\/]+/g;
// A shell prompt, `name@box:~/dir$`: a box name with no dot is not an address, so the email rule leaves it.
const PROMPT = /(?:<user>|\b[A-Za-z0-9._-]+)@[A-Za-z0-9-]+(?=:[~/.])/g;
// Full, compressed, and loopback forms. A clock time (`10:20:30`) has no `::`, so it is never one.
const IPV6 =
  /(?<![0-9A-Za-z:])(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,7}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?|::[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})(?![0-9A-Za-z:])/gi;
const MIN_NAME = 3;
const PLACEHOLDER = /<(?:secret|email|org-domain|host|user|env|owner)>/g;
// A `.env` line whose name is lower case (`mapbox=q8z7...`): only a whole line of that shape, so `--flag=value` and `?page=2` are left alone.
const LOWER_ENVIRONMENT = /^([ \t]*(?:export[ \t]+)?[a-z][a-z0-9_]{2,}=)(?!<)(?:(["'])[^"'\n]*\2|[^\s"']+)[ \t]*$/gm;

// Shapes `makeRedactor` does not know (t955, census S3). They run only on a raw copy, and before the shared rules, because the entropy rule would
// split a key at its `/` first. A bare 40-character secret key needs a `/` or `+` and a random look, so a git sha (hex) and the front of a
// base64 image (longer than 40) stay. A password flag is masked only when the value looks like one: four characters with a digit or a symbol, and not a
// port, so `-p 8080` and `-p3000:3000` stay and `-pthread` is not read as a password.
const AWS_SECRET_KEY = /(?<![A-Za-z0-9/+=_-])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=_-])/g;
const PORT = /^[\d.:]+(?:\/[a-z]+)?$/i;
const passwordLike = (value: string): boolean => value.length >= 4 && /[\d!@#$%^&*]/.test(value) && !PORT.test(value);
const rawRules: Redactor = (text) =>
  text
    .replace(/-----BEGIN PGP PRIVATE KEY BLOCK-----[\s\S]*?(?:-----END PGP PRIVATE KEY BLOCK-----|$)/g, '<secret>')
    .replace(/PuTTY-User-Key-File-\d+:[\s\S]*?Private-Lines:[\s\S]*?(?:Private-MAC:[ \t]*\w*|$)/g, '<secret>')
    .replace(/\bdop_v1_[a-f0-9]{64}\b/g, '<secret>')
    .replace(AWS_SECRET_KEY, (key) => (/[/+]/.test(key) && looksRandom(key) ? '<secret>' : key))
    .replace(/((?<!\S)(?:-u\s*|--user\s+)["']?(?!\d+:)[^\s:"']+:)[^\s"']{4,}/g, '$1<secret>')
    .replace(/(?<!\S)-p(["'])[^"'\n]{4,}\1/g, '-p$1<secret>$1')
    .replace(/(?<!\S)-p([^\s"'-][^\s"']{3,})/g, (flag, value: string) => (passwordLike(value) ? '-p<secret>' : flag))
    .replace(/(\bsshpass\s+-p\s*)(?:"[^"]*"|'[^']*'|[^\s"']+)/g, '$1<secret>')
    .replace(/((?<!\S)-W\s+)(?:(["'])[^"']+\2|([^\s"'/:-][^\s"'/:]{3,}))/g, (flag, lead: string, quote: string | undefined, bare: string | undefined) =>
      quote !== undefined || passwordLike(bare ?? '') ? `${lead}<secret>` : flag)
    .replace(/(--(?:password|passwd|pwd)\s+)(?:(["'])[^"']*\2|[^\s"'-][^\s"']*)/g, '$1<secret>');

// A raw copy is JSONL, so a tool's output sits inside a JSON string where a newline is `\n` and a quote is `\"`: a rule written for plain text
// misses `\nAKIA...` (no word boundary), cannot cross `\"`, and can eat the `n` of `\n` (t955, census S1, S2, S22). So a line that parses is
// walked and every string in it redacted decoded (a string that itself holds JSON, in turn); the line is written again only if a value changed,
// and any other text keeps the plain-text path with its bytes as they were.
const SECRET_NAME = /password|passwd|secret|token|api[_-]?key|private[_-]?key|credential/i;
// A count of tokens is a number under a `token` name, so a number is masked only under the names that are always a secret.
const SECRET_NUMBER_NAME = /password|passwd|secret|api[_-]?key|private[_-]?key|credential/i;
const CONTAINER = /^\s*[{[]/;

const isContainer = (value: unknown): value is Json[] | JsonObject => typeof value === 'object' && value !== null;

const parseContainer = (text: string): Json[] | JsonObject | undefined => {
  if (!CONTAINER.test(text)) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return isContainer(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const redactDecoded = (body: string, redactText: Redactor, injected: InjectedRule, enter: (line: JsonObject) => void): string => {
  // A name reaches the strings of an array under it (`"tokens": ["..."]`); an object's own keys name their values.
  const walk = (value: Json, name: string): Json => {
    if (typeof value === 'string') return SECRET_NAME.test(name) && value.length >= 4 ? '<secret>' : redactBlock(value);
    if (typeof value === 'number') return SECRET_NUMBER_NAME.test(name) && String(value).length >= 4 ? '<secret>' : value;
    if (Array.isArray(value)) {
      const items = value.map((item) => walk(item, name));
      return items.some((item, at) => item !== value[at]) ? items : value;
    }
    if (typeof value === 'object' && value !== null) {
      const before = Object.entries(value);
      const after = before.map(([key, item]): [string, Json] => [redactBlock(key), walk(item, key)]);
      return after.some(([key, item], at) => key !== before[at]?.[0] || item !== before[at][1]) ? Object.fromEntries(after) : value;
    }
    return value;
  };
  // The text as it was when nothing in it changed; otherwise the value written again, inside the whitespace (a `\r`, a newline) it had around it.
  // A transcript line is a top-level object: the harness's own blocks in it are marked first (their hash is of the text as written), then the rest is walked.
  const rewrite = (text: string, parsed: Json[] | JsonObject, top: boolean): string => {
    if (top && !Array.isArray(parsed)) enter(parsed);
    const marked = top && !Array.isArray(parsed) ? injected(parsed) : parsed;
    const next = walk(marked, '');
    return next === parsed ? text : `${text.slice(0, text.length - text.trimStart().length)}${JSON.stringify(next)}${text.slice(text.trimEnd().length)}`;
  };
  // `text` is a whole document, or lines of which some are JSON: the JSON ones are walked, the runs between them take the plain-text path.
  const redactBlock = (text: string, top = false): string => {
    const whole = parseContainer(text);
    if (whole !== undefined) return rewrite(text, whole, top);
    const out: string[] = [];
    let run: string[] = [];
    for (const line of text.split('\n')) {
      const parsed = parseContainer(line);
      if (parsed === undefined) {
        run.push(line);
        continue;
      }
      if (run.length > 0) out.push(redactText(run.join('\n')));
      run = [];
      out.push(rewrite(line, parsed, top));
    }
    if (run.length > 0) out.push(redactText(run.join('\n')));
    return out.join('\n');
  };
  return redactBlock(body, true);
};

/** How many values of a redacted text were masked: each placeholder is one. */
export const placeholders = (text: string): number => text.match(PLACEHOLDER)?.length ?? 0;

/** The account name; `userInfo()` throws when the uid has no passwd entry (a container run with `--user <uid>`), so the environment stands in. */
const accountName = (): string => userInfo().username;

/** The names this machine's person goes by in a transcript: the account's and the home folder's. A name under three characters would mask ordinary words, so it is left to the path rules. */
export const localNames = (home: string = homedir(), account: () => string = accountName): string[] => {
  const read = (): string => {
    try {
      return account();
    } catch {
      return process.env['USER'] || process.env['USERNAME'] || '';
    }
  };
  return [...new Set([read(), basename(home)].filter((name) => name.length >= MIN_NAME))];
};

// Each name also stands in its encoded-folder form (`John Smith` is `John-Smith` in `C--Users-John-Smith-repo`), and the longest goes first so `mary-jane` is never cut to `mary`.
const nameRule = (names: readonly string[]): RegExp | undefined => {
  const usable = names.filter((name) => name.length >= MIN_NAME);
  const forms = [...new Set(usable.flatMap((name) => [name, name.replace(/[^A-Za-z0-9]/g, '-')]))].sort((a, b) => b.length - a.length);
  return forms.length === 0 ? undefined : new RegExp(`(?<![A-Za-z0-9<])(?:${forms.map(escapeRegExp).join('|')})(?![A-Za-z0-9>])`, 'gi');
};

/** What only a sample pack asks of the raw-copy rules (t1111). */
export interface PackRules {
  /** The accounts the operator's repositories live under (a GitHub user or organization): masked as `<owner>` where one stands as a path segment or after a `:` of a remote. */
  handles?: readonly string[];
  /** Rewrites a tool use id (`toolu_...`, `srvtoolu_...`) to the value the pack keys it to, so a call and its result still pair; without it the entropy rule masks each as `<secret>`. */
  toolId?: (id: string) => string;
  /** Keeps a public host the session itself fetched or searched (the URL or `allowed_domains` of a WebFetch or WebSearch input) in the clear in that call's result. */
  fetchedHosts?: boolean;
}

const TOOL_ID = /(?<![A-Za-z0-9])(?:srv)?tool(?:u|use)_(?:bdrk_|vrtx_)?[A-Za-z0-9_-]{8,}/g;
const FETCH_TOOLS = new Set(['WebFetch', 'WebSearch']);
const HOST_OF_URL = /^[a-z][a-z0-9+.-]*:\/\/([A-Za-z0-9.-]+)/i;
const URLS = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@"'\\]*@?[A-Za-z0-9.-]+/gi;
// Loopback, an IP literal, a bare name, and the internal suffixes of INTERNAL_NAME are never a public host.
const INTERNAL_SUFFIX = /\.(?:internal|local|lan|corp|intranet|home|localdomain)$/;
const publicHost = (host: string): boolean => host.includes('.') && !/^[\d.]+$/.test(host) && !INTERNAL_SUFFIX.test(host) && host !== 'localhost';

const hostsIn = (value: Json, found: Set<string>, listed = false): void => {
  if (typeof value === 'string') {
    for (const url of value.match(URLS) ?? []) if (!url.includes('@')) found.add((HOST_OF_URL.exec(url)?.[1] ?? '').toLowerCase());
    // `allowed_domains` lists bare domains.
    if (listed) found.add(value.toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[/:].*$/, ''));
  } else if (Array.isArray(value)) for (const item of value) hostsIn(item, found, listed);
  else if (typeof value === 'object' && value !== null) for (const [key, item] of Object.entries(value)) hostsIn(item, found, key === 'allowed_domains');
};

/** The blocks of a transcript line's message content, when it has any. */
const blocksOf = (line: JsonObject): JsonObject[] => {
  const message = line['message'];
  const content = typeof message === 'object' && message !== null && !Array.isArray(message) ? message['content'] : undefined;
  return Array.isArray(content) ? content.filter((block): block is JsonObject => typeof block === 'object' && block !== null && !Array.isArray(block)) : [];
};

/** The public hosts each WebFetch or WebSearch call of a transcript named, by the call's tool use id. */
const fetchedBy = (lines: readonly JsonObject[]): Map<string, Set<string>> => {
  const byId = new Map<string, Set<string>>();
  for (const line of lines) {
    for (const block of blocksOf(line)) {
      const { type, id, name, input } = block;
      if (type !== 'tool_use' || typeof id !== 'string' || typeof name !== 'string' || !FETCH_TOOLS.has(name) || input === undefined) continue;
      const found = new Set<string>();
      hostsIn(input, found);
      byId.set(id, new Set([...found].filter(publicHost)));
    }
  }
  return byId;
};

// A handle is a whole path segment (`/acme/app`, `\acme\app`, `git@host:acme/app.git`) or a hyphen-bounded word of an encoded project folder (`-repos-acme-app`).
const handleRule = (handles: readonly string[]): RegExp | undefined => {
  const usable = [...new Set(handles.filter((handle) => handle.length >= MIN_NAME))].sort((a, b) => b.length - a.length);
  return usable.length === 0 ? undefined : new RegExp(String.raw`(?<=[\\/:-])(?:${usable.map(escapeRegExp).join('|')})(?=[\\/.-]|["'\s]|$)`, 'gi');
};

/** A whole transcript body redacted for upload, and how many values were masked (placeholders added, a count and nothing else). `names` are the local usernames to mask wherever they stand as a whole word. */
export const redactTranscript = (body: string, domains: readonly string[] = [], names: readonly string[] = [], injectedKey: string = randomBytes(16).toString('hex'), pack: PackRules = {}): { text: string; masked: number } => {
  const named = nameRule(names);
  const owner = handleRule(pack.handles ?? []);
  const known = makeRedactor(domains);
  // The hosts the line being redacted may keep: those its tool results' calls fetched.
  let kept: ReadonlySet<string> = new Set();
  const keepHost = (match: string, scheme: string): string => (!match.includes('@') && kept.has((HOST_OF_URL.exec(match)?.[1] ?? '').toLowerCase()) ? match : `${scheme}<host>`);
  const redactText: Redactor = (original) => {
    const text = pack.toolId === undefined ? original : original.replace(TOOL_ID, pack.toolId);
    // The names go first: a hyphenated or spaced name must be masked whole before the path rules take its first word.
    const masked = known(rawRules(text));
    const mine = named === undefined ? masked : masked.replace(named, '<user>');
    return (owner === undefined ? mine : mine.replace(owner, '<owner>'))
      .replace(URL_HOST, keepHost)
      .replace(INTERNAL_NAME, '<host>')
      .replace(IPV4, '<host>')
      .replace(IPV6, '<host>')
      .replace(UNIX_HOME, '$1<user>')
      .replace(WINDOWS_HOME, '$1<user>')
      .replace(ENCODED_HOME, '$1<user>')
      .replace(PROMPT, '<user>@<host>')
      .replace(ENVIRONMENT, '$1<env>')
      .replace(LOWER_ENVIRONMENT, '$1<env>');
  };
  // A request blob repeats messages other lines hold, so what those lines carry is collected before any line is marked.
  const repeated = new Set<string>();
  const whole = parseContainer(body);
  for (const parsed of whole !== undefined ? [whole] : body.split('\n').map(parseContainer)) if (parsed !== undefined && !Array.isArray(parsed)) learnInjected(parsed, repeated);
  const calls = pack.fetchedHosts === true ? fetchedBy([...(whole !== undefined ? [whole] : body.split('\n').map(parseContainer))].filter((parsed): parsed is JsonObject => parsed !== undefined && !Array.isArray(parsed))) : new Map<string, Set<string>>();
  const enter = (line: JsonObject): void => {
    kept = new Set(blocksOf(line).flatMap((block) => (block['type'] === 'tool_result' && typeof block['tool_use_id'] === 'string' ? [...(calls.get(block['tool_use_id']) ?? [])] : [])));
  };
  const redacted = redactDecoded(body, redactText, injectedRule(injectedKey, repeated), enter);
  return { text: redacted, masked: Math.max(0, placeholders(redacted) - placeholders(body)) };
};

/** The version of the rules above, stated to the pool with every raw part; a change to any rule of `redactTranscript` raises it. */
export const REDACTION_VERSION = '4';
