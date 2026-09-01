import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { sense } from './sense.ts';
import { install, uninstall, guardianCommand } from './install.ts';
import { loadConfig } from './config.ts';
import { readState } from './state.ts';
import { renderDashboard } from './render.ts';
import { statePath, userSettingsPath, resolveStateRoot, stateDir } from './paths.ts';
import { handle } from './hooks.ts';
import { appendEvent, type NoteField } from './ledger.ts';
import {
  seal,
  readLatest,
  markConsumed,
  verify,
  latestDigestPath,
  latestPath,
} from './manifest.ts';
import { removeCheckpoints, listCheckpoints } from './git.ts';

function readStdin(): string {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function now(): number {
  const override = Number(process.env.GUARDIAN_NOW);
  return Number.isFinite(override) && override > 0 ? override : Date.now() / 1000;
}

/** Most recent session in this project, for commands invoked outside a hook where no
 *  session id is on hand.
 *
 *  Must consider ledgers as well as state files: hooks create a ledger from the first tool
 *  call, while the state file only appears once the status line has run. Looking at state
 *  files alone sent `note` to a phantom session, so the objective and next action never
 *  reached the sealed manifest. */
function latestSession(projectDir: string): string | null {
  const SUFFIXES = ['.ledger.jsonl', '.json'];
  try {
    const dir = join(stateDir(projectDir), 'sessions');
    const seen = new Map<string, number>();
    for (const f of readdirSync(dir)) {
      const suffix = SUFFIXES.find((x) => f.endsWith(x));
      if (!suffix) continue;
      const sid = f.slice(0, -suffix.length);
      if (!sid) continue;
      const mtime = statSync(join(dir, f)).mtimeMs;
      seen.set(sid, Math.max(seen.get(sid) ?? 0, mtime));
    }
    return [...seen.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  } catch {
    return null;
  }
}

function flag(argv: string[], name: string): string | null {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] ?? null) : null;
}

const USAGE = `claude-guardian <command>

Sensor and status
  sense                    statusLine sensor: reads the payload on stdin, updates
                           state, prints the status segment
  status                   render the dashboard for this project's latest session

Handoff
  handoff [--reason R]     seal a handoff manifest now
           [--no-git]
  resume                   print the sealed handoff plus workspace verification,
                           and mark it consumed
  verify                   check the sealed manifest against the workspace
  note --objective|--next|--decision|--gotcha <text>
                           record what cannot be observed, for the next session

Setup
  install [--settings P]   point statusLine at Guardian, preserving any existing one
  uninstall [--settings P] restore the previous statusLine and delete checkpoint refs
  where                    print the command install would configure
  checkpoints              list Guardian's git checkpoint refs

Internal
  hook <EventName>         hook dispatch; reads the event payload on stdin
`;

const NOTE_FLAGS: Array<[string, NoteField]> = [
  ['--objective', 'objective'],
  ['--next', 'next_action'],
  ['--decision', 'decision'],
  ['--gotcha', 'gotcha'],
];

function cmdResume(projectDir: string, out: (s: string) => void): number {
  const m = readLatest(projectDir);
  if (!m) {
    out('No sealed handoff found for this project.\n');
    return 0;
  }
  let digest: string;
  try {
    digest = readFileSync(latestDigestPath(projectDir), 'utf8');
  } catch {
    digest = `(digest missing; manifest is at ${latestPath(projectDir)})`;
  }
  out(`${digest}\n`);

  const v = verify(projectDir, m);
  const by = (s: string) => v.files.filter((f) => f.status === s);
  const unchanged = by('unchanged').length;
  const changed = by('changed');
  const missing = by('missing');
  const unverifiable = by('unverifiable').length;

  out('## Workspace verification\n');
  if (unchanged) out(`- ${unchanged} file(s) unchanged since the handoff\n`);
  if (unverifiable) out(`- ${unverifiable} file(s) too large to hash; not verified\n`);
  if (changed.length) {
    out(`- CHANGED since the handoff (someone edited these outside it):\n`);
    for (const f of changed.slice(0, 15)) out(`    ${f.path}\n`);
    if (changed.length > 15) out(`    …and ${changed.length - 15} more\n`);
  }
  if (missing.length) {
    out(`- MISSING now:\n`);
    for (const f of missing.slice(0, 15)) out(`    ${f.path}\n`);
  }
  if (v.head_matches === true) out('- git HEAD is unchanged since the handoff\n');
  if (v.head_matches === false) out('- git HEAD has MOVED since the handoff\n');
  if (!changed.length && !missing.length && v.head_matches !== false) {
    out('\nThe workspace matches the handoff. Resume directly from "next action".\n');
  } else {
    out('\nThe workspace has drifted from the handoff. Reconcile the differences above\nbefore acting on "next action".\n');
  }

  markConsumed(projectDir, now());
  return 0;
}

