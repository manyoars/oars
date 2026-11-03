// Stub for the red run.
import type { Frame, FrameStack } from './schema.js';

export const utcDay = (_ts: string | null | undefined): string | null => null;
export const closedStack = (raw: { languages: readonly string[]; frameworks: readonly string[]; size: string | null }): FrameStack => ({ languages: [...raw.languages], frameworks: [...raw.frameworks], size: raw.size as FrameStack['size'] });
export const stackOf = (_evidence: { paths: readonly string[]; programs: readonly string[]; repoFiles: number | null }): FrameStack => ({ languages: [], frameworks: [], size: null });
export const closedFrame = (raw: Frame): Frame => raw;
export const frameIdOf = (_frame: Frame): string => '';
export const repoFilesFromIndex = (_root: string): number | null => null;
