import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { sense, resolveProjectDir } from './sense.ts';
import { install, uninstall, guardianCommand } from './install.ts';
import { loadConfig } from './config.ts';
import { readState } from './state.ts';
import { renderDashboard } from './render.ts';
import { statePath, userSettingsPath } from './paths.ts';

function readStdin(): string {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/** Newest session state in this project, for `status` invoked outside a hook where no
 *  session id is on hand. */
function latestSession(projectDir: string): string | null {
  try {
    const dir = join(projectDir, '.claude', 'guardian', 'sessions');
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    return files[0] ? files[0].f.replace(/\.json$/, '') : null;
  } catch {
    return null;
  }
}

const USAGE = `claude-guardian <command>

  sense                 statusLine sensor: reads the payload on stdin, updates state,
                        prints the status segment
  status                render the dashboard for the most recent session in this project
  install [--settings <path>]
                        point statusLine at Guardian, preserving any existing one
  uninstall [--settings <path>]
                        restore the previous statusLine
  where                 print the command install would configure
  version
`;

function main(argv: string[]): number {
  const cmd = argv[0] ?? 'help';
  const projectDir = process.cwd();
  const settingsIdx = argv.indexOf('--settings');
  const settingsFile = settingsIdx >= 0 ? argv[settingsIdx + 1] ?? userSettingsPath() : userSettingsPath();

  switch (cmd) {
    case 'sense': {
      // GUARDIAN_NOW lets a recorded session be replayed at its original timestamps,
      // which is how the ladder is demonstrated and how `doctor` will reproduce a handoff.
      const override = Number(process.env.GUARDIAN_NOW);
      process.stdout.write(sense(readStdin(), Number.isFinite(override) && override > 0 ? override : undefined));
      return 0;
    }
    case 'status': {
      const sid = latestSession(projectDir);
      if (!sid) {
        process.stdout.write('Guardian has no state for this project yet.\n');
        return 0;
      }
      const cfg = loadConfig(projectDir);
      process.stdout.write(`${renderDashboard(readState(projectDir, sid), cfg)}\n`);
      process.stdout.write(`\nstate: ${statePath(projectDir, sid)}\n`);
      return 0;
    }
    case 'install': {
      const r = install(projectDir, settingsFile);
      process.stdout.write(
        `Guardian installed.\n  settings: ${r.settingsFile}\n` +
          `  command:  ${guardianCommand('sense')}\n` +
          (r.alreadyInstalled
            ? '  (was already installed; refreshed)\n'
            : r.chained
              ? `  chained your existing status line: ${r.chained}\n`
              : '  no existing status line to chain\n'),
      );
      return 0;
    }
    case 'uninstall': {
      const restored = uninstall(projectDir, settingsFile);
      process.stdout.write(
        `Guardian uninstalled.\n${restored ? `  restored: ${restored}\n` : '  statusLine removed\n'}`,
      );
      return 0;
    }
    case 'where':
      process.stdout.write(`${guardianCommand('sense')}\n`);
      return 0;
    case 'version':
      process.stdout.write('0.1.0\n');
      return 0;
    default:
      process.stdout.write(USAGE);
      return cmd === 'help' ? 0 : 1;
  }
}

// A watchdog that crashes the thing it is watching is worse than no watchdog. Every path
// out of this process is exit 0 with usable stdout unless the user asked for something
// that does not exist.
try {
  process.exitCode = main(process.argv.slice(2));
} catch {
  process.exitCode = 0;
}
export { resolveProjectDir };
