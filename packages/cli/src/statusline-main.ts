// The entry for the bare `oars statusline [--color]`: it imports the one reader it needs, never the CLI, because a status line runs it after every assistant message and
// a new update cancels a run still in flight. Stdin is never read (the host pipes JSON that this line does not use), nothing is sent or written, and the exit is 0.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defaultConfigDir } from './credentials.js';
import { statuslineLine } from './sessions/statusline.js';

const storeDir = join(defaultConfigDir(process.env, process.platform, homedir()), 'oars', 'sessions');
process.stdout.write(`${await statuslineLine({ storeDir, now: Date.now(), color: process.argv[3] === '--color' })}\n`);
