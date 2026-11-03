// `oars sessions lineage` (recall spec Section 3): walks a recall or read back through its evidence, one line per hop with its frame range and day. Evidence must come from
// before the recall that cites it, which is what keeps the commons acyclic; a store whose records say otherwise is refused here, not printed as if it held. The walk also keeps
// a visited set, so a hand-edited file cannot loop it.
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CliError, ExitCode } from '../errors.js';
import { cellIdOf, UNKNOWN, type Cell } from './cells.js';
import { poolFiles } from './pool.js';
import type { Read } from './read.js';
import { evidencePredates, readRecalls, type Recall, type RecallEvidence } from './recall-object.js';

export interface LineageSources {
  recalls: readonly Recall[];
  reads: readonly Read[];
  cells: readonly Cell[];
}

export interface LineageHop {
  depth: number;
  kind: 'recall' | 'read' | 'cell' | 'evidence' | 'missing';
  ref: string;
  frames: string[];
  day: string | null;
  detail: string;
}

const FRAMES_SHOWN = 3;

const dayOf = (at: string): string => at.slice(0, 10);

const refuse = (ref: string, day: string | null, limit: string): CliError => new CliError(`Refused: ${ref} is from ${String(day)}, newer than the recall citing it (${limit}).`, ExitCode.INVALID, 'lineage');

const framesOfRecall = (recall: Recall): string[] => (recall.frame === null ? [] : [[recall.frame.harness, recall.frame.harnessVersion ?? UNKNOWN, recall.frame.model ?? UNKNOWN].join(' ')]);

const framesOfEvidence = (evidence: RecallEvidence): string[] => [...evidence.frameRange.harnesses, ...evidence.frameRange.harnessVersions, ...evidence.frameRange.models];

const framesOfRead = (read: Read, cells: ReadonlyMap<string, Cell>): string[] => {
  const buckets = [...new Set(read.inputs.flatMap((input) => cells.get(input)?.frameBucket ?? []))].sort();
  return buckets.length <= FRAMES_SHOWN ? buckets : [...buckets.slice(0, FRAMES_SHOWN), `+${String(buckets.length - FRAMES_SHOWN)}`];
};

const tighter = (limit: string | null, day: string): string => (limit === null || day < limit ? day : limit);

export const walkLineage = (sources: LineageSources, start: string): LineageHop[] => {
  const recalls = new Map(sources.recalls.map((recall) => [recall.id, recall]));
  const reads = new Map(sources.reads.map((read) => [read.readId, read]));
  const cells = new Map(sources.cells.map((cell) => [cellIdOf(cell), cell]));
  const known = (ref: string): boolean => recalls.has(ref) || reads.has(ref) || cells.has(ref);
  if (!known(start)) throw new CliError(`No recall, read, or cell in this store has the ID ${start}.`, ExitCode.INVALID, 'lineage');

  const hops: LineageHop[] = [];
  const seen = new Set<string>();

  const walkRecall = (recall: Recall, depth: number, limit: string | null): void => {
    const day = dayOf(recall.at);
    if (limit !== null && day > limit) throw refuse(recall.id, day, limit);
    if (!evidencePredates(recall)) throw refuse(`the evidence of recall ${recall.id}`, recall.evidence.flatMap((item) => item.lastDay ?? []).sort().at(-1) ?? recall.poolVersion, day);
    hops.push({ depth, kind: 'recall', ref: recall.id, frames: framesOfRecall(recall), day, detail: `${recall.mode} ${recall.arm} ${recall.answer.kind}` });
    for (const evidence of recall.evidence) {
      if (known(evidence.ref)) {
        walk(evidence.ref, depth + 1, tighter(limit, day));
      } else if (!seen.has(evidence.ref)) {
        // A stand-in: the shape or signature hash a recall cites where no read was stored. The recall holds all there is to say of it.
        seen.add(evidence.ref);
        hops.push({ depth: depth + 1, kind: 'evidence', ref: evidence.ref, frames: framesOfEvidence(evidence), day: evidence.lastDay, detail: `${String(evidence.n)} sessions, ${String(evidence.clusters)} clusters, from ${String(evidence.firstDay)}` });
      }
    }
  };

  const walk = (ref: string, depth: number, limit: string | null): void => {
    if (seen.has(ref)) return;
    seen.add(ref);
    const recall = recalls.get(ref);
    if (recall !== undefined) {
      walkRecall(recall, depth, limit);
      return;
    }
    const read = reads.get(ref);
    if (read !== undefined) {
      if (limit !== null && read.asOf.day !== null && read.asOf.day > limit) throw refuse(ref, read.asOf.day, limit);
      hops.push({ depth, kind: 'read', ref, frames: framesOfRead(read, cells), day: read.asOf.day, detail: `${read.family}, order ${String(read.order)}, n ${String(read.n)}, ${String(read.clusters)} clusters, basis ${read.basis}` });
      for (const input of read.inputs) walk(input, depth + 1, limit);
      return;
    }
    const cell = cells.get(ref);
    if (cell !== undefined) {
      if (limit !== null && cell.day !== UNKNOWN && cell.day > limit) throw refuse(ref, cell.day, limit);
      hops.push({ depth, kind: 'cell', ref, frames: [cell.frameBucket], day: cell.day, detail: `${String(cell.sessions)} sessions, ${String(cell.ok)} ok, ${String(cell.failed)} failed${cell.exposed ? ', exposed' : ''}` });
      return;
    }
    // `cells.jsonl` holds the current pool only, so a read kept from an older pool can cite a cell since rewritten.
    hops.push({ depth, kind: 'missing', ref, frames: [], day: null, detail: 'not in the current pool' });
  };

  walk(start, 0, null);
  return hops;
};

export const formatLineage = (hops: readonly LineageHop[]): string =>
  hops.map((hop) => `${'  '.repeat(hop.depth)}${hop.kind} ${hop.ref} | ${hop.frames.join(', ') || 'frames unknown'} | ${hop.day ?? 'day unknown'} | ${hop.detail}`).join('\n');

const rowsOf = async <T>(file: string, isRow: (value: unknown) => value is T): Promise<T[]> => {
  let text = '';
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  return text.split('\n').flatMap((line) => {
    if (line === '') return [];
    try {
      const parsed: unknown = JSON.parse(line);
      return isRow(parsed) ? [parsed] : [];
    } catch {
      return [];
    }
  });
};

const isRead = (value: unknown): value is Read => typeof value === 'object' && value !== null && 'readId' in value && 'inputs' in value;
const isCell = (value: unknown): value is Cell => typeof value === 'object' && value !== null && 'motifId' in value && 'frameBucket' in value;

const readFiles = async (dir: string): Promise<string[]> => {
  try {
    return (await readdir(dir)).flatMap((name) => (name.endsWith('.jsonl') ? [join(dir, name)] : []));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
};

export const loadLineage = async (storeDir: string): Promise<LineageSources> => {
  const files = poolFiles(storeDir);
  const lists = await Promise.all((await readFiles(dirname(files.reads('any')))).map((file) => rowsOf(file, isRead)));
  return { recalls: await readRecalls(storeDir), reads: lists.flat(), cells: await rowsOf(files.cells, isCell) };
};
