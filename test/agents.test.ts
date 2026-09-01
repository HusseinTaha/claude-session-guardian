import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  updateAgents,
  emptyAgents,
  readAgents,
  writeAgents,
  liveCount,
  typeStats,
  recordDuration,
  contextWallMin,
  toEpochSeconds,
  type TaskRow,
} from '../src/sensors/agents.ts';
import { senseAgents, renderAgentRow } from '../src/sensors/subagents.ts';
import { sense } from '../src/sensors/statusline.ts';
import { fmtTokens } from '../src/format/render.ts';
import { gateSpawn, markBoundary, isSafeBoundaryCommand, globToRegExp } from '../src/actuators/gate.ts';
import { emptyState, writeState, readState } from '../src/core/state.ts';
import { DEFAULT_CONFIG } from '../src/core/config.ts';
import { buildManifest, renderDigest } from '../src/handoff/manifest.ts';
import { handle } from '../src/actuators/dispatch.ts';
import type { GuardianState, Mode } from '../src/types.ts';

const T = 1_800_000_000;
const BUNDLE = fileURLToPath(new URL('../dist/guardian.cjs', import.meta.url));
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'guardian-ag-'));
  mkdirSync(join(d, '.claude', 'guardian'), { recursive: true });
  return d;
}

function stateAt(mode: Mode, over: Partial<GuardianState> = {}): GuardianState {
  return {
    ...emptyState('s1'),
    mode,
    reason: '5-hour: 96% used, ~4m to wall',
    binding_axis: 'five_hour',
    axes: {
      five_hour: {
        used_pct: 96,
        burn_pct_per_min: 1,
        resets_at: T + 3600,
        time_to_wall_min: 4,
        mode,
      },
    },
    ...over,
  };
}

const cfg = DEFAULT_CONFIG;

// ------------------------------------------------------------------ agent sampling

test('toEpochSeconds normalises milliseconds, seconds and ISO strings', () => {
  assert.equal(toEpochSeconds(T), T);
  assert.equal(toEpochSeconds(T * 1000), T);
  assert.equal(toEpochSeconds('2027-01-15T08:00:00Z'), Date.parse('2027-01-15T08:00:00Z') / 1000);
  assert.equal(toEpochSeconds(undefined), null);
  assert.equal(toEpochSeconds(0), null);
});

test('agent token rate is measured from Guardian own timestamped samples', () => {
  let f = emptyAgents('s1');
  const row = (tokens: number): TaskRow[] => [
    { id: 'a1', name: 'Explore', type: 'Explore', startTime: T * 1000, tokenCount: tokens, contextWindowSize: 200_000 },
  ];
  // 1000 tokens per 30s = 2000/min, sampled far enough apart to be measurable.
  for (let i = 0; i <= 6; i++) f = updateAgents(f, row(5000 + i * 1000), T + i * 30);
  const a = f.agents.a1!;
  assert.ok(a.tokens_per_min !== null);
  assert.ok(Math.abs(a.tokens_per_min! - 2000) < 1, `got ${a.tokens_per_min}`);
  assert.equal(a.token_count, 11_000);
  assert.equal(a.started_at, T);
});

test('a rate is withheld until the sample span is long enough to mean anything', () => {
  let f = emptyAgents('s1');
  f = updateAgents(f, [{ id: 'a1', tokenCount: 100 }], T);
  f = updateAgents(f, [{ id: 'a1', tokenCount: 900 }], T + 6);
  assert.equal(f.agents.a1?.tokens_per_min, null);
});

test('rows the payload stops reporting drop out of the live set', () => {
  let f = emptyAgents('s1');
  f = updateAgents(f, [{ id: 'a1' }, { id: 'a2' }], T);
  assert.equal(Object.keys(f.agents).length, 2);
  f = updateAgents(f, [{ id: 'a1' }], T + 10);
  assert.deepEqual(Object.keys(f.agents), ['a1']);
});

test('liveCount ignores snapshots that have gone stale', () => {
  const f = updateAgents(emptyAgents('s1'), [{ id: 'a1' }], T);
  assert.equal(liveCount(f, T + 10), 1);
  assert.equal(liveCount(f, T + 600), 0);
});

