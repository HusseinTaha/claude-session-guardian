import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { AXES, type AxisName, type AxisState, type GuardianConfig, type GuardianState, type Sample, type StatusLinePayload } from '../types.ts';
import { loadConfig } from '../core/config.ts';
import { join, dirname } from 'node:path';
import { resolveStateRoot, stateDir, ensureGuardianDir } from '../core/paths.ts';
import { readState, writeState } from '../core/state.ts';
import { recordSample, rawBurnRate, smooth } from '../budget/burn.ts';
import { axisMode, decide, timeToWall, severity } from '../budget/mode.ts';
import { readAgents, liveCount } from './agents.ts';
import { renderStatus } from '../format/render.ts';
import { log } from '../core/log.ts';

export function resolveProjectDir(p: StatusLinePayload): string {
  const start = p.workspace?.project_dir || p.workspace?.current_dir || p.cwd || process.cwd();
  // Run it through the same root resolution the hooks use, so the sensor and the
  // actuators never end up writing to two different state directories.
  return resolveStateRoot(start);
}

/** Percentages arrive as `number | null | undefined` depending on how early in the session
 *  we are and whether the account exposes rate limits at all. Normalise to `undefined`
 *  for "not observed", which `recordSample` and `rawBurnRate` both skip. */
function pct(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function sampleFrom(p: StatusLinePayload, now: number): Sample {
  const rl = p.rate_limits ?? undefined;
  const s: Sample = { t: now };
  const ctx = pct(p.context_window?.used_percentage);
  if (ctx !== undefined) s.context = ctx;
  const fh = pct(rl?.five_hour?.used_percentage);
  if (fh !== undefined) s.five_hour = fh;
  const sd = pct(rl?.seven_day?.used_percentage);
  if (sd !== undefined) s.seven_day = sd;
  const sp = pct(rl?.spend_limit?.used_percentage);
  if (sp !== undefined) s.spend = sp;
  return s;
}

function resetsAtFor(p: StatusLinePayload, axis: AxisName): number | null {
  const rl = p.rate_limits ?? undefined;
  switch (axis) {
    case 'five_hour':
      return pct(rl?.five_hour?.resets_at) ?? null;
    case 'seven_day':
      return pct(rl?.seven_day?.resets_at) ?? null;
    case 'spend':
      return pct(rl?.spend_limit?.resets_at) ?? null;
    default:
      return null; // the context window has no scheduled refill
  }
}

/** Pure core of the sensor: previous state + payload -> next state. Kept free of I/O so
 *  the mode ladder can be tested against golden payloads. */
export function computeState(
  prev: GuardianState,
  payload: StatusLinePayload,
  cfg: GuardianConfig,
  now: number,
  agentsLive = 0,
): GuardianState {
  const samples = recordSample(prev.samples, sampleFrom(payload, now), cfg);
  const latest = samples[samples.length - 1];
  const axes: Partial<Record<AxisName, AxisState>> = {};

  for (const axis of AXES) {
    if (!cfg.axes[axis]) continue;
    const observed = latest?.[axis];
    // Carry the last known percentage forward: a tick can omit an axis (rate_limits is
    // dropped once a window's resets_at passes) without that axis becoming unknown.
    const used = observed ?? prev.axes[axis]?.used_pct ?? null;
    if (used === null) continue;

    const burn = smooth(
      rawBurnRate(samples, axis, cfg, now),
      prev.axes[axis]?.burn_pct_per_min ?? null,
      cfg.burn.alpha,
    );
    const resetsAt = resetsAtFor(payload, axis) ?? prev.axes[axis]?.resets_at ?? null;
    const st: AxisState = {
      used_pct: used,
      burn_pct_per_min: burn,
      resets_at: resetsAt,
      time_to_wall_min: null,
      mode: 'NORMAL',
    };
    st.time_to_wall_min = timeToWall(
      st.used_pct,
      st.burn_pct_per_min,
      st.resets_at,
      now,
      cfg.burn.reset_margin_min,
    );
    st.mode = axisMode(axis, st, cfg);
    axes[axis] = st;
  }

  const d = decide(axes, cfg, now);

  // A recorded hard stop outranks anything the gauges say: once the API has returned 429,
  // the only fact that matters is when the window reopens.
  const stillStopped =
    prev.mode === 'HARD_STOPPED' &&
    Object.values(axes).some((a) => a?.resets_at != null && a.resets_at > now);

  const mode = stillStopped ? 'HARD_STOPPED' : d.mode;

  return {
    ...prev,
    schema: 1,
    updated_at: now,
    mode,
    reason: stillStopped ? prev.reason : d.reason,
    binding_axis: stillStopped ? prev.binding_axis : d.binding_axis,
    axes,
    samples,
    cost_usd: pct(payload.cost?.total_cost_usd) ?? prev.cost_usd,
    model: payload.model?.display_name ?? prev.model,
    agents: {
      live: agentsLive,
      spawn_allowed: severity(mode) < severity(cfg.agents.deny_spawn_from),
    },
  };
}

/** Expand the shell-style variables Claude Code expands before running a configured
 *  command: `$NAME`, `${NAME}` and `${NAME:-fallback}`.
 *
 *  Guardian has to do this itself. A chained command reaches it as literal text and is
 *  re-run through `shell: true`, which on Windows is cmd.exe — and cmd.exe has never
 *  heard of `${...}`. A project status line written as
 *  `node "${CLAUDE_PROJECT_DIR:-.}/.claude/helpers/bar.cjs"` would resolve to a path with
 *  that brace expression in it, fail to load, and silently vanish from the bar. */
export function expandVars(cmd: string, env: Record<string, string | undefined>): string {
  return cmd
    .replace(/\$\{(\w+)(?::-([^}]*))?\}/g, (_m, name: string, fallback?: string) => {
      const v = env[name];
      return v !== undefined && v !== '' ? v : (fallback ?? '');
    })
    .replace(/\$(\w+)/g, (m, name: string) => env[name] ?? m);
}

