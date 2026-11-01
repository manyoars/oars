// oars' own raw archive (Matt 2026-11-01, retention point 4c): every deposited transcript is hard-linked under `<store>/raw/`, so the
// raw behind the log outlives the harness's cleanup without a second copy on disk while both exist. Across volumes, where a hard link
// cannot reach, it is copied. Local only: nothing here is ever shared.
import { copyFile, link, mkdir, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

export type Archived = 'linked' | 'copied' | 'present';

/** The file operations, injectable so a test can force the cross-volume fallback. */
export interface ArchiveOps {
  link: (source: string, target: string) => Promise<void>;
  copyFile: (source: string, target: string) => Promise<void>;
}

const NODE_OPS: ArchiveOps = { link, copyFile };

const isCode = (error: unknown, ...codes: string[]): boolean => error instanceof Error && 'code' in error && typeof error.code === 'string' && codes.includes(error.code);

// EXDEV: another volume. EPERM, ENOTSUP: a file system without hard links. EMLINK: the source's link count is at its limit.
const CANNOT_LINK = ['EXDEV', 'EPERM', 'ENOTSUP', 'EMLINK'];

/**
 * Archives `source` at `target`, idempotently. A target that is the same file (a hard link) or a copy at least as new and the same size
 * is left alone; one the harness has since rewritten or grown past is replaced.
 */
export const archiveRaw = async (source: string, target: string, ops: ArchiveOps = NODE_OPS): Promise<Archived> => {
  const from = await stat(source, { bigint: true });
  const to = await stat(target, { bigint: true }).catch((error: unknown) => {
    if (isCode(error, 'ENOENT')) return undefined;
    throw error;
  });
  if (to !== undefined) {
    const sameFile = to.ino === from.ino && to.dev === from.dev;
    if (sameFile || (to.size === from.size && to.mtimeMs >= from.mtimeMs)) return 'present';
    await rm(target, { force: true });
  }
  await mkdir(dirname(target), { recursive: true });
  try {
    await ops.link(source, target);
    return 'linked';
  } catch (error) {
    if (!isCode(error, ...CANNOT_LINK)) throw error;
  }
  await ops.copyFile(source, target);
  return 'copied';
};