test('contextWallMin projects an agent filling its own context, not its completion', () => {
  const f = (() => {
    let x = emptyAgents('s1');
    for (let i = 0; i <= 6; i++) {
      x = updateAgents(
        x,
        [{ id: 'a1', tokenCount: 100_000 + i * 1000, contextWindowSize: 200_000 }],
        T + i * 30,
      );
    }
    return x;
  })();
  const wall = contextWallMin(f.agents.a1!);
  // ~94k tokens left at 2000/min.
  assert.ok(wall !== null && Math.abs(wall - 47) < 1, `got ${wall}`);
  // Unmeasurable inputs yield null rather than a fabricated number.
  assert.equal(contextWallMin({ ...f.agents.a1!, tokens_per_min: null }), null);
  assert.equal(contextWallMin({ ...f.agents.a1!, context_window: null }), null);
});

test('historical durations accumulate and produce a median', () => {
  const dir = tmp();
  assert.deepEqual(typeStats(dir), {});
  for (const s of [60, 120, 300, 180, 240]) recordDuration(dir, 'Explore', s);
  const st = typeStats(dir).Explore!;
  assert.equal(st.count, 5);
  assert.equal(st.median_s, 180);
  // Implausible values are refused rather than skewing the median.
  recordDuration(dir, 'Explore', -5);
  recordDuration(dir, 'Explore', 99_999);
  assert.equal(typeStats(dir).Explore?.count, 5);
});

// ------------------------------------------------------------------ rendering

test('an agent row shows context fill and pace against a labelled historical median', () => {
  const dir = tmp();
  for (const s of [300, 360, 420] as number[]) recordDuration(dir, 'Explore', s);
  let f = emptyAgents('s1');
  for (let i = 0; i <= 6; i++) {
    f = updateAgents(
      f,
      [{ id: 'a1', name: 'Explore', type: 'Explore', startTime: T * 1000, tokenCount: 20_000 + i * 1000, contextWindowSize: 200_000 }],
      T + i * 30,
    );
  }
  const row = renderAgentRow(f.agents.a1!, typeStats(dir), T + 180, 200);
  assert.match(row, /Explore/);
  assert.match(row, /ctx 26k[/]200k [(]13%[)]/);
  // The median is marked as a median with its sample size, not passed off as a prediction.
  assert.match(row, /3m of ≈6m \(n=3\)/);
});

test('an agent row warns when the agent is about to fill its own context', () => {
  let f = emptyAgents('s1');
  for (let i = 0; i <= 6; i++) {
    f = updateAgents(
      f,
      [{ id: 'a1', name: 'Worker', type: 'x', tokenCount: 195_000 + i * 500, contextWindowSize: 200_000 }],
      T + i * 30,
    );
  }
  assert.match(renderAgentRow(f.agents.a1!, {}, T + 180, 200), /ctx full/);
});

test('an agent row is truncated to the width it is given', () => {
  const f = updateAgents(
    emptyAgents('s1'),
    [{ id: 'a1', name: 'A very long agent name indeed', type: 'x', startTime: T * 1000 }],
    T,
  );
  const row = renderAgentRow(f.agents.a1!, {}, T + 60, 20);
  assert.ok(row.length <= 20, `row was ${row.length} chars`);
});

test('the agent sensor writes snapshots and emits one line per row', () => {
  const dir = tmp();
  const payload = JSON.stringify({
    session_id: 's1',
    cwd: dir,
    columns: 60,
    tasks: [
      { id: 'a1', name: 'Explore', type: 'Explore', tokenCount: 1000, contextWindowSize: 200_000 },
      { id: 'a2', name: 'Build', type: 'general-purpose', tokenCount: 2000 },
    ],
  });
  const out = senseAgents(payload, T);
  const lines = out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((l) => l.id), ['a1', 'a2']);
  assert.ok(lines[0].content.includes('Explore'));
  assert.equal(Object.keys(readAgents(dir, 's1').agents).length, 2);
});

test('the agent sensor stays silent rather than breaking the panel', () => {
  const dir = tmp();
  assert.equal(senseAgents('{not json', T), '');
  assert.equal(senseAgents(JSON.stringify({ cwd: dir, tasks: [] }), T), '');
  assert.equal(senseAgents(JSON.stringify({ cwd: dir, tasks: 'nope' }), T), '');
  assert.equal(senseAgents(JSON.stringify({ cwd: dir }), T), '');
});

// ------------------------------------------------------------------ the spawn gate

test('the gate is silent well away from a wall', () => {
  const dir = tmp();
  const g = gateSpawn({ prompt: 'go' }, stateAt('NORMAL'), cfg, dir, 's1', T);
  assert.equal(g.decision, null);
  assert.equal(g.updatedInput, undefined);
});

