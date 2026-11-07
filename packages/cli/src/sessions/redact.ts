import { homedir, userInfo } from 'node:os';
import { basename } from 'node:path';

// Redaction before anything is written to the session store. Deterministic and conservative: it would rather over-mask a
// long random-looking token than let a secret through. Pattern rules first, then emails, the organization domains the
// operator names, and last an entropy rule for long mixed-case tokens no pattern knew.

export const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '<secret>'],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '<secret>'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '<secret>'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '<secret>'],
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}\b/g, '<secret>'],
  [/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g, '<secret>'],
  [/\bwhsec_[A-Za-z0-9]{10,}\b/g, '<secret>'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, '<secret>'],
  [/\bAIza[0-9A-Za-z_-]{30,}\b/g, '<secret>'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '<secret>'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 <secret>'],
  // user:password@host inside a URL
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1<secret>@'],
  // NAME=value and "name": "value" where the name says it is a secret
  [/\b([A-Za-z0-9_-]*(?:password|passwd|secret|token|api[_-]?key|private[_-]?key|credential)[A-Za-z0-9_-]*)(["']?\s*[=:]\s*)(["']?)[^\s"'&,;]{4,}\3/gi, '$1$2$3<secret>$3'],
];

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
// A pinned alias, `foo@npm:bar@1.0.0` or `jsr:@scope/bar@1.0.0`, ends in `bar@1.0.0`, which EMAIL reads as an address. Digits and dots after
// the `@` are a version, never a domain, so that one shape right after `npm:` or `jsr:` (and an optional scope) is kept. An all-numeric four-part tail is an
// IP address, a real host, so it stays masked (as in `extract.ts` `VERSIONED`); any other address stays masked too.
const ALIAS_PREFIX = /(?<![A-Za-z0-9])(?:npm|jsr):(?:@[A-Za-z0-9._~-]+\/)?$/;
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
const PLACEHOLDER = /<(?:secret|email|org-domain|host|user|env)>/g;

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

/** A whole transcript body redacted for upload, and how many values were masked (placeholders added, a count and nothing else). `names` are the local usernames to mask wherever they stand as a whole word. */
export const redactTranscript = (body: string, domains: readonly string[] = [], names: readonly string[] = []): { text: string; masked: number } => {
  const named = nameRule(names);
  // The names go first: a hyphenated or spaced name must be masked whole before the path rules take its first word.
  const known = makeRedactor(domains)(body);
  const redacted = (named === undefined ? known : known.replace(named, '<user>'))
    .replace(URL_HOST, '$1<host>')
    .replace(INTERNAL_NAME, '<host>')
    .replace(IPV4, '<host>')
    .replace(IPV6, '<host>')
    .replace(UNIX_HOME, '$1<user>')
    .replace(WINDOWS_HOME, '$1<user>')
    .replace(ENCODED_HOME, '$1<user>')
    .replace(PROMPT, '<user>@<host>')
    .replace(ENVIRONMENT, '$1<env>');
  return { text: redacted, masked: Math.max(0, placeholders(redacted) - placeholders(body)) };
};

/** The version of the rules above, stated to the pool with every raw part; a change to any rule of `redactTranscript` raises it. */
export const REDACTION_VERSION = '1';
