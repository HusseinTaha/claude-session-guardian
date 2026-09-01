import type { AxisName, GuardianConfig, Sample } from '../types.ts';

const EPS = 0.01;

/** Floor on the gap between retained samples. The status line can fire every 300ms;
 *  keeping all of those would give a rate estimate dominated by quantisation noise
 *  (percentages arrive rounded). */
const MIN_SPACING_S = 5;

/** How far apart retained samples are held, in seconds.
 *
 *  `max_samples` bounds what the state file carries; `window_min` says how much history
 *  the estimator wants. Held at a fixed 5s gap the two silently contradict each other —
 *  60 samples cover 300s, so any window over 5 minutes was quietly truncated and the
 *  configured one unreachable. Spacing the samples out instead honours both: the window
 *  is always covered, and the count still caps the file. */
export function spacingS(cfg: GuardianConfig): number {
  const retentionS = cfg.burn.window_min * 60 * 2;
  const budget = Math.max(2, Math.floor(cfg.burn.max_samples));
  return Math.max(MIN_SPACING_S, Math.ceil(retentionS / budget));
}

/** Append a sample, thinning ticks that land inside one spacing interval.
 *
 *  The tail of the series is provisional: the newest reading overwrites it until it sits
 *  a full interval past the sample before it, and only then does it freeze and a fresh
 *  tail start. So the head never lags a tick, and the committed samples stay evenly
 *  spaced however fast the status line fires.
 *
 *  Measuring the gap from the tail instead is the trap, and was the bug: overwriting also
 *  advances the tail's timestamp, so a stream firing faster than the interval resets the
 *  clock every time and the series never grows past one point -- leaving the burn rate
 *  permanently unmeasurable in exactly the busy sessions that need it. */
export function recordSample(prev: Sample[], next: Sample, cfg: GuardianConfig): Sample[] {
  const out = prev.slice();
  const anchor = out[out.length - 2];
  if (anchor && next.t - anchor.t < spacingS(cfg)) out[out.length - 1] = next;
  else out.push(next);

  const cutoff = next.t - cfg.burn.window_min * 60 * 2;
  const trimmed = out.filter((s) => s.t >= cutoff);
  return trimmed.slice(-cfg.burn.max_samples);
}

/** Percentage-points per minute consumed on one axis, or null when not yet measurable.
 *
 *  Measured over a trailing window rather than adjacent pairs: adjacent ticks are
 *  seconds apart with integer-rounded percentages, so pairwise slopes are mostly noise.
 *
 *  A drop in the series means the window refilled (rate-limit reset) or the context was
 *  compacted. Everything before that discontinuity describes a different regime, so the
 *  estimate restarts from it. */
export function rawBurnRate(
  samples: Sample[],
  axis: AxisName,
  cfg: GuardianConfig,
  now: number,
): number | null {
  const pts = samples
    .filter((s) => typeof s[axis] === 'number')
    .map((s) => ({ t: s.t, v: s[axis] as number }))
    .sort((a, b) => a.t - b.t);
  if (pts.length < 2) return null;

  let start = 0;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i]!.v < pts[i - 1]!.v - EPS) start = i;
  }

  const windowStart = now - cfg.burn.window_min * 60;
  const recent = pts.slice(start).filter((p) => p.t >= windowStart);
  // Two readings are enough to compute a slope and not enough to believe one. A single
  // anomalous percentage — a fan-out landing all at once, a window rolling over — would
  // otherwise produce an absurd rate that slams the mode ladder to EMERGENCY on the spot.
  if (recent.length < Math.max(2, cfg.burn.min_samples)) return null;

  const first = recent[0]!;
  const last = recent[recent.length - 1]!;
  const spanS = last.t - first.t;
  if (spanS < cfg.burn.min_span_s) return null;

  const rate = (last.v - first.v) / (spanS / 60);
  return rate > 0 ? rate : null;
}

/** Exponentially smooth the raw estimate so a single burst does not slam the mode
 *  ladder, while a sustained fan-out still moves it within a minute or two. */
export function smooth(raw: number | null, prev: number | null, alpha: number): number | null {
  if (raw === null) return prev;
  if (prev === null) return raw;
  return alpha * raw + (1 - alpha) * prev;
}
