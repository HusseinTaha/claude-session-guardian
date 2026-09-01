import { join } from 'node:path';
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
