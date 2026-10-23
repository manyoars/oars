// The image the release workflow pushes: multi-stage node:24-slim, non-root, port 8080, no dev switch baked in.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
const lines = dockerfile.split('\n').map((line) => line.trim());
const instructions = (name: string): string[] => lines.filter((line) => line.toUpperCase().startsWith(`${name} `));

describe('Dockerfile', () => {
  it('is multi-stage and every stage starts from node:24-slim, never latest', () => {
    const stages = instructions('FROM');

    expect(stages.length).toBeGreaterThanOrEqual(2);
    for (const stage of stages) expect(stage).toMatch(/^FROM node:24-slim( AS \w+)?$/i);
  });

  it('copies only the built bundle into the last stage', () => {
    const last = lines.slice(lines.map((line) => line.toUpperCase().startsWith('FROM ')).lastIndexOf(true));

    expect(last.filter((line) => /^COPY\s/i.test(line))).toEqual([expect.stringMatching(/^COPY --from=build .*dist\/main\.js/i)]);
  });

  it('runs as the non-root node user and listens on 8080', () => {
    expect(instructions('USER').at(-1)).toBe('USER node');
    expect(instructions('EXPOSE')).toContain('EXPOSE 8080');
  });

  it('starts node directly, so SIGTERM reaches the server, and bakes in no dev switch or key', () => {
    expect(instructions('CMD')).toEqual(['CMD ["node", "dist/main.js"]']);
    expect(dockerfile).not.toMatch(/OARS_DEV_FAKE_BILLING|AOR_SDK_KEY/);
  });
});
