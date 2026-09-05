import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sense } from '../src/sensors/statusline.ts';
import { handle } from '../src/actuators/dispatch.ts';

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

test('sealing by hand leaves the dashboard agreeing that it is sealed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'guardian-cli-'));
  const p = JSON.stringify({
    session_id: 'seal-1',
    cwd: dir,
    workspace: { project_dir: dir },
    context_window: { context_window_size: 200000, used_percentage: 30 },
  });
  run(['sense'], p, dir);
  run(['handoff', '--reason', 'by hand', '--no-git'], '', dir);
  // The hook path recorded the seal in state and the CLI did not, so a hand-sealed session
  // showed "Manifest: not sealed" with the manifest sitting on disk beside it.
  assert.doesNotMatch(run(['status'], '', dir).stdout, /Manifest:\s+not sealed/);
});

test('no arguments means the dashboard, so a slash command can pass $ARGUMENTS through', () => {
  const dir = mkdtempSync(join(tmpdir(), 'guardian-cli-'));
  const p = JSON.stringify({
    session_id: 'bare-1',
    cwd: dir,
    workspace: { project_dir: dir },
    context_window: { context_window_size: 200000, used_percentage: 30 },
  });
  run(['sense'], p, dir);
  // `${ARGUMENTS:-status}` in a slash command is expanded by whoever sees it first, and
  // that is never Claude Code, so the default never carried the user's argument. The
  // command passes $ARGUMENTS bare now, which means empty has to mean something useful.
  assert.match(run([], '', dir).stdout, /CLAUDE SESSION GUARDIAN/);
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

/** PostToolUse is not the sensor, but it now runs on *every* tool call — reading state and
 *  config even for a Read — because that is where the automatic seal decides whether it is
 *  armed. Cheap, and measured, because the rule is that the paths on every event are. */
test('the observe-and-maybe-seal path stays cheap on a calm session', () => {
  const dir = mkdtempSync(join(tmpdir(), 'guardian-perf-h-'));
  mkdirSync(join(dir, '.claude', 'guardian'), { recursive: true });
  const payload = JSON.stringify({
    session_id: 'perf',
    cwd: dir,
    tool_name: 'Read',
    tool_input: { file_path: join(dir, 'nothing.txt') },
  });
  const times: number[] = [];
  for (let i = 0; i < 100; i++) {
    const t = performance.now();
    handle('PostToolUse', payload, 1_800_000_000 + i);
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  const p50 = times[Math.floor(times.length * 0.5)]!;
  console.log(`      PostToolUse p50 ${p50.toFixed(2)}ms`);
  assert.ok(p50 < 25, `p50 was ${p50.toFixed(2)}ms`);
});

/** The agents section is a table, and a table that does not line up hides the outlier the
 *  display exists to surface. Widths come from the data, so this asserts the invariant
 *  rather than a hard-coded layout: every row's columns start at the same offsets. */
test('the agents table lines up, and carries absolute context alongside the percentage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'guardian-tab-'));
  const sessions = join(dir, '.claude', 'guardian', 'sessions');
  mkdirSync(sessions, { recursive: true });
  const agent = (id: string, name: string, tok: number, win: number | null, tpm: number | null) => ({
    id,
    name,
    type: name,
    status: 'running',
    description: 'do a thing',
    started_at: 1_800_000_000,
    token_count: tok,
    context_window: win,
    samples: [],
    tokens_per_min: tpm,
  });
  writeFileSync(
    join(sessions, 'sess.agents.json'),
    JSON.stringify({
      schema: 1,
      session_id: 'sess',
      updated_at: 1_800_000_000,
      agents: {
        a1: agent('a1', 'Explore', 84_000, 200_000, 1450),
        a2: agent('a2', 'general-purpose', 128_000, 1_000_000, 6200),
        a3: agent('a3', 'x', 500, null, null),
      },
    }),
  );

  const r = spawnSync(process.execPath, [BUNDLE, 'agents'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0);
  const lines = r.stdout.split('\n').filter((l) => /Explore|general-purpose|AGENT/.test(l));
  assert.equal(lines.length, 3, 'a header and one row per agent');

  assert.match(r.stdout, /84k\/200k/);
  assert.match(r.stdout, /128k\/1M/);
  assert.match(r.stdout, /1\.5k[/]min/);

  // Alignment: the column the percentages sit in starts at one offset for every row.
  const offsets = lines.slice(1).map((l) => l.indexOf('%') - String(l.match(/(\d+)%/)?.[1] ?? '').length);
  assert.equal(new Set(offsets).size, 1, `percent column ragged: ${JSON.stringify(lines)}`);
  const headerFull = lines[0]!.indexOf('FULL');
  assert.ok(headerFull > 0 && lines.slice(1).every((l) => l.length >= headerFull));
});

// A watchdog that outlives the thing it was watching is the one failure it cannot have.
// `readFileSync(0)` returns only at EOF, and these run as `bash -c "node guardian.cjs
// sense"` — when the session that started that bash goes away the descriptor can stay
// open with nobody left to close it. Seven strays were found on one machine, the oldest
// 36 hours old. Nothing writes to this child's stdin and nothing ever ends it.
test('a stdin that never closes does not strand the process', async () => {
  const child = spawn(process.execPath, [BUNDLE, 'sense'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, GUARDIAN_STDIN_TIMEOUT_MS: '300' },
    windowsHide: true,
  });
  const exited = await new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), 15000);
    child.on('exit', () => {
      clearTimeout(t);
      resolve(true);
    });
  });
  if (!exited) child.kill('SIGKILL');
  assert.ok(exited, 'guardian sense was still running with stdin held open');
});

// The other half of the contract: bounding the read must not lose a payload that arrives.
test('a payload delivered on stdin is still read in full', () => {
  const r = run(['sense'], JSON.stringify({ workspace: { current_dir: process.cwd() } }));
  assert.equal(r.status, 0);
  assert.ok(r.stdout.length > 0, 'sense produced no bar for a valid payload');
});
