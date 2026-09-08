import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  writeFileSync,
  openSync,
  closeSync,
  unlinkSync,
  mkdirSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface StdinSpawn {
  cwd?: string;
  timeoutMs: number;
  /** Needed for a `.cmd` shim like `claude`, and precisely what breaks the timeout. */
  shell?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Where the payload file is written. Callers with a state directory pass it so the
   *  file lands somewhere already ignored; everything else gets the OS temp dir. */
  payloadDir?: string;
}

/** The payload filename, and the only thing the sweep below will delete.
 *
 *  A pattern rather than an age alone, because the default payload directory is the OS temp
 *  dir, which belongs to everybody. Age-only is safe in a directory a tool owns outright;
 *  here it would delete other people's files. */
const PAYLOAD_NAME = /^stdin\.\d+\.\d+\.txt$/;

/**
 * How old a payload has to be before it is certainly residue rather than in use.
 *
 * Derived, not round: the longest cap any caller passes is doctor's 240s cold session, so a
 * payload still being read is at most about that old. Guardian also runs concurrently in
 * every open session, and deleting a live sibling's payload would hand it an empty stdin —
 * a worse bug than the leak. Ten minutes clears every cap with room to spare.
 */
const RESIDUE_MAX_AGE_MS = 10 * 60 * 1000;

/** Bounded per call, so a directory holding thousands of strays cannot become the stall
 *  this file exists to prevent. It drains over consecutive runs instead. */
const RESIDUE_SWEEP_LIMIT = 200;

/**
 * Delete payloads left behind by processes that never reached their own cleanup.
 *
 * The `finally` below cannot run when the process is killed, and being killed is routine
 * for a status line: Claude Code terminates one it has superseded. That left one file per
 * killed run, in a directory nothing ever emptied — 985 of them, 69MB, in one project's
 * state directory, growing 200-400 a day. The early unlink closes that hole going forward;
 * this clears what earlier builds already dropped, and the sliver between writing the file
 * and unlinking it.
 */
export function sweepPayloadResidue(dir: string, limit = RESIDUE_SWEEP_LIMIT): number {
  const cutoff = Date.now() - RESIDUE_MAX_AGE_MS;
  let removed = 0;
  try {
    for (const name of readdirSync(dir)) {
      if (removed >= limit) break;
      if (!PAYLOAD_NAME.test(name)) continue;
      const f = join(dir, name);
      try {
        if (statSync(f).mtimeMs < cutoff) {
          unlinkSync(f);
          removed++;
        }
      } catch {
        // Raced with another sweep, or not a plain file. Not ours to worry about.
      }
    }
  } catch {
    // No directory yet — nothing has leaked because nothing has run.
  }
  return removed;
}

/** Swept once per directory per process. Callers pass different payload directories, and a
 *  status line is short-lived enough that its first spawn is the right moment. */
const sweptDirs = new Set<string>();

/**
 * Run a command with a payload on stdin, and have `timeout` actually bound it.
 *
 * `spawnSync`'s timeout kills the process it started. With `shell: true` that is the shell,
 * not the grandchild the shell started — and while Node holds a stdin pipe open for that
 * grandchild, the call goes on waiting for it regardless of the cap. Measured on Windows
 * against a child that runs for 3s: a 300ms cap returned after 3139ms with `input`, and
 * after 309ms with stdin on a file descriptor.
 *
 * So the payload goes into a file and the child reads a descriptor. Same contract — the
 * command still reads from stdin — and the cap holds.
 *
 * This was fixed for the chained status line in 0.7.1 and left in place for `doctor`'s cold
 * session, whose 240s cap bounded a `cmd.exe` that had already handed off. One helper now,
 * so the next caller inherits the fix instead of the bug.
 */
export function spawnWithStdinFile(
  cmd: string,
  args: string[] | null,
  stdin: string,
  opts: StdinSpawn,
): SpawnSyncReturns<string> {
  const base = {
    encoding: 'utf8' as const,
    cwd: opts.cwd,
    timeout: Math.max(100, opts.timeoutMs),
    windowsHide: true,
    shell: opts.shell ?? false,
    env: opts.env ?? process.env,
  };
  const run = (extra: Record<string, unknown>): SpawnSyncReturns<string> =>
    args === null
      ? (spawnSync(cmd, { ...base, ...extra }) as SpawnSyncReturns<string>)
      : (spawnSync(cmd, args, { ...base, ...extra }) as SpawnSyncReturns<string>);

  const dir = opts.payloadDir ?? tmpdir();
  if (!sweptDirs.has(dir)) {
    sweptDirs.add(dir);
    sweepPayloadResidue(dir);
  }

  const p = join(dir, `stdin.${process.pid}.${Date.now()}.txt`);
  let fd: number | null = null;
  /** Whether the payload still has a name that only we will ever clean up. */
  let named = true;
  try {
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(p, stdin);
      fd = openSync(p, 'r');
      // Hand the payload to the OS before the child exists. The descriptor keeps the bytes
      // reachable for us and for the copy the child inherits, but the name is already gone,
      // so from here on nothing we do or fail to do can leave a file behind — and being
      // killed mid-spawn is the normal end of a status line, not an edge case. Verified on
      // Windows: the child still reads the whole payload through the inherited handle, with
      // and without a shell in between.
      try {
        unlinkSync(p);
        named = false;
      } catch {
        // Kept its name: the sweep above collects it if we never reach the finally.
      }
      return run({ stdio: [fd, 'pipe', 'pipe'] });
    } catch {
      // Nowhere to put the payload: the pipe still delivers it, the cap just cannot be
      // trusted. A command that runs is worth more than one that is punctual.
      return run({ input: stdin });
    }
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    if (named) {
      try {
        unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
  }
}
