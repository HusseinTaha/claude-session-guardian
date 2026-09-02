import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  userSettingsPath,
  stateDir,
  configPath,
  settingsChain,
  resolveStateRoot,
} from '../core/paths.ts';
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

export interface InitResult {
  projectDir: string;
  /** The settings file Guardian wrote itself into. */
  settingsFile: string;
  /** The file that had been deciding the status line, which may be a different one. */
  displaced: string;
  /** Which layer that file is, for a message the user can act on. */
  scope: 'user' | 'project' | 'project-local';
  chained: string | null;
  alreadySensing: boolean;
}

/** Make Guardian sense *this* project, whatever its settings look like.
 *
 *  `install` wires the user's settings, which is right once per machine. It is not enough
 *  per project: a repo with its own `.claude/settings.json` status line overrides the user
 *  one outright, and Guardian is then installed, hooked, and completely blind there. This
 *  finds whichever file actually wins, points it at Guardian, and keeps what it displaced. */
export function init(startDir: string, userSettings = userSettingsPath()): InitResult {
  const projectDir = resolveStateRoot(startDir);
  const chain = settingsChain(projectDir, userSettings);

  // Highest precedence file that defines a status line at all; the user's if none does.
  // Tracked separately from the highest-precedence file that defines a status line which is
  // NOT Guardian's: once Guardian owns the top layer, that is the only place the chained
  // command can still be read from. Looking only at the deciding file left `chained_from`
  // null on every re-run — and `doctor` then advised `guardian init` to fix a thing that
  // `init` could not fix, which is worse than saying nothing.
  let settingsFile = chain[0]!;
  let existingCmd: string | null = null;
  let chainedFrom: string | null = null;
  let chainedCmd: string | null = null;
  for (const file of chain) {
    const cmd = (readJson(file).statusLine as { command?: string } | undefined)?.command;
    if (typeof cmd === 'string') {
      settingsFile = file;
      existingCmd = cmd;
      if (!cmd.includes(MARKER)) {
        chainedFrom = file;
        chainedCmd = cmd;
      }
    }
  }

  const alreadySensing = !!existingCmd?.includes(MARKER);
  const chained = chainedCmd;

  // Where to write is not the same question as who currently decides. `.claude/settings.json`
  // is usually committed, and Guardian's command carries an absolute path to one machine's
  // bundle — writing there would hand every teammate a broken status line. So a project
  // status line is overridden from `settings.local.json`, which is personal, gitignored by
  // convention, and higher precedence anyway.
  const target = settingsFile === chain[0] ? chain[0]! : chain[2]!;

  scaffoldStateDir(projectDir);
  if (!alreadySensing) {
    const settings = readJson(target);
    settings.statusLine = {
      type: 'command',
      command: guardianCommand('sense'),
      refreshInterval: 10,
    };
    settings.subagentStatusLine = { type: 'command', command: guardianCommand('sense-agents') };
    writeJson(target, settings);
  }

  const cfg = loadConfig(projectDir);
  writeJson(configPath(projectDir), {
    ...cfg,
    statusline: {
      ...cfg.statusline,
      manage: true,
      // Only overwrite when something was actually displaced: re-running init must not
      // erase a chained command recorded by an earlier run.
      chained_command: chained ?? cfg.statusline.chained_command,
      // Remember where it came from, not just what it said. Tools that manage their own
      // status line rewrite it — hive does — and a snapshot taken at init would keep
      // running last month's command while the tool's updates went nowhere.
      chained_from: chainedFrom ?? cfg.statusline.chained_from,
    },
  });

  const scope: InitResult['scope'] = target === chain[0] ? 'user' : 'project-local';
  // What Guardian is layered over: the file that would decide if Guardian were not there,
  // which is never Guardian's own file. Saying "overriding settings.local.json" while
  // writing settings.local.json described nothing.
  const displaced = chainedFrom ?? settingsFile;
  return { projectDir, settingsFile: target, displaced, scope, chained, alreadySensing };
}

/** The settings file that currently points at Guardian, highest precedence first, so an
 *  uninstall undoes whichever layer an install or an init actually wrote. */
export function findGuardianSettings(
  projectDir: string,
  userSettings = userSettingsPath(),
): string | null {
  for (const file of settingsChain(projectDir, userSettings).reverse()) {
    const cmd = (readJson(file).statusLine as { command?: string } | undefined)?.command;
    if (typeof cmd === 'string' && cmd.includes(MARKER)) return file;
  }
  return null;
}

/** Restore the displaced status line and stop managing it. */
export function uninstall(projectDir: string, settingsFile = userSettingsPath()): string | null {
  const settings = readJson(settingsFile);
  const existing = settings.statusLine as { command?: string } | undefined;
  const cfg = loadConfig(projectDir);
  const restore = cfg.statusline.chained_command;

  // Writing the displaced command back is right only when this file is where it lived.
  // `init` writes settings.local.json purely as an override, and restoring there would
  // leave a personal copy of the repo's own status line pinned above the repo's — so the
  // day someone changes the shared one, the stale copy silently keeps winning. When a
  // lower layer already says exactly this, the override is simply removed.
  const owned = !settingsChain(projectDir)
    .slice(0, Math.max(0, settingsChain(projectDir).indexOf(settingsFile)))
    .some((f) => (readJson(f).statusLine as { command?: string } | undefined)?.command === restore);

  const sub = settings.subagentStatusLine as { command?: string } | undefined;
  let changed = false;
  if (typeof existing?.command === 'string' && existing.command.includes(MARKER)) {
    if (restore && owned) settings.statusLine = { type: 'command', command: restore };
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
