import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sense } from '../src/sensors/statusline.ts';

const BUNDLE = fileURLToPath(new URL('../dist/guardian.cjs', import.meta.url));

function run(args: string[], input = '', cwd = process.cwd()) {
  return spawnSync(process.execPath, [BUNDLE, ...args], {
    input,
    encoding: 'utf8',
    cwd,
    windowsHide: true,
  });
}

test('the bundle exists — run `npm run build` before the suite', () => {
  assert.ok(existsSync(BUNDLE), `missing ${BUNDLE}`);
});

// Fail-open is the load-bearing property: a watchdog that breaks the session it watches
// is strictly worse than no watchdog. Every one of these must exit 0.
for (const [name, input] of [
  ['malformed json', '{ not json at all'],
  ['empty stdin', ''],
  ['json of the wrong shape', '[1,2,3]'],
  ['null', 'null'],
  ['a payload with hostile types', '{"session_id":42,"context_window":"nope","rate_limits":7}'],
] as const) {
  test(`sense fails open on ${name}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'guardian-cli-'));
    const r = run(['sense'], input, dir);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.stderr, '');
  });
}

test('sense writes state and prints a bar for a real payload', () => {
  const dir = mkdtempSync(join(tmpdir(), 'guardian-cli-'));
  const payload = JSON.stringify({
    session_id: 'cli-1',
    cwd: dir,
    workspace: { project_dir: dir },
    model: { display_name: 'Opus' },
    cost: { total_cost_usd: 4.12 },
    context_window: { context_window_size: 1000000, used_percentage: 62 },
    rate_limits: {
      five_hour: { used_percentage: 91, resets_at: Math.floor(Date.now() / 1000) + 3600 },
    },
  });
  const r = run(['sense'], payload, dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /62%/);
  assert.match(r.stdout, /91%/);

  const statePath = join(dir, '.claude', 'guardian', 'sessions', 'cli-1.json');
  assert.ok(existsSync(statePath), 'state was not written');
  const st = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(st.axes.five_hour.used_pct, 91);
});

test('an unreadable state directory does not take the status line down', () => {
  // Point the project at a path that cannot be created, so writeState throws.
  const payload = JSON.stringify({
    session_id: 'cli-2',
    workspace: { project_dir: process.platform === 'win32' ? 'Z:/nope/nope' : '/proc/nope' },
    context_window: { used_percentage: 50 },
  });
  const r = run(['sense'], payload);
  assert.equal(r.status, 0, r.stderr);
});

test('status reports cleanly when there is nothing to report', () => {
  const dir = mkdtempSync(join(tmpdir(), 'guardian-cli-'));
  const r = run(['status'], '', dir);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /no state for this project yet/);
});

test('an unknown subcommand prints usage and is the only nonzero exit', () => {
  assert.equal(run(['definitely-not-a-command']).status, 1);
  assert.equal(run(['help']).status, 0);
  assert.equal(run(['version']).status, 0);
});

test('the configured command uses forward slashes, which Windows requires', () => {
  const r = run(['where']);
  assert.equal(r.status, 0);
  const BACKSLASH = String.fromCharCode(92);
  assert.ok(
    !r.stdout.includes(BACKSLASH),
    'backslashes get eaten as escapes before the script runs on Windows',
  );
  assert.match(r.stdout, /guardian\.cjs" sense/);
});

/** The sensor runs on every session event, so its own cost has to stay negligible.
 *  Two separate budgets: the compute itself, and the process it runs in. Node's cold
 *  start dominates the latter and is not something Guardian can optimise away. */
test('sensor compute stays far inside its budget', () => {
  const dir = mkdtempSync(join(tmpdir(), 'guardian-perf-'));
  const payload = JSON.stringify({
    session_id: 'perf',
    workspace: { project_dir: dir },
    context_window: { used_percentage: 50 },
    rate_limits: { five_hour: { used_percentage: 70, resets_at: 1e10 } },
  });
  const times: number[] = [];
  for (let i = 0; i < 200; i++) {
    const t = performance.now();
    sense(payload);
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  const at = (q: number) => times[Math.floor(times.length * q)]!;
  // Assert on the median: the test runner executes files concurrently, so upper
  // percentiles here measure CPU contention in CI rather than Guardian's own cost.
  console.log(`      sense() p50 ${at(0.5).toFixed(2)}ms  p95 ${at(0.95).toFixed(2)}ms`);
  assert.ok(at(0.5) < 25, `p50 compute was ${at(0.5).toFixed(2)}ms`);
});
