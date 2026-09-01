import { spawnSync } from 'node:child_process';
import { AXES, type AxisName, type AxisState, type GuardianConfig, type GuardianState, type Sample, type StatusLinePayload } from '../types.ts';
import { loadConfig } from '../core/config.ts';
import { resolveStateRoot } from '../core/paths.ts';
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

/** Run the status line command Guardian displaced, so installing Guardian never costs the
 *  user the status line they already had. */
function runChained(cmd: string, stdin: string): string {
  try {
    const r = spawnSync(cmd, {
      input: stdin,
      shell: true,
      encoding: 'utf8',
      timeout: 1500,
      windowsHide: true,
    });
    return (r.stdout ?? '').trim();
  } catch {
    return '';
  }
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
  const chained = cfg.statusline.chained_command
    ? runChained(cfg.statusline.chained_command, raw)
    : '';

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

  return chained ? `${chained}  ${line}` : line;
}
