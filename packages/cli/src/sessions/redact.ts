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
