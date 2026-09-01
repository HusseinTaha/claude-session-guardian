import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { userSettingsPath, stateDir, configPath } from '../core/paths.ts';
import { loadConfig, DEFAULT_CONFIG } from '../core/config.ts';

const BUNDLE = 'guardian.cjs';
/** Substring that identifies a status line command as Guardian's. */
const MARKER = BUNDLE;

/** Absolute path to this bundle, with forward slashes.
 *
 *  Windows matters here: the statusline docs warn that backslashes in a configured
 *  command get consumed as escape characters before the script runs when Git Bash is
 *  present, which is exactly this machine's setup. */
export function bundlePath(): string {
  const running = typeof __filename === 'string' ? __filename : process.argv[1] ?? '';
  const candidates = [
    // Explicit override, for development and for tests.
    process.env.GUARDIAN_BUNDLE,
    // Set whenever Guardian runs as an installed plugin.
    process.env.CLAUDE_PLUGIN_ROOT
      ? join(process.env.CLAUDE_PLUGIN_ROOT, 'dist', 'guardian.cjs')
      : null,
    // Normal case: we *are* the bundle.
    running.endsWith(BUNDLE) ? running : null,
    // Local checkout, or any other host file: find the bundle above us.
    findUp(running ? dirname(running) : process.cwd()),
  ];
  const p = candidates.find((c): c is string => !!c) ?? join(process.cwd(), 'dist', BUNDLE);
  return p.replace(/\\/g, '/');
}

/** Look for dist/<bundle> in this directory and its ancestors. */
function findUp(from: string, levels = 5): string | null {
  let dir = resolve(from);
  for (let i = 0; i <= levels; i++) {
    const candidate = join(dir, 'dist', BUNDLE);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function guardianCommand(sub: 'sense' | 'sense-agents'): string {
  return `node "${bundlePath()}" ${sub}`;
}

function readJson(p: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeJson(p: string, obj: unknown): void {
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
  renameSync(tmp, p);
}

export interface InstallResult {
  settingsFile: string;
  chained: string | null;
  alreadyInstalled: boolean;
}

/** Point the status line at Guardian, preserving whatever was there.
 *
 *  Silently replacing an existing status line would be a hostile install, so the previous
 *  command is recorded in the project config and re-run by the sensor on every tick. */
export function install(projectDir: string, settingsFile = userSettingsPath()): InstallResult {
  const settings = readJson(settingsFile);
  const existing = settings.statusLine as { command?: string } | undefined;
  const existingCmd = typeof existing?.command === 'string' ? existing.command : null;
  const alreadyInstalled = !!existingCmd?.includes(MARKER);

  let chained: string | null = null;
  if (existingCmd && !alreadyInstalled) chained = existingCmd;

  settings.statusLine = {
    type: 'command',
    command: guardianCommand('sense'),
    // Event-driven updates go quiet while the main session waits on background subagents;
    // a timer keeps the reset clock and burn rate honest during those stretches.
    refreshInterval: 10,
  };
  // Per-agent rows: context fill and pace, which is what informs a decision near a wall.
  // Not chained — the default rendering is what it replaces, and there is nothing to keep.
  settings.subagentStatusLine = {
    type: 'command',
    command: guardianCommand('sense-agents'),
  };
  writeJson(settingsFile, settings);

  const cfg = loadConfig(projectDir);
  const next = {
    ...cfg,
    statusline: {
      ...cfg.statusline,
      manage: true,
      chained_command: chained ?? cfg.statusline.chained_command,
    },
  };
  writeJson(configPath(projectDir), next);
  scaffoldStateDir(projectDir);

  return { settingsFile, chained, alreadyInstalled };
}

/** Restore the displaced status line and stop managing it. */
export function uninstall(projectDir: string, settingsFile = userSettingsPath()): string | null {
  const settings = readJson(settingsFile);
  const existing = settings.statusLine as { command?: string } | undefined;
  const cfg = loadConfig(projectDir);
  const restore = cfg.statusline.chained_command;

  const sub = settings.subagentStatusLine as { command?: string } | undefined;
  let changed = false;
  if (typeof existing?.command === 'string' && existing.command.includes(MARKER)) {
    if (restore) settings.statusLine = { type: 'command', command: restore };
    else delete settings.statusLine;
    changed = true;
  }
  if (typeof sub?.command === 'string' && sub.command.includes(MARKER)) {
    delete settings.subagentStatusLine;
    changed = true;
  }
  if (changed) writeJson(settingsFile, settings);

  writeJson(configPath(projectDir), {
    ...cfg,
    statusline: { ...cfg.statusline, manage: false, chained_command: null },
  });
  return restore;
}

/** Guardian state is local, disposable, and full of prompts and paths. It never belongs
 *  in a commit, so the directory ignores itself on creation. */
export function scaffoldStateDir(projectDir: string): void {
  const dir = stateDir(projectDir);
  mkdirSync(join(dir, 'sessions'), { recursive: true });
  mkdirSync(join(dir, 'logs'), { recursive: true });
  const ignore = join(dir, '.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n');
  const cfgFile = configPath(projectDir);
  if (!existsSync(cfgFile)) writeJson(cfgFile, DEFAULT_CONFIG);
}