test('at PREPARE the gate lets the spawn through but makes the agent self-checkpointing', () => {
  const dir = tmp();
  const g = gateSpawn(
    { prompt: 'Research the payment flow', description: 'payment research', subagent_type: 'Explore' },
    stateAt('PREPARE'),
    cfg,
    dir,
    's1',
    T,
  );
  assert.equal(g.decision, null);
  const prompt = g.updatedInput?.prompt as string;
  assert.match(prompt, /^Research the payment flow/, 'the original prompt is preserved');
  assert.match(prompt, /Budget note from Session Guardian/);
  assert.match(prompt, /about 4m of five_hour budget left/);
  assert.match(prompt, /agent-notes\/payment-research\.md/);
  assert.match(prompt, /partial answer over returning nothing/);
  // Other tool arguments survive the rewrite.
  assert.equal(g.updatedInput?.subagent_type, 'Explore');
});

test('a re-spawned prompt does not accumulate budget notes', () => {
  const dir = tmp();
  const first = gateSpawn({ prompt: 'go', description: 'd' }, stateAt('PREPARE'), cfg, dir, 's1', T);
  const once = first.updatedInput?.prompt as string;
  const second = gateSpawn({ prompt: once, description: 'd' }, stateAt('PREPARE'), cfg, dir, 's1', T);
  assert.equal(second.updatedInput, undefined);
});

test('at LAND the gate denies the spawn, and says what to do instead', () => {
  const dir = tmp();
  const g = gateSpawn({ prompt: 'go' }, stateAt('LAND'), cfg, dir, 's1', T);
  assert.equal(g.decision, 'deny');
  assert.match(g.reason!, /LAND/);
  assert.match(g.reason!, /96% used/);
  assert.match(g.reason!, /cannot be checkpointed or resumed/);
  assert.match(g.reason!, /guardian handoff/);
  // A denial the user cannot override is a trap, so it names the escape hatch.
  assert.match(g.reason!, /deny_spawn_from/);
});

test('the denial reports how many agents are already running', () => {
  const dir = tmp();
  writeAgents(dir, updateAgents(emptyAgents('s1'), [{ id: 'a1' }, { id: 'a2' }], T));
  const g = gateSpawn({ prompt: 'go' }, stateAt('EMERGENCY'), cfg, dir, 's1', T + 5);
  assert.match(g.reason!, /2 agent\(s\) already running/);
});

test('the deny threshold is configurable in both directions', () => {
  const dir = tmp();
  const strict = { ...cfg, agents: { ...cfg.agents, deny_spawn_from: 'WATCH' as Mode } };
  assert.equal(gateSpawn({ prompt: 'x' }, stateAt('WATCH'), strict, dir, 's1', T).decision, 'deny');

  const lax = { ...cfg, agents: { ...cfg.agents, deny_spawn_from: 'HARD_STOPPED' as Mode } };
  assert.equal(gateSpawn({ prompt: 'x' }, stateAt('EMERGENCY'), lax, dir, 's1', T).decision, null);
});

test('the gate does not crash on a spawn with no prompt', () => {
  const dir = tmp();
  assert.equal(gateSpawn(undefined, stateAt('PREPARE'), cfg, dir, 's1', T).decision, null);
  assert.equal(gateSpawn({ prompt: 42 }, stateAt('PREPARE'), cfg, dir, 's1', T).updatedInput, undefined);
});

// ------------------------------------------------------------------ safe boundaries

test('glob patterns match the way the config implies', () => {
  assert.ok(globToRegExp('*migrate*').test('npm run db:migrate --force'));
  assert.ok(globToRegExp('terraform *').test('terraform apply -auto-approve'));
  assert.ok(!globToRegExp('terraform *').test('echo terraform apply'));
  assert.ok(globToRegExp('exact').test('exact'));
  assert.ok(!globToRegExp('exact').test('not exact here'));
});

test('irreversible commands are recognised', () => {
  const p = cfg.safe_boundary_commands;
  assert.ok(isSafeBoundaryCommand('npm run migrate', p));
  assert.ok(isSafeBoundaryCommand('terraform apply', p));
  assert.ok(isSafeBoundaryCommand('kubectl apply -f k8s/', p));
  assert.ok(isSafeBoundaryCommand('dotnet ef database update', p));
  assert.ok(!isSafeBoundaryCommand('npm test', p));
  assert.ok(!isSafeBoundaryCommand('ls -la', p));
});

test('an irreversible command is recorded and never blocked', () => {
  const dir = tmp();
  const g = markBoundary({ command: 'npm run db:migrate' }, cfg, dir, 's1', T);
  // Blocking a migration is sometimes right and sometimes leaves a half-configured system,
  // and Guardian cannot tell which — so it records rather than decides.
  assert.equal(g.decision, null);
  const m = buildManifest(dir, 's1', emptyState('s1'), 'r', T + 10, { git: false });
  assert.equal(m.observed.in_flight_at_seal.length, 1);
  assert.match(m.observed.in_flight_at_seal[0]!.command, /db:migrate/);
});

