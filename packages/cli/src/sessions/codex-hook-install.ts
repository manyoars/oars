// `oars sessions hook install --harness codex`: writes the recording hook's entries into `hooks.json` in the Codex home, merging with what is there.
// An entry is ours when its command ends with `codex-hook-bin.js"`, so uninstall removes those and nothing else. Nothing here runs on upgrade or on first
// run, and nothing writes the trust Codex asks for: a non-managed hook is skipped until the operator reviews it in Codex.
import { join } from 'node:path';
import { CODEX_HOOK_EVENTS } from './codex-hook.js';
import { groupsOf, hasOwn, hooksOf, readSettings, withoutOwn, writeSettings } from './install.js';

/** What the install needs from the machine: the Codex home (`codexRoot`), the node binary, and the built `codex-hook-bin.js`. */
export interface CodexInstall {
  home: string;
  nodePath: string;
  hookBin: string;
}

const OWN_COMMAND = /codex-hook-bin\.js"$/;

/** Seconds Codex waits; the hook appends one line and exits, so this is only a ceiling. */
const TIMEOUT = 5;

export const codexHooksFile = (codex: CodexInstall): string => join(codex.home, 'hooks.json');

/** The line the operator reads after an install: Codex does not run the entry until it is trusted. */
export const CODEX_TRUST_NOTICE = 'Codex asks you to review and trust a new hook before it runs it; until you do, nothing is recorded. Rows go to hook-rows.jsonl in the oars store, only while codex is allowed, and never leave this machine.';

export const installCodexHook = async (codex: CodexInstall): Promise<{ file: string; installed: string[] }> => {
  const file = codexHooksFile(codex);
  const settings = await readSettings(file);
  const hooks = hooksOf(settings);
  for (const event of CODEX_HOOK_EVENTS) {
    const entry = { type: 'command', command: `"${codex.nodePath}" "${codex.hookBin}"`, timeout: TIMEOUT };
    hooks[event] = [...withoutOwn(groupsOf(hooks, event), OWN_COMMAND), { hooks: [entry] }];
  }
  settings.hooks = hooks;
  await writeSettings(file, settings);
  return { file, installed: [...CODEX_HOOK_EVENTS] };
};

export const uninstallCodexHook = async (codex: CodexInstall): Promise<{ file: string; removed: string[] }> => {
  const file = codexHooksFile(codex);
  const settings = await readSettings(file);
  const hooks = hooksOf(settings);
  const removed = CODEX_HOOK_EVENTS.filter((event) => hasOwn(groupsOf(hooks, event), OWN_COMMAND));
  if (removed.length === 0) return { file, removed: [] };
  for (const event of removed) {
    const kept = withoutOwn(groupsOf(hooks, event), OWN_COMMAND);
    if (kept.length === 0) Reflect.deleteProperty(hooks, event);
    else hooks[event] = kept;
  }
  settings.hooks = Object.keys(hooks).length === 0 ? undefined : hooks;
  await writeSettings(file, settings);
  return { file, removed: [...removed] };
};

export const codexHookStatus = async (codex: CodexInstall): Promise<{ file: string; installed: string[] }> => {
  const file = codexHooksFile(codex);
  const hooks = hooksOf(await readSettings(file));
  return { file, installed: CODEX_HOOK_EVENTS.filter((event) => hasOwn(groupsOf(hooks, event), OWN_COMMAND)) };
};
