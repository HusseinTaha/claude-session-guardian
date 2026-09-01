import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeState,
  sampleFrom,
  resolveProjectDir,
  expandVars,
  liveChainedCommand,
} from '../src/sensors/statusline.ts';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyState } from '../src/core/state.ts';
import { DEFAULT_CONFIG } from '../src/core/config.ts';
import { renderStatus } from '../src/format/render.ts';
import { resolve } from 'node:path';
import type { GuardianState, StatusLinePayload } from '../src/types.ts';

const cfg = DEFAULT_CONFIG;
const T0 = 1_800_000_000;

/** Golden payloads mirroring the shapes the statusline docs call out as normal:
 *  `rate_limits` absent entirely, `used_percentage` null early, `current_usage` null
 *  before the first API call and again after /compact. */
const PRE_FIRST_RESPONSE: StatusLinePayload = {
  session_id: 's1',
  cwd: '/proj',
  model: { display_name: 'Opus' },
  context_window: { context_window_size: 200000, used_percentage: null, current_usage: null },
};

const NO_RATE_LIMITS: StatusLinePayload = {
  session_id: 's1',
  cwd: '/proj',
  model: { display_name: 'Opus' },
  cost: { total_cost_usd: 0.42 },
  context_window: { context_window_size: 200000, used_percentage: 8 },
};

function full(ctx: number, fiveH: number, resetsIn: number, cost = 1.0): StatusLinePayload {
  return {
    session_id: 's1',
    cwd: '/proj',
    model: { display_name: 'Opus' },
    cost: { total_cost_usd: cost },
    context_window: { context_window_size: 1000000, used_percentage: ctx },
    rate_limits: {
      five_hour: { used_percentage: fiveH, resets_at: T0 + resetsIn },
      seven_day: { used_percentage: 41.2, resets_at: T0 + 5 * 86400 },
    },
  };
}

test('sampleFrom keeps only finite readings', () => {
  assert.deepEqual(sampleFrom(PRE_FIRST_RESPONSE, T0), { t: T0 });
  assert.deepEqual(sampleFrom(NO_RATE_LIMITS, T0), { t: T0, context: 8 });
  const s = sampleFrom(full(50, 60, 3600), T0);
  assert.equal(s.context, 50);
  assert.equal(s.five_hour, 60);
  assert.equal(s.seven_day, 41.2);
  assert.equal(s.spend, undefined);
});

test('a session with no readings yet reports NORMAL and says so on the bar', () => {
  const st = computeState(emptyState('s1'), PRE_FIRST_RESPONSE, cfg, T0);
  assert.equal(st.mode, 'NORMAL');
  assert.deepEqual(st.axes, {});
  assert.match(renderStatus(st, cfg), /awaiting first API response/);
});

test('an account without rate limits still tracks context', () => {
  const st = computeState(emptyState('s1'), NO_RATE_LIMITS, cfg, T0);
  assert.equal(st.axes.context?.used_pct, 8);
  assert.equal(st.axes.five_hour, undefined);
  assert.equal(st.mode, 'NORMAL');
  assert.equal(st.cost_usd, 0.42);
});

/** Drive the sensor with a real climb and assert the ladder moves in order. */
test('a sustained 5-hour climb walks the ladder up to LAND', () => {
  let st: GuardianState = emptyState('s1');
  const seen: string[] = [];
  // 1.5 %/min from 60%, sampled every 30s, with the reset far enough away to matter.
  for (let i = 0; i <= 50; i++) {
    const t = T0 + i * 30;
    const fiveH = Math.min(99, 60 + (1.5 * (i * 30)) / 60);
    st = computeState(st, full(20, fiveH, 4 * 3600 - i * 30), cfg, t);
    if (seen[seen.length - 1] !== st.mode) seen.push(st.mode);
  }
  assert.equal(seen[0], 'NORMAL');
  assert.ok(seen.includes('WATCH'), `ladder was ${seen.join(' -> ')}`);
  assert.ok(seen.includes('PREPARE'), `ladder was ${seen.join(' -> ')}`);
  assert.ok(seen.includes('LAND') || seen.includes('EMERGENCY'), `ladder was ${seen.join(' -> ')}`);
  // Monotonically non-decreasing: the climb never regresses to a calmer mode.
  const order = ['NORMAL', 'WATCH', 'PREPARE', 'LAND', 'EMERGENCY'];
  for (let i = 1; i < seen.length; i++) {
    assert.ok(
      order.indexOf(seen[i]!) > order.indexOf(seen[i - 1]!),
      `ladder went backwards: ${seen.join(' -> ')}`,
    );
  }
  assert.equal(st.binding_axis, 'five_hour');
});

test('the same climb stays NORMAL when the window refills before it can run out', () => {
  let st: GuardianState = emptyState('s1');
  for (let i = 0; i <= 30; i++) {
    const t = T0 + i * 30;
    const fiveH = Math.min(99, 88 + (1.5 * (i * 30)) / 60);
    // Reset always within a minute or so: the window outruns the burn rate.
    st = computeState(st, full(20, fiveH, 90), cfg, t);
  }
  assert.equal(st.axes.five_hour?.time_to_wall_min, Infinity);
  assert.equal(st.mode, 'NORMAL');
});

test('a percentage carries forward when a tick drops the axis', () => {
  let st = computeState(emptyState('s1'), full(30, 70, 3600), cfg, T0);
  assert.equal(st.axes.five_hour?.used_pct, 70);
  // rate_limits is dropped once a window's resets_at passes; that is not "unknown".
  st = computeState(st, NO_RATE_LIMITS, cfg, T0 + 60);
  assert.equal(st.axes.five_hour?.used_pct, 70);
});

