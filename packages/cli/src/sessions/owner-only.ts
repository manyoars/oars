// TEMPORARY red run (t957 Item 7): origin/main's behavior, a mode only at create. Reverted by the next commit.
import { appendFile, mkdir, writeFile } from 'node:fs/promises';

export const appendOwnerOnly = async (file: string, text: string): Promise<void> => {
  await appendFile(file, text, { encoding: 'utf8' });
};

export const writeOwnerOnly = async (file: string, text: string): Promise<void> => {
  await writeFile(file, text, { encoding: 'utf8' });
};

export const mkdirOwnerOnly = async (folder: string): Promise<void> => {
  await mkdir(folder, { recursive: true });
};