test('a boundary command that returned is no longer in flight', () => {
  const dir = tmp();
  markBoundary({ command: 'npm run db:migrate' }, cfg, dir, 's1', T);
  // PostToolUse only fires once the command returns.
  handle(
    'PostToolUse',
    JSON.stringify({
      session_id: 's1',
      cwd: dir,
      tool_name: 'Bash',
      tool_input: { command: 'npm run db:migrate' },
      tool_output: 'ok',
    }),
    T + 5,
  );
  const m = buildManifest(dir, 's1', emptyState('s1'), 'r', T + 10, { git: false });
  assert.equal(m.observed.in_flight_at_seal.length, 0);
});

test('an interrupted irreversible operation is the first warning in the digest', () => {
  const dir = tmp();
  markBoundary({ command: 'terraform apply -auto-approve' }, cfg, dir, 's1', T);
  const m = buildManifest(dir, 's1', emptyState('s1'), 'r', T + 10, { git: false });
  const d = renderDigest(m, dir);
  assert.match(d, /Possibly interrupted mid-operation/);
  assert.match(d, /terraform apply/);
  assert.match(d, /never seen to finish/);
});

test('a boundary command has its secrets removed before being recorded', () => {
  const dir = tmp();
  markBoundary({ command: 'deploy --token=abcdef123456 --env prod' }, cfg, dir, 's1', T);
  const m = buildManifest(dir, 's1', emptyState('s1'), 'r', T + 5, { git: false });
  assert.ok(!m.observed.in_flight_at_seal[0]!.command.includes('abcdef123456'));
});

// ------------------------------------------------------------------ through the hook

function hook(event: string, payload: object, t = T): { out: any; exit: number } {
  const r = handle(event, JSON.stringify(payload), t);
  return { out: r.stdout ? JSON.parse(r.stdout) : null, exit: r.exit };
}

