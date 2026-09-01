import { readFileSync, existsSync } from 'node:fs';
import { sense } from './sensors/statusline.ts';
import { senseAgents } from './sensors/subagents.ts';
import { install, uninstall, guardianCommand } from './ui/install.ts';
import { loadConfig } from './core/config.ts';
import { readState } from './core/state.ts';
import { renderDashboard } from './format/render.ts';
import { statePath, userSettingsPath, resolveStateRoot, stateDir } from './core/paths.ts';
import { handle } from './actuators/dispatch.ts';
import { latestSessionIn as latestSession } from './core/sessions.ts';
import { serve as serveMcp } from './ui/mcp.ts';
import { appendEvent, type NoteField } from './handoff/ledger.ts';
import {
  seal,
  readLatest,
  markConsumed,
  verify,
  latestDigestPath,
  latestPath,
} from './handoff/manifest.ts';
import { removeCheckpoints, listCheckpoints } from './handoff/git.ts';
import { countdown } from './actuators/landing.ts';
import {
  audit,
  renderChecks,
  verdict,
  coldResume,
  logTail,
} from './ui/doctor.ts';
import { readAgents, typeStats } from './sensors/agents.ts';
import {
  flatten,
  getPath,
  setPath,
  unsetPath,
  coerceValue,
  validateConfig,
  readUserConfig,
  writeUserConfig,
  deleteUserConfig,
  HELP,
} from './ui/configCmd.ts';
import { configPath } from './core/paths.ts';
import { DEFAULT_CONFIG } from './core/config.ts';
import { fmtMin } from './budget/mode.ts';

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

function flag(argv: string[], name: string): string | null {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] ?? null) : null;
}

