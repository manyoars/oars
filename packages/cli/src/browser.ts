import { spawn } from 'node:child_process';

/** The command that opens a URL in the default browser, without a shell (so a `&` in the URL stays in it). */
const opener = (platform: NodeJS.Platform, url: string): [string, string[]] => {
  if (platform === 'win32') return ['rundll32', ['url.dll,FileProtocolHandler', url]];
  if (platform === 'darwin') return ['open', [url]];
  return ['xdg-open', [url]];
};

/** Opens `url` in the default browser. Only http(s) is opened: the URL comes from the issuer's response, and other schemes can run programs. */
export const openBrowser = (url: string, platform: NodeJS.Platform = process.platform): Promise<void> => {
  const scheme = new URL(url).protocol;
  if (scheme !== 'https:' && scheme !== 'http:') return Promise.reject(new Error(`Refusing to open a ${scheme} URL`));
  const [command, args] = opener(platform, url);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
};
