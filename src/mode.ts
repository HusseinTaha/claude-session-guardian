import { MODES, type AxisName, type AxisState, type GuardianConfig, type Mode } from './types.ts';

export function severity(m: Mode): number {
  return MODES.indexOf(m);
}
export function maxMode(a: Mode, b: Mode): Mode {
  return severity(a) >= severity(b) ? a : b;
}

/** Minutes until this axis is exhausted.
 *
 *  Returns `Infinity` when the window refills before it can run out — the single most
 *  important case, and one a percentage threshold cannot express. At 97% of the 5-hour
 *  window with a reset three minutes away, the correct action is to keep working; a
 *  percentage-only guard would declare an emergency and throw away the session. */
export function timeToWall(
  usedPct: number | null,
  burnPctPerMin: number | null,
  resetsAt: number | null | undefined,
  now: number,
  /** Minutes of slack required before calling a refilling window safe. Burn estimates are
   *  noisy, so "headroom beats the reset by four seconds" is not a safety guarantee. */
  marginMin = 0,
): number | null {
  if (usedPct === null) return null;

  if (resetsAt != null) {
    const resetInMin = (resetsAt - now) / 60;
    if (resetInMin <= 0) return Infinity; // already refilled; awaiting a fresh reading
    if (burnPctPerMin === null || burnPctPerMin <= 0) return null;
    const headroom = headroomMin(usedPct, burnPctPerMin);
    return headroom > resetInMin + marginMin ? Infinity : headroom;
  }

  if (burnPctPerMin === null || burnPctPerMin <= 0) return null;
  return headroomMin(usedPct, burnPctPerMin);
}

/** Never negative. `spend_limit` is documented as able to exceed 100, and a rounded
 *  reading can nudge any axis over, so "already past the wall" has to mean zero rather
 *  than a negative countdown that formats as a reassuring small number. */
function headroomMin(usedPct: number, burnPctPerMin: number): number {
  return Math.max(0, (100 - usedPct) / burnPctPerMin);
}

function modeFromMinutes(ttw: number | null, cfg: GuardianConfig): Mode {
  if (ttw === null || !Number.isFinite(ttw)) return 'NORMAL';
  const t = cfg.thresholds_minutes;
  if (ttw <= t.emergency) return 'EMERGENCY';
  if (ttw <= t.land) return 'LAND';
  if (ttw <= t.prepare) return 'PREPARE';
  if (ttw <= t.watch) return 'WATCH';
  return 'NORMAL';
}

function modeFromPercent(used: number | null, cfg: GuardianConfig): Mode {
  if (used === null) return 'NORMAL';
  const p = cfg.thresholds_percent_floor;
  if (used >= p.emergency) return 'EMERGENCY';
  if (used >= p.land) return 'LAND';
  if (used >= p.prepare) return 'PREPARE';
  if (used >= p.watch) return 'WATCH';
  return 'NORMAL';
}

/** Mode this axis alone demands.
 *
 *  The percentage floor only applies when time-to-wall is *not* Infinity. A refilling
 *  window at 97% is genuinely safe, and letting the floor override that would reintroduce
 *  exactly the false alarm the time-to-wall model exists to remove. */
export function axisMode(axis: AxisName, st: AxisState, cfg: GuardianConfig): Mode {
  if (st.time_to_wall_min === Infinity) return 'NORMAL';
  const m = maxMode(modeFromMinutes(st.time_to_wall_min, cfg), modeFromPercent(st.used_pct, cfg));
  const cap = cfg.axis_severity_cap[axis];
  return cap && severity(m) > severity(cap) ? cap : m;
}

export interface Decision {
  mode: Mode;
  binding_axis: AxisName | null;
  reason: string;
}

const AXIS_LABEL: Record<AxisName, string> = {
  context: 'context',
  five_hour: '5-hour',
  seven_day: '7-day',
  spend: 'spend',
};

/** Session mode is the most severe action any axis demands, not the highest percentage.
 *  Context hitting its wall means compaction — recoverable in seconds; the 5-hour window
 *  hitting its wall means a 429 and hours of downtime. Those are not comparable, so they
 *  are never averaged or max()'d as raw numbers. */
export function decide(
  axes: Partial<Record<AxisName, AxisState>>,
  cfg: GuardianConfig,
  now: number,
): Decision {
  let best: { axis: AxisName; st: AxisState; mode: Mode } | null = null;

  for (const [name, st] of Object.entries(axes) as [AxisName, AxisState][]) {
    if (!cfg.axes[name]) continue;
    const m = st.mode;
    if (m === 'NORMAL') continue;
    if (
      !best ||
      severity(m) > severity(best.mode) ||
      (severity(m) === severity(best.mode) && ttwRank(st) < ttwRank(best.st))
    ) {
      best = { axis: name, st, mode: m };
    }
  }

  if (!best) return { mode: 'NORMAL', binding_axis: null, reason: 'all axes clear' };

  const { axis, st, mode } = best;
  const label = AXIS_LABEL[axis];
  const parts: string[] = [];
  if (st.used_pct !== null) parts.push(`${st.used_pct.toFixed(0)}% used`);
  if (st.time_to_wall_min !== null && Number.isFinite(st.time_to_wall_min)) {
    parts.push(`~${fmtMin(st.time_to_wall_min)} to wall`);
  } else {
    parts.push('burn rate not yet measurable');
  }
  if (st.resets_at != null) {
    const r = (st.resets_at - now) / 60;
    if (r > 0) parts.push(`resets in ${fmtMin(r)}`);
  }
  return { mode, binding_axis: axis, reason: `${label}: ${parts.join(', ')}` };
}

function ttwRank(st: AxisState): number {
  return st.time_to_wall_min === null ? Number.MAX_SAFE_INTEGER : st.time_to_wall_min;
}

export function fmtMin(m: number): number | string {
  if (!Number.isFinite(m)) return '∞';
  if (m <= 0) return 'now';
  if (m < 1) return `${Math.max(1, Math.round(m * 60))}s`;
  if (m < 90) return `${Math.round(m)}m`;
  return `${(m / 60).toFixed(1)}h`;
}