const USAGE = `claude-guardian <command>

Sensor and status
  sense                    statusLine sensor: reads the payload on stdin, updates
                           state, prints the status segment
  sense-agents             subagentStatusLine sensor: per-agent context and pace
  status                   render the dashboard for this project's latest session

Handoff
  handoff [--reason R]     seal a handoff manifest now
           [--no-git]
  resume                   print the sealed handoff plus workspace verification,
                           and mark it consumed
  wait                     countdown to a rate-limit window reopening
  verify                   check the sealed manifest against the workspace
  note --objective|--next|--decision|--gotcha <text>
                           record what cannot be observed, for the next session

Configuration
  config                   list every setting, its value, and whether it is overridden
  config get <setting>     print one value
  config set <setting> <value> [...]
                           change one or more settings, validated before writing
  config unset <setting>   return a setting to its default
  config reset             remove all overrides
  config check             validate the current config file
  config path              print the config file path
  on | off                 enable or disable Guardian for this project

Diagnostics
  doctor [--cold] [--seal] print a self-check: could a fresh session resume this work?
         [--keep] [--strict]  --cold additionally cold-resumes it with claude -p
  log [--lines N]          tail Guardian log (empty unless something failed)

Setup
  install [--settings P]   point statusLine at Guardian, preserving any existing one
  uninstall [--settings P] restore the previous statusLine and delete checkpoint refs
  where                    print the command install would configure
  checkpoints              list Guardian's git checkpoint refs

Internal
  hook <EventName>         hook dispatch; reads the event payload on stdin
  mcp                      run the optional MCP server on stdio (3 tools)
  agents                   show live subagents and historical durations by type
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


/** `guardian config` and its subcommands.
 *
 *  Settings are typed from the defaults rather than a separate schema, so a new option is
 *  configurable the moment it has a default and the two can never drift apart. */
function cmdConfig(projectDir: string, argv: string[], out: (s: string) => void): number {
  const sub = argv[1] ?? 'show';
  const file = configPath(projectDir);

  const report = (user: Record<string, unknown>): number => {
    const problems = validateConfig(user);
    for (const p of problems) {
      out(`${p.severity === 'error' ? 'error' : 'warning'}: ${p.path} — ${p.message}\n`);
    }
    return problems.some((p) => p.severity === 'error') ? 1 : 0;
  };

  switch (sub) {
    case 'show': {
      const user = readUserConfig(projectDir);
      const effective = loadConfig(projectDir);
      out(`Guardian settings for ${projectDir}\n`);
      out(`  file: ${file}${existsSync(file) ? '' : ' (none yet; showing defaults)'}\n\n`);
      let section = '';
      for (const [path, value] of flatten(effective)) {
        const top = path.split('.')[0]!;
        if (top !== section) {
          out(`\n`);
          section = top;
        }
        const overridden = getPath(user, path) !== undefined;
        const shown = JSON.stringify(value);
        const help = HELP[path] ?? '';
        out(
          `  ${path.padEnd(38)} ${shown.padEnd(14)} ${overridden ? 'set  ' : '     '} ${help}\n`,
        );
      }
      out(`\nChange one with:  /guardian config set <setting> <value>\n`);
      return report(user);
    }

    case 'get': {
      const path = argv[2];
      if (!path) {
        out('Usage: /guardian config get <setting>\n');
        return 1;
      }
      const v = getPath(loadConfig(projectDir), path);
      if (v === undefined) {
        out(`Unknown setting "${path}". Run /guardian config to list them.\n`);
        return 1;
      }
      out(`${JSON.stringify(v)}\n`);
      return 0;
    }

    case 'set': {
      const pairs = argv.slice(2);
      if (!pairs.length || pairs.length % 2 !== 0) {
        out('Usage: /guardian config set <setting> <value> [<setting> <value> ...]\n');
        return 1;
      }
      let user = readUserConfig(projectDir);
      const applied: string[] = [];
      for (let i = 0; i < pairs.length; i += 2) {
        const path = pairs[i]!;
        const raw = pairs[i + 1]!;
        const c = coerceValue(path, raw);
        if (!c.ok) {
          out(`error: ${path} — ${c.error}\n`);
          return 1;
        }
        user = setPath(user, path, c.value);
        applied.push(`${path} = ${JSON.stringify(c.value)}`);
      }
      // Validate the whole result before writing: a valid pair can still produce an
      // invalid configuration, such as land above prepare.
      const problems = validateConfig(user);
      const errors = problems.filter((p) => p.severity === 'error');
      if (errors.length) {
        for (const p of errors) out(`error: ${p.path} — ${p.message}\n`);
        out('\nNothing was written.\n');
        return 1;
      }
      writeUserConfig(projectDir, user);
      for (const a of applied) out(`set ${a}\n`);
      for (const p of problems) out(`warning: ${p.path} — ${p.message}\n`);
      out(`\n${file}\n`);
      if (applied.some((a) => a.startsWith('statusline.') || a.startsWith('render.'))) {
        out('Status line changes appear on the next tick.\n');
      }
      return 0;
    }

    case 'unset': {
      const path = argv[2];
      if (!path) {
        out('Usage: /guardian config unset <setting>\n');
        return 1;
      }
      const user = readUserConfig(projectDir);
      if (getPath(user, path) === undefined) {
        out(`"${path}" is not overridden; it is already at its default.\n`);
        return 0;
      }
      writeUserConfig(projectDir, unsetPath(user, path));
      out(`unset ${path} — back to default ${JSON.stringify(getPath(DEFAULT_CONFIG, path))}\n`);
      return 0;
    }

    case 'reset': {
      out(
        deleteUserConfig(projectDir)
          ? `Removed ${file}. Every setting is back to its default.\n`
          : 'No overrides to remove; everything is already at its defaults.\n',
      );
      return 0;
    }

    case 'check':
      return report(readUserConfig(projectDir));

    case 'path':
      out(`${file}\n`);
      return 0;

    default:
      out(`Unknown config subcommand "${sub}".\n`);
      out('Try: show, get, set, unset, reset, check, path\n');
      return 1;
  }
}


/** `guardian doctor` — the only check that covers what none of the unit tests can: whether
 *  a fresh session could actually pick this work up. */
function cmdDoctor(projectDir: string, argv: string[], out: (s: string) => void): number {
  const cold = argv.includes('--cold');
  const keep = argv.includes('--keep');
  const strict = argv.includes('--strict');

  if (argv.includes('--seal')) {
    const sid = latestSession(projectDir);
    if (sid) {
      seal(projectDir, sid, readState(projectDir, sid), 'doctor --seal', now());
      out('Sealed a fresh handoff first.\n\n');
    }
  }

  const sid = latestSession(projectDir);
  const state = sid ? readState(projectDir, sid) : null;
  const checks = audit(projectDir, state, now());

  out('Guardian self-check\n');
  out(`  project: ${projectDir}\n\n`);
  out(`${renderChecks(checks)}\n\n`);

  const v = verdict(checks);
  out(`${v.text}\n`);

  if (!cold) {
    out('\nThat was the static audit, which costs nothing. To test the handoff for real —\n');
    out('cold-resume it in a scratch worktree with a fresh model that has never seen this\n');
    out('session — run `/guardian doctor --cold`. That spends real budget.\n');
    return strict && !v.resumable ? 1 : 0;
  }

  const m = readLatest(projectDir);
  if (!m) {
    out('\nNo manifest to cold-resume.\n');
    return 1;
  }

  out('\nCold resume: building a scratch worktree at the checkpoint and asking a fresh\n');
  out('session what it would do, with only the handoff to go on...\n\n');

  const r = coldResume(projectDir, m, { keep });
  if (!r.ok) {
    out(`  [FAIL] cold resume: ${r.detail}\n`);
    return 1;
  }

  out(`  [ok  ] cold resume    ${r.detail}\n`);
  out(
    `  [${r.echoedNextAction ? 'ok  ' : 'warn'}] next action    ${
      r.echoedNextAction
        ? 'the cold session restated the recorded next action'
        : 'the cold session did not clearly restate the recorded next action'
    }\n`,
  );
  out(
    `  [${r.namedAFile ? 'ok  ' : 'warn'}] files          ${
      r.namedAFile
        ? 'it named at least one file the manifest records'
        : 'it named none of the files the manifest records'
    }\n`,
  );
  if (keep && r.worktree) out(`\n  worktree kept at ${r.worktree}\n`);

  out('\n--- what the cold session said ---\n');
  out(`${r.answer}\n`);
  out('--- end ---\n\n');
  out('Those two checks are keyword overlap, not comprehension. Read the answer: if a\n');
  out('model with no memory of this work could not say what to do next, neither could you\n');
  out('tomorrow, and the manifest needs a better `note --next`.\n');

  const failed = !r.echoedNextAction || !r.namedAFile || !v.resumable;
  return strict && failed ? 1 : 0;
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

    case 'sense-agents':
      out(senseAgents(readStdin(), now()));
      return 0;

    case 'hook': {
      const event = argv[1] ?? '';
      const r = handle(event, readStdin(), now());
      if (r.stdout) out(r.stdout);
      // Exit 2 is how a hook blocks, and stderr is what Claude is shown when it does.
      if (r.stderr) process.stderr.write(r.stderr);
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

    case 'mcp':
      // Blocks on stdin until the client disconnects.
      serveMcp(now);
      return 0;

    case 'doctor':
      return cmdDoctor(projectDir, argv, out);

    case 'log': {
      const n = Number(flag(argv, '--lines') ?? 40);
      out(`${logTail(projectDir, Number.isFinite(n) ? n : 40)}\n`);
      return 0;
    }

    case 'config':
      return cmdConfig(projectDir, argv, out);

    // The two switches worth having as one word each.
    case 'on':
    case 'off': {
      const enabled = cmd === 'on';
      writeUserConfig(projectDir, setPath(readUserConfig(projectDir), 'enabled', enabled));
      out(`Guardian ${enabled ? 'enabled' : 'disabled'} for this project.\n`);
      if (!enabled) out('The status line stays installed but says nothing.\n');
      return 0;
    }

    case 'wait': {
      const sid = latestSession(projectDir);
      const st = sid ? readState(projectDir, sid) : null;
      const hs = st?.hard_stop ?? null;
      if (!hs) {
        out('No rate-limit stop recorded for this project.\n');
        return 0;
      }
      const t = now();
      out(`Rate limit: ${hs.kind}\n`);
      out(`Refused at: ${new Date(hs.at * 1000).toISOString()}\n`);
      if (hs.resets_at) {
        out(`Reopens at: ${new Date(hs.resets_at * 1000).toISOString()}\n`);
        out(`Status:     ${countdown(hs.resets_at, t)}\n`);
      } else {
        out('Reopens at: unknown (the transcript did not record it)\n');
      }
      out('\nThe work is sealed. Run /guardian resume once the window reopens.\n');
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

    case 'agents': {
      const sid = latestSession(projectDir);
      const f = sid ? readAgents(projectDir, sid) : null;
      const live = f ? Object.values(f.agents) : [];
      if (!live.length) out('No live subagents recorded.\n');
      for (const a of live) {
        const ctx =
          a.context_window && a.token_count !== null
            ? `${((a.token_count / a.context_window) * 100).toFixed(0)}% ctx`
            : 'ctx unknown';
        const pace = a.tokens_per_min ? `${a.tokens_per_min.toFixed(0)} tok/min` : 'pace unknown';
        out(`${(a.name ?? a.type ?? a.id).padEnd(24)} ${ctx.padEnd(12)} ${pace}\n`);
      }
      const stats = typeStats(projectDir);
      const entries = Object.entries(stats);
      if (entries.length) {
        out('\nHistorical duration by agent type:\n');
        for (const [type, st] of entries) {
          out(`  ${type.padEnd(24)} median ${fmtMin(st.median_s / 60)} (n=${st.count})\n`);
        }
      } else {
        out('\nNo completed agents recorded yet, so no duration history.\n');
      }
      return 0;
    }

    case 'where':
      out(`${guardianCommand('sense')}\n`);
      return 0;

    case 'version':
      out('0.5.0\n');
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