/** Run the chained command with the payload on a file descriptor instead of a pipe.
 *
 *  `spawnSync`'s timeout kills the shell it started, not the grandchild that shell started,
 *  and while Node holds a stdin pipe open for that grandchild the call goes on waiting for
 *  it. Measured on Windows against a child that runs for 3s: a 300ms cap returned after
 *  3139ms with `input`, and after 309ms with stdin on a descriptor. So the cap was not a
 *  cap — a slow bar held the status line for however long it actually took, which is what
 *  made the whole line above Guardian disappear while a dozen agents were running rather
 *  than just the chained segment.
 *
 *  Same payload, same contract: the command still reads its JSON from stdin. */
function spawnChained(
  cmd: string,
  stdin: string,
  projectDir: string,
  cfg: GuardianConfig,
  env: Record<string, string | undefined>,
): SpawnSyncReturns<string> {
  const base = {
    shell: true,
    encoding: 'utf8' as const,
    timeout: Math.max(100, cfg.statusline.chain_timeout_ms),
    windowsHide: true,
    env,
  };
  const p = join(stateDir(projectDir), `chain-stdin.${process.pid}.json`);
  let fd: number | null = null;
  try {
    ensureGuardianDir(projectDir, dirname(p));
    writeFileSync(p, stdin);
    fd = openSync(p, 'r');
    return spawnSync(cmd, { ...base, stdio: [fd, 'pipe', 'pipe'] });
  } catch {
    // Nowhere to put the payload: the pipe still delivers it, the cap just cannot be
    // trusted. A bar that runs is worth more than one that is punctual.
    return spawnSync(cmd, { ...base, input: stdin });
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

/** Where the last bar the chained command actually produced is kept. */
function chainedCachePath(projectDir: string): string {
  return join(stateDir(projectDir), 'chained-bar.txt');
}

/** How old a kept bar may be before dots are the honest answer.
 *
 *  A constant, not a knob. The question it settles is not a preference: below this the
 *  segment is the user's own bar a few ticks late, and above it the counts in it have
 *  probably moved enough to mislead. */
const CHAINED_CACHE_MAX_AGE_S = 600;

export interface ChainedResult {
  text: string;
  /** `fresh` ran and produced this; `cached` is the last bar it produced, reused because
   *  this run failed; `none` means there was nothing to show. */
  source: 'fresh' | 'cached' | 'none';
  /** Seconds since the cached bar was produced. Only set for `cached`. */
  age_s?: number;
}

function keepChained(projectDir: string, text: string, now: number): void {
  try {
    const p = chainedCachePath(projectDir);
    ensureGuardianDir(projectDir, dirname(p));
    // Written whole. A tick that read a half-written cache would put a torn escape sequence
    // on the bar, and the bar is the one surface nobody can debug from.
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, `${Math.floor(now)}\n${text}`);
    renameSync(tmp, p);
  } catch {
    /* a cache that cannot be written costs a fallback, never a tick */
  }
}

function lastChained(projectDir: string, now: number): { text: string; age_s: number } | null {
  try {
    const raw = readFileSync(chainedCachePath(projectDir), 'utf8');
    const nl = raw.indexOf('\n');
    if (nl < 0) return null;
    const t = Number(raw.slice(0, nl));
    const text = raw.slice(nl + 1);
    if (!Number.isFinite(t) || !text.trim()) return null;
    const age = Math.max(0, now - t);
    return age <= CHAINED_CACHE_MAX_AGE_S ? { text, age_s: age } : null;
  } catch {
    return null;
  }
}

/** Run the status line command Guardian displaced, so installing Guardian never costs the
 *  user the status line they already had.
 *
 *  The timeout is generous and configurable because the alternative is worse than a slow
 *  bar: a 1.5s limit silently deleted a status line that took 2.8s to build in a large
 *  repository, and the only visible effect was two tools disappearing from the line with
 *  no error anywhere. Whatever that command costs, it cost the same before Guardian was
 *  in front of it. */
function runChained(
  cmd: string,
  stdin: string,
  projectDir: string,
  cfg: GuardianConfig,
  now: number,
): ChainedResult {
  try {
    // Claude Code sets this for the command it launches; the chained one is launched by
    // Guardian instead, so it has to be supplied here or the child sees nothing.
    const env = { ...process.env, CLAUDE_PROJECT_DIR: projectDir };
    const r = spawnChained(expandVars(cmd, env), stdin, projectDir, cfg, env);
    const text = (r.stdout ?? '').trim();
    if (text) {
      keepChained(projectDir, text, now);
      return { text, source: 'fresh' };
    }
    // Killed by the timeout, or died. Say so somewhere: a bar that quietly loses a segment
    // is indistinguishable from a bar whose other tool decided it had nothing to report.
    if (r.signal || r.error || r.status !== 0) {
      const why = r.signal
        ? `killed after ${cfg.statusline.chain_timeout_ms}ms`
        : (r.error?.message ?? `exit ${r.status}`);
      // A bar that took 700ms on a quiet machine takes longer than the cap while a dozen
      // agents run, which is exactly when the user is watching it. Replacing their whole
      // segment with three dots at that moment loses real information for no gain — the
      // last bar it produced is still broadly true, so show that and mark it as late.
      const kept = lastChained(projectDir, now);
      log(
        projectDir,
        'warn',
        `chained status line produced nothing (${why}): ${cmd}` +
          (kept ? ` — showing the bar from ${Math.round(kept.age_s)}s ago` : ''),
      );
      if (kept) return { text: kept.text, source: 'cached', age_s: kept.age_s };
      return { text: r.signal ? '⋯' : '', source: 'none' };
    }
    return { text: '', source: 'none' };
  } catch {
    return { text: '', source: 'none' };
  }
}

/** The mark on a bar that is being reused. The dots stay — something did fail — but they
 *  ride beside the segment instead of replacing it, and they carry its age. */
function lateMark(age_s: number, color: boolean): string {
  const age = age_s < 60 ? '' : `${Math.round(age_s / 60)}m`;
  const mark = `⋯${age}`;
  return color ? `\x1b[2m${mark}\x1b[0m` : mark;
}

/** Run the chained command once, the way a tick does, and say whether anything came back.
 *
 *  `doctor` reported `status line — points at Guardian` while the segment Guardian chained
 *  had failed on every tick for two hours: true, and beside the point. Checking that
 *  Guardian is wired is not the same as checking that what it displaced still runs. */
export function probeChained(
  projectDir: string,
  cfg: GuardianConfig,
  now = Date.now() / 1000,
): { cmd: string | null; ok: boolean } {
  const cmd = liveChainedCommand(cfg, projectDir);
  if (!cmd) return { cmd: null, ok: true };
  const payload = JSON.stringify({ session_id: 'guardian-doctor', cwd: projectDir });
  // Only a run that produced a bar counts. Reusing the kept one keeps the display honest;
  // letting it answer the probe would have doctor report a command that never runs as one
  // that does — the gauge agreeing with the cache instead of with the world.
  return { cmd, ok: runChained(cmd, payload, projectDir, cfg, now).source === 'fresh' };
}

/** The command to chain, preferring what its source file says *now* over what it said when
 *  Guardian displaced it.
 *
 *  A status line is not always a constant. hive and graft both rewrite theirs — new flags,
 *  a changed path, another tool chained in behind them — and a snapshot taken at `init`
 *  would pin whatever it happened to say that day. The other tool would go on editing a
 *  file that no longer decides anything, its updates landing nowhere, with the stale
 *  command still running and nothing anywhere to explain why.
 *
 *  The snapshot remains the fallback: the file can be deleted, emptied, or taken over by
 *  Guardian itself, and in none of those cases should the user lose their bar. */
export function liveChainedCommand(cfg: GuardianConfig, projectDir: string): string | null {
  const snapshot = cfg.statusline.chained_command;
  const from = cfg.statusline.chained_from;
  if (!from) return snapshot;
  try {
    const cmd = (
      JSON.parse(readFileSync(from, 'utf8')) as { statusLine?: { command?: string } }
    ).statusLine?.command;
    // Guardian's own command would recurse; anything else is the current truth.
    if (typeof cmd === 'string' && cmd && !cmd.includes('guardian.cjs')) return cmd;
  } catch {
    /* unreadable or gone: the snapshot is all there is */
  }
  return snapshot;
}

/** Entry point for the statusLine command. Must never throw and must stay well under the
 *  latency budget: it runs on every session event. */
export function sense(raw: string, now = Date.now() / 1000): string {
  let payload: StatusLinePayload = {};
  try {
    payload = JSON.parse(raw) as StatusLinePayload;
  } catch {
    /* fall through with an empty payload */
  }

  const projectDir = resolveProjectDir(payload);
  const cfg = loadConfig(projectDir);
  const toChain = liveChainedCommand(cfg, projectDir);
  const run: ChainedResult = toChain
    ? runChained(toChain, raw, projectDir, cfg, now)
    : { text: '', source: 'none' };
  const chained =
    run.source === 'cached'
      ? `${run.text} ${lateMark(run.age_s ?? 0, cfg.render.color)}`
      : run.text;

  if (!cfg.enabled) return chained;

  let line = '';
  try {
    const sessionId = payload.session_id || 'unknown';
    const live = liveCount(readAgents(projectDir, sessionId), now);
    const next = computeState(readState(projectDir, sessionId), payload, cfg, now, live);
    writeState(projectDir, next);
    line = renderStatus(next, cfg);
  } catch (err) {
    log(projectDir, 'error', `sense failed: ${(err as Error)?.stack ?? String(err)}`);
    // Fail open: the user keeps their own status line, Guardian simply says nothing.
    return chained;
  }

  // Guardian's segment goes below what it chained by default. Two full status lines on one
  // row wrap in most terminals, and a wrapped bar is worse than a second line.
  if (!chained) return line;
  return cfg.statusline.own_line ? `${chained}\n${line}` : `${chained}  ${line}`;
}
