import type { AxisName, GuardianConfig, Sample } from './types.ts';

const EPS = 0.01;

/** Append a sample, collapsing near-duplicate ticks. The status line can fire every
 *  300ms; keeping all of those would give a rate estimate dominated by quantisation
 *  noise (percentages arrive rounded), so we thin to at most one sample per 5s. */
export function recordSample(prev: Sample[], next: Sample, cfg: GuardianConfig): Sample[] {
  const out = prev.slice();
  const last = out[out.length - 1];
  if (last && next.t - last.t < 5) out[out.length - 1] = next;
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
  if (recent.length < 2) return null;

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
