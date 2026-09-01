import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timeToWall, axisMode, decide, maxMode } from '../src/budget/mode.ts';
import { DEFAULT_CONFIG } from '../src/core/config.ts';
import type { AxisState } from '../src/types.ts';

const cfg = DEFAULT_CONFIG;
const NOW = 1_800_000_000;

function axis(over: Partial<AxisState>): AxisState {
  return {
    used_pct: 0,
    burn_pct_per_min: null,
    resets_at: null,
    time_to_wall_min: null,
    mode: 'NORMAL',
    ...over,
  };
}

test('timeToWall: a window that refills before it can be exhausted is infinite', () => {
  // 97% used, burning 1 %/min => 3 minutes of headroom, and the window refills in 1.
  const ttw = timeToWall(97, 1, NOW + 60, NOW, 1);
  assert.equal(ttw, Infinity);
});

test('timeToWall: same percentage, distant reset, is a real countdown', () => {
  const ttw = timeToWall(97, 1, NOW + 40 * 60, NOW, 1);
  assert.equal(ttw, 3);
});

test('timeToWall: an axis with no scheduled refill just divides headroom by burn', () => {
  assert.equal(timeToWall(60, 2, null, NOW), 20);
});

test('timeToWall: unmeasurable burn yields null, not a guess', () => {
  assert.equal(timeToWall(60, null, null, NOW), null);
  assert.equal(timeToWall(60, 0, null, NOW), null);
  assert.equal(timeToWall(null, 2, null, NOW), null);
});

test('timeToWall: a window already past its reset is treated as refilled', () => {
  assert.equal(timeToWall(99, 5, NOW - 10, NOW), Infinity);
});

// The headline behaviour: the failure mode a percentage-only guard cannot avoid.
test('axisMode: 97% of the 5-hour window is NORMAL when it refills before it can run out', () => {
  const st = axis({ used_pct: 97, burn_pct_per_min: 1, resets_at: NOW + 60 });
  st.time_to_wall_min = timeToWall(st.used_pct, st.burn_pct_per_min, st.resets_at, NOW, 1);
  assert.equal(axisMode('five_hour', st, cfg), 'NORMAL');
});

test('axisMode: 97% of the 5-hour window is EMERGENCY when the reset is far away', () => {
  const st = axis({ used_pct: 97, burn_pct_per_min: 3, resets_at: NOW + 60 * 60 });
  st.time_to_wall_min = timeToWall(st.used_pct, st.burn_pct_per_min, st.resets_at, NOW);
  assert.equal(axisMode('five_hour', st, cfg), 'EMERGENCY');
});

test('axisMode: the percentage floor still fires while burn is unmeasurable', () => {
  const st = axis({ used_pct: 96, burn_pct_per_min: null, resets_at: NOW + 60 * 60 });
  st.time_to_wall_min = timeToWall(st.used_pct, st.burn_pct_per_min, st.resets_at, NOW);
  assert.equal(st.time_to_wall_min, null);
  assert.equal(axisMode('five_hour', st, cfg), 'LAND');
});

test('axisMode: context is capped, because its wall is compaction rather than a 429', () => {
  const st = axis({ used_pct: 99, burn_pct_per_min: 10, resets_at: null });
  st.time_to_wall_min = timeToWall(st.used_pct, st.burn_pct_per_min, st.resets_at, NOW);
  assert.ok(st.time_to_wall_min !== null && st.time_to_wall_min < 1);
  assert.equal(axisMode('context', st, cfg), 'LAND');
  assert.equal(axisMode('five_hour', st, cfg), 'EMERGENCY');
});

test('decide: session mode is the most severe demand, and names the binding axis', () => {
  const d = decide(
    {
      context: axis({ used_pct: 85, time_to_wall_min: 20, mode: 'WATCH' }),
      five_hour: axis({ used_pct: 92, time_to_wall_min: 4, mode: 'LAND', resets_at: NOW + 3600 }),
    },
    cfg,
    NOW,
  );
  assert.equal(d.mode, 'LAND');
  assert.equal(d.binding_axis, 'five_hour');
  assert.match(d.reason, /5-hour/);
  assert.match(d.reason, /92% used/);
});

test('decide: a disabled axis cannot drive the session mode', () => {
  const d = decide(
    { seven_day: axis({ used_pct: 99, time_to_wall_min: 1, mode: 'EMERGENCY' }) },
    { ...cfg, axes: { ...cfg.axes, seven_day: false } },
    NOW,
  );
  assert.equal(d.mode, 'NORMAL');
  assert.equal(d.binding_axis, null);
});

test('maxMode orders the ladder', () => {
  assert.equal(maxMode('WATCH', 'LAND'), 'LAND');
  assert.equal(maxMode('EMERGENCY', 'PREPARE'), 'EMERGENCY');
});

test('timeToWall: the reset margin refuses to call a photo finish safe', () => {
  // 3 minutes of headroom against a reset 2.9 minutes out: technically ahead, but well
  // inside the error bars of a smoothed burn estimate.
  assert.equal(timeToWall(97, 1, NOW + 174, NOW, 1), 3);
  assert.equal(timeToWall(97, 1, NOW + 60, NOW, 1), Infinity);
});

test('a reading at or past 100% means the wall is here, not a small countdown', () => {
  // spend_limit is documented as able to exceed 100, and rounding can nudge any axis over.
  assert.equal(timeToWall(100, 1.5, null, NOW), 0);
  assert.equal(timeToWall(106, 1.5, null, NOW), 0);
  assert.equal(timeToWall(106, 1.5, NOW + 3600, NOW, 1), 0);
  const st = axis({ used_pct: 106, burn_pct_per_min: 1.5, resets_at: NOW + 3600 });
  st.time_to_wall_min = timeToWall(st.used_pct, st.burn_pct_per_min, st.resets_at, NOW, 1);
  assert.equal(axisMode('spend', st, cfg), 'EMERGENCY');
});

test('an exhausted window is at the wall even when the reset is close', () => {
  // The refills-first shortcut compares *headroom* against the reset. At 100% there is no
  // headroom left to compare: the very next request 429s. A reset 30s away makes the
  // recovery quick, not the present state safe. Signalling "safe" here would be a lie.
  assert.equal(timeToWall(100, 1.5, NOW + 30, NOW, 0), 0);
  // Just below the line, with a reset that beats the remaining headroom, is safe.
  assert.equal(timeToWall(99, 1.5, NOW + 10, NOW, 0), Infinity);
});
