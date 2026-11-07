// What a folder may send to a pool, from the choices in `state.json`: everything (the default after the covenant is accepted), skeletons only, or nothing.
// A project that more than one entry names takes the narrowest of them, so a switch that is off is never undone by a broader entry.
import { compileAllow } from './allow.js';
import type { FolderSend, PoolChoices } from './store.js';

export type Sends = 'all' | FolderSend;

export const sendsOf = (choices: PoolChoices, project: string): Sends => {
  const modes = Object.entries(choices.folders).filter(([entry]) => compileAllow([entry]).allows(project)).map(([, mode]) => mode);
  if (modes.includes('off')) return 'off';
  return modes.includes('skeleton') ? 'skeleton' : 'all';
};

/** Whether a raw copy of this folder's sessions may be built: raw consent granted, and the folder neither skeleton only nor off. */
export const rawAllowed = (choices: PoolChoices, project: string): boolean => choices.rawConsent === 'granted' && sendsOf(choices, project) === 'all';
