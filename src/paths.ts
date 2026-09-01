import { join, dirname, resolve } from 'node:path';
import { existsSync, realpathSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';

/** Guardian keeps state project-local so concurrent projects never collide. */
export function stateDir(projectDir: string): string {
  return join(projectDir, '.claude', 'guardian');
}

export function statePath(projectDir: string, sessionId: string): string {
  // Keyed by session so two sessions sharing a cwd never clobber each other.
  return join(stateDir(projectDir), 'sessions', `${sanitize(sessionId)}.json`);
}

export function configPath(projectDir: string): string {
  return join(stateDir(projectDir), 'config.json');
}

export function logPath(projectDir: string): string {
  return join(stateDir(projectDir), 'logs', 'guardian.log');
}

export function userSettingsPath(): string {
  return join(homedir(), '.claude', 'settings.json');
}

/** Session ids are UUIDs, but never trust an id straight into a path. */
export function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100) || 'unknown';
}

/** Hooks report only `cwd`, while the status line reports `workspace.project_dir`. If a
 *  session runs from a subdirectory those disagree, and Guardian would split its state
 *  across two roots. Walking up for a marker makes both agree on one root.
 *
 *  Markers are deliberately narrow: an existing Guardian directory, or a repository root.
 *  A bare `.claude` is NOT a marker — `~/.claude` is the user's own config directory, so
 *  treating it as one sends the state of every project under the home directory into it. */
export function resolveStateRoot(startDir: string): string {
  const start = real(resolve(startDir));
  const home = real(resolve(homedir()));
  let dir = start;
  for (let i = 0; i < 12; i++) {
    // Never ascend into or past the home directory looking for a project root.
    if (samePath(dir, home)) break;
    if (existsSync(join(dir, '.claude', 'guardian'))) return dir;
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

/** Windows hands out 8.3 short paths (HUSSEI~1.AZU) in some environment variables, which
 *  never string-compare equal to the long form. Resolve them where the path exists. */
function real(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function ledgerPath(projectDir: string, sessionId: string): string {
  return join(stateDir(projectDir), 'sessions', `${sanitize(sessionId)}.ledger.jsonl`);
}

export function handoffDir(projectDir: string): string {
  return join(stateDir(projectDir), 'handoff');
}

/** Create a directory inside the Guardian state tree, ensuring the tree ignores itself the
 *  first time it comes into existence.
 *
 *  This has to happen wherever Guardian first writes, not just in `install`: the state
 *  holds prompts, commands and paths, and a git checkpoint would otherwise capture it.
 *  `mkdirSync(recursive)` returns the first path it created, so the check costs nothing
 *  once the tree exists. */
export function ensureGuardianDir(projectDir: string, dir: string): void {
  const created = mkdirSync(dir, { recursive: true });
  if (!created) return;
  const ignore = join(stateDir(projectDir), '.gitignore');
  if (!existsSync(ignore)) {
    try {
      writeFileSync(ignore, '*\n');
    } catch {
      /* best effort */
    }
  }
}
