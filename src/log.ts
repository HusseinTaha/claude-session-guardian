import { appendFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { logPath, ensureGuardianDir } from './paths.ts';

/** Logging is best-effort by design: a watchdog that throws while recording a
 *  problem is worse than one that stays quiet. Never let this reach a caller. */
export function log(projectDir: string, level: 'info' | 'warn' | 'error', msg: string): void {
  try {
    const line = `${new Date().toISOString()} ${level.toUpperCase()} ${msg}\n`;
    const p = logPath(projectDir);
    ensureGuardianDir(projectDir, dirname(p));
    appendFileSync(p, line);
  } catch {
    /* deliberately swallowed */
  }
}
