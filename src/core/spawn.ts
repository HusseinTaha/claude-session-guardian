import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { writeFileSync, openSync, closeSync, unlinkSync, mkdirSync } from 'node:fs';
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
  const p = join(dir, `stdin.${process.pid}.${Date.now()}.txt`);
  let fd: number | null = null;
  try {
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(p, stdin);
      fd = openSync(p, 'r');
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
    try {
      unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
}
