// The manifest's `powershell` command, run under a real `pwsh` against a stub `oars-hook` that echoes its stdin: Windows PowerShell decodes a piped UTF-8 payload in the console's
// code page unless the command sets the encodings, and `modifiedTransformedPrompt` replaces the model-facing prompt, so a mangled prompt would reach the model. A shell that is not installed is not run.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
/** The PowerShells a Copilot `powershell` command can run under: PowerShell 7 (`pwsh`) and, on Windows, Windows PowerShell 5.1, whose console encodings are the OEM code page. */
const SHELLS = ['pwsh', 'powershell'] as const;
const probe = (shell: string, script: string): boolean => spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore' }).status === 0;
const installed = SHELLS.filter((shell) => (shell === 'powershell' ? process.platform === 'win32' : true) && probe(shell, 'exit 0'));

const made: string[] = [];
afterEach(() => {
  for (const folder of made.splice(0)) rmSync(folder, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 });
});

const powershellOf = (event: string): string => {
  const manifest: unknown = JSON.parse(readFileSync(join(root, 'com.github.copilot/hooks/hooks.json'), 'utf8'));
  const hooks: unknown = typeof manifest === 'object' && manifest !== null ? Reflect.get(manifest, 'hooks') : undefined;
  const entries: unknown = typeof hooks === 'object' && hooks !== null ? Reflect.get(hooks, event) : undefined;
  const entry: unknown = Array.isArray(entries) ? entries[0] : undefined;
  const command: unknown = typeof entry === 'object' && entry !== null ? Reflect.get(entry, 'powershell') : undefined;
  if (typeof command !== 'string') throw new Error(`no powershell command for ${event}`);
  return command;
};

/** A folder holding an `oars-hook` that writes its stdin bytes back unchanged, in the platform's own launcher kind (a `.cmd` on Windows, a script elsewhere). */
const stubFolder = (): string => {
  const folder = mkdtempSync(join(tmpdir(), 'oars-ps-stub-'));
  made.push(folder);
  const echo = join(folder, 'echo.mjs');
  writeFileSync(echo, 'const chunks = [];\nfor await (const chunk of process.stdin) chunks.push(chunk);\nprocess.stdout.write(Buffer.concat(chunks));\n');
  if (process.platform === 'win32') {
    writeFileSync(join(folder, 'oars-hook.cmd'), `@echo off\r\n"${process.execPath}" "${echo}" %*\r\n`);
  } else {
    const launcher = join(folder, 'oars-hook');
    writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${echo}" "$@"\n`);
    chmodSync(launcher, 0o755);
  }
  return folder;
};

const runPowershell = (shell: string, command: string, stdin: Buffer, folder: string): Promise<{ stdout: Buffer; code: number | null }> =>
  new Promise((resolve, reject) => {
    const env = { ...process.env, PATH: `${folder}${delimiter}${process.env.PATH ?? ''}` };
    const child = spawn(shell, ['-NoProfile', '-NonInteractive', '-Command', command], { env, stdio: ['pipe', 'pipe', 'ignore'], timeout: 60_000 });
    const out: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => {
      out.push(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ stdout: Buffer.concat(out), code });
    });
    child.stdin.end(stdin);
  });

describe.each(installed)('the manifest powershell command under %s', (shell) => {
  it('hands a non-ASCII userPromptTransformed payload to oars-hook byte for byte (curly quotes, an accent, an emoji)', async () => {
    const payload = JSON.stringify({ sessionId: 's', cwd: 'work/app', prompt: 'raw', transformedPrompt: 'say “hello” to René \u{1F680} — café' });
    const { stdout, code } = await runPowershell(shell, powershellOf('userPromptTransformed'), Buffer.from(payload, 'utf8'), stubFolder());
    expect(code).toBe(0);
    // PowerShell ends a string it pipes to a native command with a newline; the JSON reader ignores it.
    expect(stdout.toString('utf8').replace(/\r?\n$/, '')).toBe(payload);
  });

  it('does nothing and prints nothing when oars-hook is not on the PATH', async () => {
    // Only where the machine itself has no oars-hook: a developer machine with the real one installed cannot show the guard.
    if (!probe(shell, 'if (Get-Command oars-hook -ErrorAction SilentlyContinue) { exit 1 }')) return;
    const { stdout, code } = await runPowershell(shell, powershellOf('SessionStart'), Buffer.from('{}', 'utf8'), mkdtempSync(join(tmpdir(), 'oars-ps-empty-')));
    expect(code).toBe(0);
    expect(stdout.length).toBe(0);
  });
});
