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