test('a recorded hard stop outranks the gauges until the window reopens', () => {
  const base = computeState(emptyState('s1'), full(10, 20, 3600), cfg, T0);
  const stopped: GuardianState = { ...base, mode: 'HARD_STOPPED', reason: '429 observed' };
  const next = computeState(stopped, full(10, 20, 3600), cfg, T0 + 60);
  assert.equal(next.mode, 'HARD_STOPPED');
  assert.equal(next.reason, '429 observed');
});

test('resolveProjectDir prefers the project dir over the current one', () => {
  // Compared after resolve(), since the result is absolute and platform-shaped.
  assert.equal(
    resolveProjectDir({ workspace: { project_dir: '/a', current_dir: '/a/sub' }, cwd: '/b' }),
    resolve('/a'),
  );
  assert.equal(resolveProjectDir({ cwd: '/b' }), resolve('/b'));
});

test('the status bar stays short and shows the clock only when there is one', () => {
  const st = computeState(emptyState('s1'), full(62, 91, 4 * 3600), cfg, T0);
  const line = renderStatus(st, { ...cfg, render: { ...cfg.render, color: false } });
  assert.ok(line.length < 90, `too wide: ${line.length} chars`);
  assert.match(line, /ctx .* 62%/);
  assert.match(line, /5h .* 91%/);
  assert.doesNotMatch(line, /⚠/); // no burn rate yet, so no fabricated countdown
});

test('a chained command keeps the variables Claude Code would have expanded', () => {
  // Claude Code expands these before running a status line; Guardian re-runs the chained
  // one itself through cmd.exe, which does not understand ${...} at all. Left literal, a
  // project bar written this way resolves to a path with braces in it and disappears.
  const env = { CLAUDE_PROJECT_DIR: 'C:/proj', EMPTY: '' };
  assert.equal(
    expandVars('node "${CLAUDE_PROJECT_DIR:-.}/.claude/helpers/bar.cjs"', env),
    'node "C:/proj/.claude/helpers/bar.cjs"',
  );
  assert.equal(expandVars('bar $CLAUDE_PROJECT_DIR', env), 'bar C:/proj');
  assert.equal(expandVars('bar ${MISSING:-fallback}', env), 'bar fallback');
  assert.equal(expandVars('bar ${EMPTY:-fallback}', env), 'bar fallback');
  assert.equal(expandVars('bar ${MISSING}', env), 'bar ');
  // A bare $name that is not a variable is left alone rather than deleted: it is far more
  // likely to be part of a path or an argument than an unset variable.
  assert.equal(expandVars('bar $notavar', env), 'bar $notavar');
});

test('the chained command follows its source file rather than a snapshot of it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'guardian-chain-'));
  const file = join(dir, 'settings.json');
  const cfgWith = (cmd: string | null, from: string | null) => ({
    ...cfg,
    statusline: { ...cfg.statusline, chained_command: cmd, chained_from: from },
  });

  // hive and graft rewrite their own status line. Pinning what it said at init time would
  // run last month's command while the other tool's edits landed nowhere.
  writeFileSync(file, JSON.stringify({ statusLine: { command: 'new-bar --with extras' } }));
  assert.equal(liveChainedCommand(cfgWith('old-bar', file), dir), 'new-bar --with extras');

  // The snapshot is the fallback, not the source of truth — but losing the file must not
  // cost the user their bar.
  writeFileSync(file, 'not json at all');
  assert.equal(liveChainedCommand(cfgWith('old-bar', file), dir), 'old-bar');
  assert.equal(liveChainedCommand(cfgWith('old-bar', join(dir, 'gone.json')), dir), 'old-bar');

  // And if that file ends up pointing at Guardian, chaining it would recurse.
  writeFileSync(file, JSON.stringify({ statusLine: { command: 'node "x/guardian.cjs" sense' } }));
  assert.equal(liveChainedCommand(cfgWith('old-bar', file), dir), 'old-bar');

  // No source recorded: pre-`init` configs keep working exactly as they did.
  assert.equal(liveChainedCommand(cfgWith('old-bar', null), dir), 'old-bar');
});

test('each gauge is coloured by its own mode, not by its percentage', () => {
  const GREEN = '\x1b[32m';
  const RED = '\x1b[31m';

  // Half a window gone with hours to go: green, and the same green whatever the bar
  // would look like on a percentage-coloured status line.
  const calm = computeState(emptyState('s1'), full(62, 45, 4 * 3600), cfg, T0);
  assert.equal(calm.axes.five_hour?.mode, 'NORMAL');
  assert.ok(renderStatus(calm, cfg).includes(GREEN), 'a calm gauge should be green');

  // The same axis, climbing steadily toward a reset that is too far off to save it.
  let hot = emptyState('s2');
  for (let i = 0; i <= 20; i++) {
    hot = computeState(hot, full(20, 60 + i * 1.5, 4 * 3600 - i * 30), cfg, T0 + i * 30);
  }
  assert.equal(hot.axes.five_hour?.mode, 'LAND');
  assert.ok(renderStatus(hot, cfg).includes(RED), 'a gauge minutes from the wall should be red');

  // And none of it reaches a terminal that asked for plain text.
  const plain = renderStatus(hot, { ...cfg, render: { ...cfg.render, color: false } });
  assert.doesNotMatch(plain, /\x1b\[/);
});
