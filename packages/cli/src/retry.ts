const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;

export interface RetryDeps {
  sleep: (ms: number) => Promise<void>;
  /** In [0, 1); scales each delay between half and one and a half times its base. */
  random: () => number;
}

/** Seconds, or an HTTP date, from a Retry-After header; undefined when absent or unreadable. */
const retryAfterMs = (response: Response): number | undefined => {
  const header = response.headers.get('Retry-After');
  if (header === null || header.trim() === '') return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
};

/** Design §3.2: network errors, 502-504 and a 429 that names a wait are retried; nothing else is. */
const worthRetrying = (response: Response): boolean =>
  response.status === 502 || response.status === 503 || response.status === 504 || (response.status === 429 && retryAfterMs(response) !== undefined);

/**
 * Wraps a fetch so a transient failure is retried three times with jittered exponential backoff, never sooner than the
 * server's Retry-After. Every attempt sends a clone, so the body and the Idempotency-Key repeat exactly. After the last
 * retry the final response is returned, or the final network error thrown.
 */
export const retryingFetch =
  (send: (request: Request) => Promise<Response>, { sleep, random }: RetryDeps) =>
  async (request: Request): Promise<Response> => {
    for (let retry = 0; ; retry += 1) {
      const backoff = BASE_DELAY_MS * 2 ** retry * (0.5 + random());
      let response: Response;
      try {
        response = await send(request.clone());
      } catch (error) {
        if (retry === MAX_RETRIES) throw error;
        await sleep(backoff);
        continue;
      }
      if (retry === MAX_RETRIES || !worthRetrying(response)) return response;
      // Not awaited: on a cloned body, cancel() settles only once the other branch is cancelled too.
      void response.body?.cancel().catch(() => undefined);
      await sleep(Math.max(backoff, retryAfterMs(response) ?? 0));
    }
  };
