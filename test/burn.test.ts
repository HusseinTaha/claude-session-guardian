import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordSample, rawBurnRate, smooth, spacingS } from '../src/budget/burn.ts';
import { DEFAULT_CONFIG } from '../src/core/config.ts';
import type { Sample } from '../src/types.ts';

const cfg = DEFAULT_CONFIG;
const T0 = 1_800_000_000;

/** A steady climb of `perMin` percentage points, sampled every `stepS` seconds. */
function ramp(from: number, perMin: number, stepS: number, n: number): Sample[] {
  return Array.from({ length: n }, (_, i) => ({
    t: T0 + i * stepS,
    five_hour: from + (perMin * (i * stepS)) / 60,
  }));
}

test('rawBurnRate recovers a steady climb', () => {
  const s = ramp(50, 2, 30, 11); // 5 minutes at 2 %/min
  const r = rawBurnRate(s, 'five_hour', cfg, T0 + 300);
  assert.ok(r !== null);
  assert.ok(Math.abs(r! - 2) < 0.01, `got ${r}`);
});

test('rawBurnRate refuses a span too short to mean anything', () => {
  const s = ramp(50, 2, 10, 3); // 20 seconds, under min_span_s
  assert.equal(rawBurnRate(s, 'five_hour', cfg, T0 + 20), null);
});

test('rawBurnRate needs at least two observations', () => {
  assert.equal(rawBurnRate([{ t: T0, five_hour: 50 }], 'five_hour', cfg, T0), null);
  assert.equal(rawBurnRate([], 'five_hour', cfg, T0), null);
});

test('rawBurnRate restarts at a reset, ignoring the previous regime', () => {
  // Climb to 90%, the window refills to 0, then a gentle 0.5 %/min climb.
  const before = ramp(80, 2, 30, 11);
  const after = Array.from({ length: 11 }, (_, i) => ({
    t: T0 + 330 + i * 30,
    five_hour: (0.5 * (i * 30)) / 60,
  }));
  const r = rawBurnRate([...before, ...after], 'five_hour', cfg, T0 + 630);
  assert.ok(r !== null);
  assert.ok(Math.abs(r! - 0.5) < 0.01, `expected the post-reset regime, got ${r}`);
});

test('rawBurnRate ignores an axis the payload never carried', () => {
  const s = ramp(50, 2, 30, 11);
  assert.equal(rawBurnRate(s, 'seven_day', cfg, T0 + 300), null);
});

test('rawBurnRate treats an idle series as unmeasurable rather than zero', () => {
  const flat = Array.from({ length: 11 }, (_, i) => ({ t: T0 + i * 30, five_hour: 42 }));
  assert.equal(rawBurnRate(flat, 'five_hour', cfg, T0 + 300), null);
});

test('recordSample thins ticks inside one spacing interval down to a moving tail', () => {
  let s: Sample[] = [];
  for (let i = 0; i < 10; i++) s = recordSample(s, { t: T0 + i, five_hour: 10 + i }, cfg);
  assert.equal(s.length, 2); // the anchor, plus a tail that keeps being overwritten
  assert.equal(s[0]!.five_hour, 10); // the anchor is left where it was
  assert.equal(s[1]!.five_hour, 19); // the tail is the freshest reading
  assert.equal(s[1]!.t, T0 + 9); // ... at its real time, so the slope is not distorted
});

test('spacing is whatever it takes to fit window_min inside max_samples', () => {
  // Retention is two windows deep, so 15 minutes of history in 60 samples is a 30s gap.
  assert.equal(spacingS(cfg), (cfg.burn.window_min * 60 * 2) / cfg.burn.max_samples);
  assert.equal(spacingS(cfg), 30);
  // A budget generous enough for a 5s gap does not go finer than the noise floor.
  assert.equal(spacingS({ ...cfg, burn: { ...cfg.burn, max_samples: 10_000 } }), 5);
});

test('the configured window is reachable however fast the status line fires', () => {
  // The regression this guards: with a fixed 5s gap, 60 samples held only 300s, so a
  // window_min of 10 was silently truncated to 5 and the burn estimate ran on half the
  // history it was configured for -- measured at more than double the prediction error.
  let s: Sample[] = [];
  for (let i = 0; i <= 20 * 60; i++) s = recordSample(s, { t: T0 + i, five_hour: i * 0.01 }, cfg);
  const span = s[s.length - 1]!.t - s[0]!.t;
  assert.ok(
    span >= cfg.burn.window_min * 60,
    `retained ${span}s of history, want at least ${cfg.burn.window_min * 60}s`,
  );
  assert.ok(s.length <= cfg.burn.max_samples, `kept ${s.length} samples`);
});

test('recordSample keeps ticks that are far enough apart, and bounds the ring', () => {
  let s: Sample[] = [];
  for (let i = 0; i < 200; i++) s = recordSample(s, { t: T0 + i * 30, five_hour: i * 0.1 }, cfg);
  assert.ok(s.length <= cfg.burn.max_samples);
  assert.ok(s.length > 1);
});

test('smooth blends toward the new estimate and survives missing readings', () => {
  assert.equal(smooth(null, 2, 0.35), 2); // no new estimate: hold the old one
  assert.equal(smooth(4, null, 0.35), 4); // first estimate: adopt it
  assert.ok(Math.abs(smooth(4, 2, 0.5)! - 3) < 1e-9);
});

test('a rate is not trusted until enough readings agree on it', () => {
  // Two points can lie: one anomalous reading would otherwise imply an absurd rate and
  // slam the mode ladder straight to EMERGENCY.
  const twoPoints: Sample[] = [
    { t: T0, five_hour: 40 },
    { t: T0 + 60, five_hour: 91 },
  ];
  assert.equal(rawBurnRate(twoPoints, 'five_hour', cfg, T0 + 60), null);

  // A third consistent reading makes it believable.
  const three = [...twoPoints, { t: T0 + 120, five_hour: 142 }];
  assert.ok(rawBurnRate(three, 'five_hour', cfg, T0 + 120) !== null);
});

test('min_samples is configurable for anyone who wants the twitchier behaviour', () => {
  const twitchy = { ...cfg, burn: { ...cfg.burn, min_samples: 2 } };
  const twoPoints: Sample[] = [
    { t: T0, five_hour: 50 },
    { t: T0 + 60, five_hour: 52 },
  ];
  assert.ok(Math.abs(rawBurnRate(twoPoints, 'five_hour', twitchy, T0 + 60)! - 2) < 0.01);
});
