import { readFileSync, existsSync } from 'node:fs';
import { sense } from './sensors/statusline.ts';
import { senseAgents } from './sensors/subagents.ts';
import { install, init, uninstall, findGuardianSettings, guardianCommand } from './ui/install.ts';
import { loadConfig } from './core/config.ts';
import { readState, writeState } from './core/state.ts';
import { renderDashboard, fmtTokens } from './format/render.ts';
import { statePath, userSettingsPath, resolveStateRoot, stateDir } from './core/paths.ts';
import { handle } from './actuators/dispatch.ts';
import { latestSessionIn as latestSession } from './core/sessions.ts';
import { serve as serveMcp } from './ui/mcp.ts';
import { appendEvent, type NoteField } from './handoff/ledger.ts';
import {
  seal,
  readLatest,
  readBestHandoff,
  markConsumed,
  verify,
  renderDigest,
  describeSuperseded,
  staleAge,
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
import { fmtMin, fmtElapsed } from './budget/mode.ts';

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

const USAGE = `guardian <command>

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
  init                     set up Guardian for the project you are in, whichever
                           settings file actually decides its status line
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
  const ref = readBestHandoff(projectDir);
  if (!ref) {
    out('No sealed handoff found for this project.\n');
    return 0;
  }
  const m = ref.manifest;
  // Say where this came from. `latest` holding nothing while the real handoff sits in
  // history is exactly the failure that reads as "Guardian handed you nothing", and a
  // digest that arrives unexplained invites the same conclusion twice.
  if (ref.rescued) {
    out(`> The handoff on offer recorded nothing. This is the most recent one that does,\n`);
    out(`> read from ${ref.path}. It is now the one on offer.\n\n`);
  }
  let digest: string;
  if (ref.rescued) {
    // A rescued manifest has no digest file of its own: latest.md belongs to whatever
    // displaced it.
    digest = renderDigest(m, projectDir);
  } else {
    try {
      digest = readFileSync(latestDigestPath(projectDir), 'utf8');
    } catch {
      digest = `(digest missing; manifest is at ${latestPath(projectDir)})`;
    }
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
  const stale = m.claude_supplied.next_action_superseded;
  if (!changed.length && !missing.length && v.head_matches !== false) {
    // "Resume directly from next action" over a next action the digest just marked STALE is
    // the summary line disagreeing with the document above it.
    out(
      stale
        ? '\nThe workspace matches the handoff, but its "next action" is stale: re-derive the\nnext step from the sections above before acting.\n'
        : '\nThe workspace matches the handoff. Resume directly from "next action".\n',
    );
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

  const m = readBestHandoff(projectDir)?.manifest ?? null;
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
  // Only a real check when there is something to name. Marking a cold session down for
  // naming none of zero recorded files punishes it for being right, and buries the actual
  // problem — that nothing was recorded — under a warning about the reader.
  const hasFiles = m.observed.files_touched.length > 0;
  out(
    hasFiles
      ? `  [${r.namedAFile ? 'ok  ' : 'warn'}] files          ${
          r.namedAFile
            ? 'it named at least one file the manifest records'
            : 'it named none of the files the manifest records'
        }\n`
      : '  [--  ] files          the manifest records none, so there was nothing to name\n',
  );
  if (keep && r.worktree) out(`\n  worktree kept at ${r.worktree}\n`);

  out('\n--- what the cold session said ---\n');
  out(`${r.answer}\n`);
  out('--- end ---\n\n');
  out('Those two checks are keyword overlap, not comprehension. Read the answer: if a\n');
  out('model with no memory of this work could not say what to do next, neither could you\n');
  out('tomorrow, and the manifest needs a better `note --next`.\n');

  const failed = !r.echoedNextAction || (hasFiles && !r.namedAFile) || !v.resumable;
  return strict && failed ? 1 : 0;
}

function main(argv: string[]): number {
  // No arguments means "how am I doing", not "explain yourself" — `--help` is there for
  // that. It also lets a slash command pass `$ARGUMENTS` straight through: the shell
  // default form `${ARGUMENTS:-status}` looks like it handles the empty case and does not,
  // because whoever expands it first sees an unset variable and silently wins.
  const cmd = argv[0] ?? 'status';
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
      const state = readState(projectDir, sid);
      const m = seal(projectDir, sid, state, reason, now(), {
        git: !argv.includes('--no-git'),
      });
      // The hook path records the seal in state; sealing by hand has to as well, or the
      // dashboard goes on saying "Manifest: not sealed" with a sealed manifest on disk —
      // a gauge contradicting the thing it is gauging.
      writeState(projectDir, { ...state, manifest: { sealed_at: m.sealed_at } });
      const cp = m.observed.checkpoint;
      out(`Sealed handoff (${reason}).\n`);
      // A seal that recorded nothing does not displace a real handoff. Saying "sealed"
      // without saying that leaves the report contradicting the file it names.
      const onOffer = readLatest(projectDir);
      if (!onOffer || onOffer.sealed_at !== m.sealed_at || onOffer.session.id !== m.session.id) {
        out('  NOT on offer:  this session recorded nothing, so `latest` still holds the\n');
        out(`                 handoff from session ${onOffer?.session.id ?? 'unknown'} `);
        out(`(${onOffer?.observed.files_touched.length ?? 0} file(s)). This seal is\n`);
        out('                 archived under handoff/history.\n');
      }
      out(`  files tracked: ${m.observed.files_touched.length}\n`);
      out(`  commits:       ${m.observed.commits.length}\n`);
      out(`  checkpoint:    ${cp ? `${cp.kind}${cp.ref ? ` ${cp.ref}` : ''} — ${cp.detail}` : 'skipped'}\n`);
      out(`  manifest:      ${latestPath(projectDir)}\n`);
      // Say it here, where the assumption is made. Sealing does not pause an agent — a
      // subagent's state is its context, and nothing can freeze or restore that. What the
      // manifest carries is which ones were still running and what redoing them costs.
      const flying = m.agents.filter((a) => a.status === 'IN_FLIGHT_AT_SEAL');
      if (flying.length) {
        out(`\n  ${flying.length} agent(s) were still running and are NOT paused by this seal:\n`);
        for (const a of flying) out(`    ${a.type} (${a.id}) — redo cost ${a.redo_cost_estimate}\n`);
        out('  They keep going. The manifest records them so the next session knows what\n');
        out('  may need redoing; let them finish if you can.\n');
      }
      const sup = m.claude_supplied.next_action_superseded;
      if (!m.claude_supplied.next_action) {
        out('\nNo next action recorded. Add one so the next session does not have to guess:\n');
        out('  guardian note --next "<the single most specific next step>"\n');
      } else if (sup) {
        out(`\nThe next action in this handoff is ${staleAge(m)} old, and `);
        out(`${describeSuperseded(sup)} were recorded after it. It describes work that\n`);
        out('has since happened. Replace it and seal again:\n');
        out('  guardian note --next "<the single most specific next step>"\n');
        out(`  guardian handoff --reason "${reason}"\n`);
      }
      const silent = m.agents.filter((a) => a.status === 'IN_FLIGHT_AT_SEAL' && !a.notes_recorded);
      if (silent.length) {
        out(`\n${silent.length} running agent(s) have written nothing down, so their work is\n`);
        out('not in this handoff. Let them return before you stop if you can:\n');
        for (const a of silent) out(`    ${a.type} (${a.id}) — ${a.description ?? 'no description'}\n`);
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
      const ref = readBestHandoff(projectDir);
      if (!ref) {
        out('No sealed handoff to verify.\n');
        return 0;
      }
      const m = ref.manifest;
      if (ref.rescued) out(`(latest records nothing; verifying ${ref.path} instead)\n\n`);
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

    case 'init': {
      const r = init(projectDir);
      const where =
        r.scope === 'user'
          ? 'your user settings — this covers every project that has none of its own'
          : `this project only, overriding ${r.displaced}\n            (settings.local.json is personal, so no absolute path reaches the repo)`;
      out(`Guardian initialised for ${r.projectDir}\n`);
      out(`  settings: ${r.settingsFile}\n            ${where}\n`);
      out(`  state:    ${stateDir(r.projectDir)} (ignores itself; nothing to add to .gitignore)\n`);
      if (r.alreadySensing) {
        out('  status line already points at Guardian; state directory verified.\n');
      } else if (r.chained) {
        out(`  kept the status line that was there, and runs it first:\n    ${r.chained}\n`);
      } else {
        out('  no existing status line to keep.\n');
      }
      out('\nRestart Claude Code — the status line command is read at startup.\n');
      return 0;
    }

    case 'uninstall': {
      // Undo whichever layer actually points at Guardian: `init` may have written the
      // project's settings.local.json rather than the user file.
      const file = flag(argv, '--settings') ?? findGuardianSettings(projectDir) ?? settingsFile;
      const restored = uninstall(projectDir, file);
      const refs = removeCheckpoints(projectDir);
      // Say which of the two actually happened. When Guardian was only an override layer,
      // nothing is written back — the file below it simply decides again, and calling that
      // "restored" would describe a write that did not occur.
      const wroteBack = existsSync(file) && readFileSync(file, 'utf8').includes('"statusLine"');
      out('Guardian uninstalled.\n');
      out(
        restored
          ? wroteBack
            ? `  restored: ${restored}\n`
            : `  override removed from ${file}\n  back in charge: ${restored}\n`
          : '  statusLine removed\n',
      );
      out(`  checkpoint refs deleted: ${refs}\n`);
      out(`  state left in place at ${stateDir(projectDir)} (delete it to remove all traces)\n`);
      // `install` and `init` can each have wired a different layer. Sweeping them all here
      // would be worse than saying so: only one displaced command is recorded per project,
      // so a second layer would be cleared with nothing left to put back in its place.
      const remaining = findGuardianSettings(projectDir);
      if (remaining) {
        out(`\nStill wired at ${remaining}.\n`);
        out(`  guardian uninstall --settings "${remaining}"\n`);
        out('  That layer has no recorded status line to restore, so it will be removed.\n');
      }
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
      else {
        const stats0 = typeStats(projectDir);
        // A table, not a paragraph: these columns are compared down the page, and a ragged
        // one hides the outlier that the whole display exists to surface. Widths come from
        // the data -- a padEnd(24) guess is exactly where alignment breaks.
        const rows = live.map((a) => {
          const typical = a.type ? stats0[a.type] : undefined;
          return [
            a.name ?? a.type ?? a.id,
            a.context_window && a.token_count !== null
              ? `${fmtTokens(a.token_count)}/${fmtTokens(a.context_window)}`
              : a.token_count !== null
                ? fmtTokens(a.token_count)
                : '—',
            a.context_window && a.token_count !== null
              ? `${((a.token_count / a.context_window) * 100).toFixed(0)}%`
              : '—',
            a.tokens_per_min ? `${fmtTokens(a.tokens_per_min)}/min` : '—',
            a.started_at ? fmtElapsed((now() - a.started_at) / 60) : '—',
            typical ? `≈${fmtMin(typical.median_s / 60)}` : '—',
          ];
        });
        const header = ['AGENT', 'CONTEXT', 'FULL', 'PACE', 'ELAPSED', 'TYPICAL'];
        // Only the name reads left-to-right; every other column is a quantity, and quantities
        // line up on the right or they cannot be compared at a glance.
        const right = [false, true, true, true, true, true];
        const w = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
        const line = (cells: string[]) =>
          cells
            .map((c, i) => (right[i] ? c.padStart(w[i]!) : c.padEnd(w[i]!)))
            .join('  ')
            .trimEnd();
        out(`${line(header)}\n`);
        for (const r of rows) out(`${line(r)}\n`);
      }
      const stats = typeStats(projectDir);
      const entries = Object.entries(stats);
      if (entries.length) {
        out('\nHistorical duration by agent type:\n');
        const tw = Math.max(...entries.map(([t]) => t.length));
        for (const [type, st] of entries) {
          out(`  ${type.padEnd(tw)}  median ${String(fmtMin(st.median_s / 60)).padStart(6)}  (n=${st.count})\n`);
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