test('PreToolUse emits a deny decision in the documented shape', () => {
  const dir = tmp();
  writeState(dir, stateAt('LAND'));
  const r = hook('PreToolUse', {
    session_id: 's1',
    cwd: dir,
    tool_name: 'Task',
    tool_input: { prompt: 'go', description: 'd' },
  });
  assert.equal(r.exit, 0, 'the gate must decide via JSON, never a nonzero exit');
  assert.equal(r.out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(r.out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(r.out.hookSpecificOutput.permissionDecisionReason, /LAND/);
});

test('PreToolUse emits updatedInput at PREPARE and nothing at NORMAL', () => {
  const dir = tmp();
  writeState(dir, stateAt('PREPARE'));
  const prep = hook('PreToolUse', {
    session_id: 's1',
    cwd: dir,
    tool_name: 'Task',
    tool_input: { prompt: 'go', description: 'd' },
  });
  assert.match(prep.out.hookSpecificOutput.updatedInput.prompt, /Budget note/);

  writeState(dir, stateAt('NORMAL'));
  const norm = hook('PreToolUse', {
    session_id: 's1',
    cwd: dir,
    tool_name: 'Task',
    tool_input: { prompt: 'go', description: 'd' },
  });
  assert.equal(norm.out, null);
});

test('the gate never blocks a tool that is not a spawn', () => {
  const dir = tmp();
  writeState(dir, stateAt('EMERGENCY'));
  for (const tool of ['Edit', 'Write', 'Read', 'Grep']) {
    const r = hook('PreToolUse', { session_id: 's1', cwd: dir, tool_name: tool, tool_input: {} });
    assert.equal(r.out, null, `${tool} was interfered with`);
  }
  // Not even an irreversible shell command, at the most severe mode there is.
  const sh = hook('PreToolUse', {
    session_id: 's1',
    cwd: dir,
    tool_name: 'Bash',
    tool_input: { command: 'terraform apply' },
  });
  assert.equal(sh.out, null);
});

test('SubagentStop feeds the duration table and clears the live snapshot', () => {
  const dir = tmp();
  writeAgents(
    dir,
    updateAgents(emptyAgents('s1'), [{ id: 'a1', type: 'Explore', startTime: T * 1000 }], T),
  );
  hook(
    'SubagentStop',
    { session_id: 's1', cwd: dir, agent_id: 'a1', agent_type: 'Explore', last_assistant_message: 'done' },
    T + 300,
  );
  assert.equal(typeStats(dir).Explore?.median_s, 300);
  assert.equal(Object.keys(readAgents(dir, 's1').agents).length, 0);
});

test('the sensor records whether the gate is currently blocking spawns', () => {
  const dir = tmp();
  const payload = (fh: number) =>
    JSON.stringify({
      session_id: 's1',
      workspace: { project_dir: dir },
      context_window: { used_percentage: 20 },
      rate_limits: { five_hour: { used_percentage: fh, resets_at: T + 4 * 3600 } },
    });
  // Percentage floor alone is enough to reach LAND while burn is unmeasurable.
  sense(payload(50), T);
  assert.equal(readState(dir, 's1').agents.spawn_allowed, true);
  sense(payload(96), T + 60);
  assert.equal(readState(dir, 's1').agents.spawn_allowed, false);
});

test('a just-started agent reads as elapsed, not as a countdown', () => {
  const f = updateAgents(
    emptyAgents('s1'),
    [{ id: 'a1', name: 'Explore', type: 'Explore', startTime: T * 1000 }],
    T,
  );
  const row = renderAgentRow(f.agents.a1!, { Explore: { count: 5, median_s: 300 } }, T, 200);
  // `fmtMin(0)` is "now", which is right for a deadline and wrong for elapsed time.
  assert.match(row, /<1m of ≈5m/);
  assert.doesNotMatch(row, /now of/);
});

test('the agents state file is not mistaken for a session of its own', () => {
  const dir = tmp();
  // Both files exist for one session; `s1.agents.json` must not read as session `s1.agents`.
  writeState(dir, { ...emptyState('s1'), updated_at: T });
  writeAgents(dir, updateAgents(emptyAgents('s1'), [{ id: 'a1', name: 'Explore' }], T));
  const r = spawnSync(process.execPath, [BUNDLE, 'agents'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, GUARDIAN_NOW: String(T + 10) },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Explore/, `agents output was: ${r.stdout}`);
  assert.doesNotMatch(r.stdout, /No live subagents/);
});

test('a row says what the agent is doing, and the meters survive a narrow terminal', () => {
  const a = {
    id: 'a1',
    name: 'Explore',
    type: 'Explore',
    status: 'running',
    description: 'map every call site of recordSample across src and test',
    started_at: T - 180,
    token_count: 42_000,
    context_window: 200_000,
    samples: [],
    tokens_per_min: null,
    last_seen: T,
  };
  const wide = renderAgentRow(a, {}, T, 120);
  assert.match(wide, /Explore · map every call site/);
  assert.match(wide, /ctx 42k[/]200k [(]21%[)]/);

  // Narrow: the description is what gives, because the meter and the clock are what a
  // decision near a wall is made on. Trimming the whole line would cut those instead.
  const narrow = renderAgentRow(a, {}, T, 60);
  assert.ok(narrow.length <= 60, `row was ${narrow.length} chars: ${narrow}`);
  assert.match(narrow, /ctx 42k[/]200k [(]21%[)]/);
  assert.match(narrow, /3m elapsed/);
  assert.match(narrow, /…/);
});

// ------------------------------------------------------------------ token counts

test('token counts read the way people say them', () => {
  assert.equal(fmtTokens(128_000), '128k');
  assert.equal(fmtTokens(1_000_000), '1M');
  assert.equal(fmtTokens(1_400_000), '1.4M');
  assert.equal(fmtTokens(200_000), '200k');
  // Below 10k a rounded thousand loses the distinction that matters: a 1450 tok/min pace
  // is not "1k/min", and a 9.5k window is not "10k".
  assert.equal(fmtTokens(1450), '1.5k');
  assert.equal(fmtTokens(9500), '9.5k');
  assert.equal(fmtTokens(840), '840');
  assert.equal(fmtTokens(Number.NaN), '?');
});

test('an agent row carries the absolute context, not only how full it is', () => {
  const rowFor = (tokenCount: number, contextWindowSize: number | undefined) => {
    const f = updateAgents(
      emptyAgents('s1'),
      [{ id: 'a1', name: 'Explore', type: 'Explore', startTime: T * 1000, tokenCount, ...(contextWindowSize ? { contextWindowSize } : {}) }],
      T + 30,
    );
    return renderAgentRow(f.agents.a1!, {}, T + 60, 200);
  };

  // 13% of 1M and 13% of 200k are different amounts of remaining work.
  assert.match(rowFor(128_000, 1_000_000), /ctx 128k[/]1M [(]13%[)]/);

  const unknown = rowFor(9500, undefined);
  assert.match(unknown, /ctx 9\.5k/);
  assert.doesNotMatch(unknown, /%/, 'no window means no percentage to claim');
});
