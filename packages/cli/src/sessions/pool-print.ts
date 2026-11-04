// What `oars pool fetch` and `oars pool login` print before they send: the request line and every header, then the body, with a credential
// masked as `<credential: n bytes>`. The text printed is built from the very headers and body handed to `fetch`, so the two cannot drift apart.

/** One request as it will leave this machine. */
export interface Outgoing {
  method: 'GET' | 'POST';
  url: URL;
  /** Every header this code sets. The HTTP layer adds `host`, `connection`, and `content-length` itself, and `printed` lists those too. */
  headers: Array<[string, string]>;
  body?: string;
}

/**
 * The headers Node's `fetch` would otherwise add on its own, set here so the print lists all of them. `identity` also means a reply is never compressed, so the bytes read are the bytes signed.
 * `sec-fetch-mode` and `accept-language` carry no information; they are pinned to what `fetch` sends anyway. A conditional request also gets `cache-control: no-cache` and `pragma: no-cache` from `fetch`; `ask` sets both beside `if-none-match`.
 * `pool-socket.test.ts` compares the print with the headers a loopback server reads off the socket, so a header a later Node adds fails there.
 */
export const TRANSPORT_HEADERS: ReadonlyArray<[string, string]> = [
  ['accept-encoding', 'identity'],
  ['accept-language', '*'],
  ['sec-fetch-mode', 'cors'],
];

/** The credential's size, and nothing else about it. */
export const maskOf = (secret: string): string => `<credential: ${String(Buffer.byteLength(secret))} bytes>`;

/** Every way a secret can be written into a header or a body: bare, form-encoded, percent-encoded, and as the inside of a JSON string. */
const spellings = (secret: string): string[] => {
  const form = new URLSearchParams({ k: secret }).toString().slice('k='.length);
  const inJson = JSON.stringify(secret).slice(1, -1);
  return [...new Set([secret, form, encodeURIComponent(secret), inJson])];
};

/** The secrets of one run. A value added once is masked in every print after, wherever it appears. */
export class Masker {
  private readonly secrets = new Set<string>();

  add(secret: string): void {
    if (secret !== '') this.secrets.add(secret);
  }

  mask(text: string): string {
    // Longest first, so a secret that holds another is replaced whole.
    const found = [...this.secrets].flatMap((secret) => spellings(secret).map((spelling) => ({ spelling, mask: maskOf(secret) }))).sort((a, b) => b.spelling.length - a.spelling.length);
    return found.reduce((masked, { spelling, mask }) => masked.split(spelling).join(mask), text);
  }
}

/** The request as the wire carries it: the request line, `host` and `connection` first as the HTTP layer writes them, then the headers set here, then the length of a body. */
export const printed = (request: Outgoing, masker: Masker): string => {
  const { method, url, headers, body } = request;
  const lines = [`${method} ${url.pathname}${url.search} HTTP/1.1`, `host: ${url.host}`, 'connection: keep-alive', ...headers.map(([name, value]) => `${name}: ${value}`)];
  if (body !== undefined) lines.push(`content-length: ${String(Buffer.byteLength(body))}`);
  return masker.mask(`${lines.join('\n')}\n${body === undefined ? '' : `\n${body}\n`}`);
};

/** The line the operator reads when the pool says to wait: a count of seconds, or an HTTP date, in plain words. Undefined when it is neither. */
export const waitWords = (retryAfter: string, now: number): string | undefined => {
  const seconds = /^\d+$/.test(retryAfter.trim()) ? Number(retryAfter.trim()) : Math.ceil((Date.parse(retryAfter) - now) / 1000);
  if (!Number.isFinite(seconds)) return undefined;
  if (seconds <= 0) return 'now';
  const units: ReadonlyArray<readonly [string, number]> = [
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ];
  // Only two units are shown, so the last one shown is rounded up: an operator who retries at the time named must not get another 429.
  const lead = units.findIndex(([, size]) => seconds >= size);
  const step = lead < 0 ? 1 : (units[Math.min(lead + 1, units.length - 1)]?.[1] ?? 1);
  const parts: string[] = [];
  let left = Math.ceil(seconds / step) * step;
  for (const [name, size] of units) {
    const count = Math.floor(left / size);
    left -= count * size;
    if (count > 0) parts.push(`${String(count)} ${name}${count === 1 ? '' : 's'}`);
  }
  if (parts.length === 0) parts.push(`${String(left)} second${left === 1 ? '' : 's'}`);
  return `in ${parts.slice(0, 2).join(' and ')}`;
};
