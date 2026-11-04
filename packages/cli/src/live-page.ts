import type { Page } from '@playwright/test';

/**
 * Names the page a live-login step was waiting on, for an error message. The CI job's logs are public, so this carries the title and
 * the URL path only: no query string (it holds the device code and session ids), no username, and no page body.
 */
export const describePage = (title: string, url: string): string => {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    path = '(unparsable URL)';
  }
  return `page "${title}" at ${path}`;
};

/**
 * Runs one step of the browser flow; a failure names the page that was showing instead of the locator that never appeared. The
 * original error is dropped on purpose, only its name is kept: Playwright's call log holds the verification URL (with the user code)
 * and the values typed into the form, and the CI job's logs are public.
 */
export const step = async (page: Pick<Page, 'title' | 'url'>, what: string, action: () => Promise<void>): Promise<void> => {
  const kind = await action().then(
    () => undefined,
    (error: unknown) => (error instanceof Error ? error.name : 'Error'),
  );
  if (kind === undefined) return;
  const title = await page.title().catch(() => '');
  throw new Error(`The device approval stopped at "${what}" on ${describePage(title, page.url())} (${kind}).`);
};

/**
 * The stderr callback for `oars login --no-browser`: the chunk with the verification link also holds the user code, so it is announced
 * and never kept, because a failure prints `kept` in the CI job's public log.
 */
export const stderrSink =
  (announce: (url: string) => void, kept: string[]) =>
  (chunk: string): void => {
    const url = /open (\S+)/.exec(chunk)?.[1];
    if (url !== undefined) {
      announce(url);
      return;
    }
    kept.push(chunk);
  };