function main(argv: string[]): number {
  const cmd = argv[0] ?? 'help';
  const out = (s: string) => process.stdout.write(s);

  // `hook` resolves its own root from the payload's cwd; everything else works from here.
  const projectDir = resolveStateRoot(process.cwd());
  const settingsFile = flag(argv, '--settings') ?? userSettingsPath();

  switch (cmd) {
    case 'sense':
      out(sense(readStdin(), now()));
      return 0;

    case 'hook': {
      const event = argv[1] ?? '';
      const r = handle(event, readStdin(), now());
      if (r.stdout) out(r.stdout);
      return r.exit;
    }

    case 'status': {
      const sid = latestSession(projectDir);
      if (!sid) {
        out('Guardian has no state for this project yet.\n');
        return 0;
      }
      out(`${renderDashboard(readState(projectDir, sid), loadConfig(projectDir))}\n`);
      out(`\nstate: ${statePath(projectDir, sid)}\n`);
      return 0;
    }

    case 'handoff': {
      const sid = latestSession(projectDir);
      if (!sid) {
        out('Guardian has no state for this project yet; nothing to seal.\n');
        return 0;
      }
      const reason = flag(argv, '--reason') ?? 'manual';
      const m = seal(projectDir, sid, readState(projectDir, sid), reason, now(), {
        git: !argv.includes('--no-git'),
      });
      const cp = m.observed.checkpoint;
      out(`Sealed handoff (${reason}).\n`);
      out(`  files tracked: ${m.observed.files_touched.length}\n`);
      out(`  commits:       ${m.observed.commits.length}\n`);
      out(`  checkpoint:    ${cp ? `${cp.kind}${cp.ref ? ` ${cp.ref}` : ''} — ${cp.detail}` : 'skipped'}\n`);
      out(`  manifest:      ${latestPath(projectDir)}\n`);
      if (!m.claude_supplied.next_action) {
        out('\nNo next action recorded. Add one so the next session does not have to guess:\n');
        out('  claude-guardian note --next "<the single most specific next step>"\n');
      }
      return 0;
    }

    case 'resume':
      return cmdResume(projectDir, out);

    case 'verify': {
      const m = readLatest(projectDir);
      if (!m) {
        out('No sealed handoff to verify.\n');
        return 0;
      }
      const v = verify(projectDir, m);
      for (const f of v.files) out(`${f.status.padEnd(13)} ${f.path}\n`);
      out(`\ngit HEAD: ${v.head_matches === null ? 'not comparable' : v.head_matches ? 'unchanged' : 'moved'}\n`);
      return 0;
    }

    case 'note': {
      const sid = latestSession(projectDir) ?? 'manual';
      let wrote = 0;
      for (const [f, field] of NOTE_FLAGS) {
        const text = flag(argv, f);
        if (text) {
          appendEvent(projectDir, sid, { k: 'note', t: now(), field, text });
          out(`recorded ${field}\n`);
          wrote++;
        }
      }
      if (!wrote) {
        out('Nothing recorded. Pass one of --objective, --next, --decision, --gotcha.\n');
        return 1;
      }
      return 0;
    }

    case 'install': {
      const r = install(projectDir, settingsFile);
      out(`Guardian installed.\n  settings: ${r.settingsFile}\n  command:  ${guardianCommand('sense')}\n`);
      out(
        r.alreadyInstalled
          ? '  (was already installed; refreshed)\n'
          : r.chained
            ? `  chained your existing status line: ${r.chained}\n`
            : '  no existing status line to chain\n',
      );
      out('\nRestart Claude Code — the status line command is read at startup.\n');
      return 0;
    }

    case 'uninstall': {
      const restored = uninstall(projectDir, settingsFile);
      const refs = removeCheckpoints(projectDir);
      out(`Guardian uninstalled.\n${restored ? `  restored: ${restored}\n` : '  statusLine removed\n'}`);
      out(`  checkpoint refs deleted: ${refs}\n`);
      out(`  state left in place at ${stateDir(projectDir)} (delete it to remove all traces)\n`);
      return 0;
    }

    case 'checkpoints': {
      const refs = listCheckpoints(projectDir);
      if (!refs.length) out('No Guardian checkpoints in this repository.\n');
      for (const r of refs) out(`${r}\n`);
      return 0;
    }

    case 'where':
      out(`${guardianCommand('sense')}\n`);
      return 0;

    case 'version':
      out('0.2.0\n');
      return 0;

    default:
      out(USAGE);
      return cmd === 'help' ? 0 : 1;
  }
}

// A watchdog that crashes the thing it is watching is worse than no watchdog. Every path
// out of this process is exit 0 with usable stdout, unless the user asked for a command
// that does not exist.
try {
  process.exitCode = main(process.argv.slice(2));
} catch {
  process.exitCode = 0;
}
