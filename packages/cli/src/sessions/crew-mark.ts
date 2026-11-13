// The founding crew number this machine last learned for a pool (t1229): `GET /v1/me` states it, and `oars pool invite` and `oars pool join` keep it here so the share card, which makes no network call, can show it. A number only; no count of members is ever stored or printed.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isObject, numberIn } from './pool-replica.js';

const fileOf = (storeDir: string): string => join(storeDir, 'pool-crew.json');

/** The crew number held for `account` on `server`, or undefined: no file, another pool or account, a file that is not ours, or an account that is not in the crew. */
export const crewNumberOf = async (storeDir: string, server: string, account: string): Promise<number | undefined> => {
  try {
    const held: unknown = JSON.parse(await readFile(fileOf(storeDir), 'utf8'));
    return isObject(held) && Reflect.get(held, 'server') === server && Reflect.get(held, 'account') === account ? numberIn(held, 'crewNumber') : undefined;
  } catch {
    return undefined;
  }
};

/** Keeps what the pool said, replacing the earlier answer: the number, or none when the account holds none. */
export const keepCrewNumber = async (storeDir: string, server: string, account: string, crewNumber: number | undefined): Promise<void> => {
  await mkdir(storeDir, { recursive: true });
  await writeFile(fileOf(storeDir), JSON.stringify({ server, account, ...(crewNumber === undefined ? {} : { crewNumber }) }));
};

/** The card's words for a crew number. */
export const crewMarkText = (crewNumber: number): string => `founding crew #${String(crewNumber)}`;
