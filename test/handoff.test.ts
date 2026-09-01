import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appendEvent, fileEvent } from '../src/handoff/ledger.ts';
import {
  buildManifest,
  seal,
  readLatest,
  hasUnconsumed,
  markConsumed,
  verify,
  renderDigest,
  latestDigestPath,
} from '../src/handoff/manifest.ts';
import { emptyState, readState, writeState } from '../src/core/state.ts';
import { handle } from '../src/actuators/dispatch.ts';
import { configPath } from '../src/core/paths.ts';
import type { GuardianState } from '../src/types.ts';

const T = 1_800_000_000;
const tmp = () => mkdtempSync(join(tmpdir(), 'guardian-ho-'));
const BUNDLE = fileURLToPath(new URL('../dist/guardian.cjs', import.meta.url));

function stateWith(over: Partial<GuardianState> = {}): GuardianState {
  const s = emptyState('sess-A');
  s.mode = 'LAND';
  s.binding_axis = 'five_hour';
  s.model = 'Opus';
  s.axes = {
    context: { used_pct: 71, burn_pct_per_min: 2, time_to_wall_min: 14, mode: 'WATCH' },
    five_hour: {
      used_pct: 96.1,
      burn_pct_per_min: 1,
      resets_at: T + 3600,
      time_to_wall_min: 3.9,
      mode: 'LAND',
    },
  };
  return { ...s, ...over };
}

/** A session's worth of observations, as the hooks would have recorded them. */
function seedLedger(dir: string, sid = 'sess-A'): string {
  const f1 = join(dir, 'src', 'a.ts');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(f1, 'export const a = 1;\n');
  appendEvent(dir, sid, fileEvent(f1, 'Write', T - 300));
  appendEvent(dir, sid, fileEvent(f1, 'Edit', T - 200)); // same file twice
  appendEvent(dir, sid, {
    k: 'command',
    t: T - 150,
    command: 'npm test',
    kind: 'test',
    ok: true,
  });
  appendEvent(dir, sid, { k: 'commit', t: T - 100, sha: 'a82f91c0deadbeef', subject: 'wire it up' });
  appendEvent(dir, sid, { k: 'task', t: T - 90, id: 't1', title: 'Schema', status: 'created' });
  appendEvent(dir, sid, { k: 'task', t: T - 80, id: 't1', title: 'Schema', status: 'completed' });
  appendEvent(dir, sid, { k: 'task', t: T - 70, id: 't2', title: 'Refresh tokens', status: 'created' });
  appendEvent(dir, sid, { k: 'agent', t: T - 60, id: 'ag1', type: 'Explore', status: 'start' });
  appendEvent(dir, sid, {
    k: 'agent',
    t: T - 50,
    id: 'ag1',
    type: 'Explore',
    status: 'stop',
    summary: 'found three call sites',
  });
  appendEvent(dir, sid, { k: 'agent', t: T - 40, id: 'ag2', type: 'general-purpose', status: 'start' });
  appendEvent(dir, sid, { k: 'note', t: T - 30, field: 'objective', text: 'Implement auth' });
  appendEvent(dir, sid, { k: 'note', t: T - 20, field: 'next_action', text: 'Finish token rotation' });
  appendEvent(dir, sid, { k: 'note', t: T - 10, field: 'gotcha', text: 'Clock skew in tests' });
  return f1;
}

test('the manifest folds the ledger into observed state', () => {
  const dir = tmp();
  seedLedger(dir);
  const m = buildManifest(dir, 'sess-A', stateWith(), 'test seal', T, { git: false });

  assert.equal(m.observed.files_touched.length, 1, 'a file edited twice is one entry');
  assert.ok(m.observed.files_touched[0]?.sha256);
  assert.deepEqual(m.observed.commits.map((c) => c.sha), ['a82f91c0deadbeef']);
  assert.equal(m.observed.tests?.ok, true);
  assert.deepEqual(m.tasks.completed, ['Schema']);
  assert.deepEqual(m.tasks.in_progress, ['Refresh tokens']);
  assert.equal(m.objective, 'Implement auth');
  assert.equal(m.claude_supplied.next_action, 'Finish token rotation');
  assert.deepEqual(m.claude_supplied.gotchas, ['Clock skew in tests']);

  // An agent that returned is distinguished from one still running at seal time.
  const ag1 = m.agents.find((a) => a.id === 'ag1');
  const ag2 = m.agents.find((a) => a.id === 'ag2');
  assert.equal(ag1?.status, 'RETURNED');
  assert.equal(ag1?.summary, 'found three call sites');
  assert.equal(ag1?.redo_cost_estimate, 'low', 'a read-only explorer is cheap to re-run');
  assert.equal(ag2?.status, 'IN_FLIGHT_AT_SEAL');

  assert.equal(m.usage_at_seal.five_hour_pct, 96.1);
  assert.equal(m.consumed_at, null);
});

test('the digest is compact and leads with the next action', () => {
  const dir = tmp();
  seedLedger(dir);
  const m = buildManifest(dir, 'sess-A', stateWith(), 'LAND: 5-hour 3.9m to wall', T, { git: false });
  const d = renderDigest(m, dir);

  assert.match(d, /^# Guardian handoff/);
  assert.match(d, /## Next action\nFinish token rotation/);
  assert.match(d, /## Completed — do not redo\n- Schema/);
  assert.match(d, /## In progress\n- Refresh tokens/);
  assert.match(d, /src\/a\.ts/, 'paths are project-relative and posix-shaped');
  assert.match(d, /npm test` — passing/);
  assert.match(d, /5-hour 96%/);
  // It gets injected into a context window, so size is a feature.
  assert.ok(d.length < 3000, `digest was ${d.length} chars`);
});

test('the digest caps a long file list instead of dumping it', () => {
  const dir = tmp();
  mkdirSync(join(dir, 'src'), { recursive: true });
  for (let i = 0; i < 60; i++) {
    const f = join(dir, 'src', `f${i}.ts`);
    writeFileSync(f, `// ${i}\n`);
    appendEvent(dir, 'sess-A', fileEvent(f, 'Write', T - 60 + i));
  }
  const m = buildManifest(dir, 'sess-A', stateWith(), 'r', T, { git: false });
  const d = renderDigest(m, dir);
  assert.match(d, /## Files touched \(60\)/);
  assert.match(d, /and 35 more/);
});

test('verify distinguishes unchanged, changed and missing work', () => {
  const dir = tmp();
  const f1 = seedLedger(dir);
  const f2 = join(dir, 'src', 'b.ts');
  writeFileSync(f2, 'export const b = 2;\n');
  appendEvent(dir, 'sess-A', fileEvent(f2, 'Write', T - 5));
  const m = seal(dir, 'sess-A', stateWith(), 'r', T, { git: false });

  // Nothing touched yet.
  let v = verify(dir, m);
  assert.equal(v.files.filter((f) => f.status === 'unchanged').length, 2);

  // Someone edits one file and deletes the other outside the handoff.
  writeFileSync(f1, 'export const a = 999;\n');
  rmSync(f2);
  v = verify(dir, m);
  assert.equal(v.files.find((f) => f.path === f1)?.status, 'changed');
  assert.equal(v.files.find((f) => f.path === f2)?.status, 'missing');
});

test('a sealed manifest can be consumed exactly once', () => {
  const dir = tmp();
  seedLedger(dir);
  seal(dir, 'sess-A', stateWith(), 'r', T, { git: false });
  assert.ok(hasUnconsumed(dir));
  markConsumed(dir, T + 10);
  assert.equal(hasUnconsumed(dir), null);
  assert.equal(readLatest(dir)?.consumed_at, T + 10);
});

test('sealing writes latest, the digest, and a history entry', () => {
  const dir = tmp();
  seedLedger(dir);
  const m = seal(dir, 'sess-A', stateWith(), 'r', T, { git: false });
  assert.ok(readLatest(dir));
  assert.ok(readFileSync(latestDigestPath(dir), 'utf8').startsWith('# Guardian handoff'));
  const stamp = m.sealed_at_iso.replace(/[:.]/g, '-');
  assert.ok(readFileSync(join(dir, '.claude', 'guardian', 'handoff', 'history', `${stamp}.json`), 'utf8'));
});

// ---------------------------------------------------------------- hook dispatch

function hook(event: string, payload: object, t = T): { out: unknown; exit: number } {
  const r = handle(event, JSON.stringify(payload), t);
  return { out: r.stdout ? JSON.parse(r.stdout) : null, exit: r.exit };
}

test('PostToolUse records an edited file', () => {
  const dir = tmp();
  mkdirSync(join(dir, '.claude', 'guardian'), { recursive: true });
  const f = join(dir, 'x.ts');
  writeFileSync(f, 'hi\n');
  const r = hook('PostToolUse', {
    session_id: 's1',
    cwd: dir,
    tool_name: 'Edit',
    tool_input: { file_path: f },
  });
  assert.equal(r.exit, 0);
  const m = buildManifest(dir, 's1', emptyState('s1'), 'r', T, { git: false });
  assert.equal(m.observed.files_touched[0]?.path, f);
});

test('PostToolUse records a command with secrets already removed', () => {
  const dir = tmp();
  mkdirSync(join(dir, '.claude', 'guardian'), { recursive: true });
  hook('PostToolUse', {
    session_id: 's1',
    cwd: dir,
    tool_name: 'Bash',
    tool_input: { command: 'deploy --token=abcdef123456' },
    tool_output: 'Done in 2s',
  });
  const m = buildManifest(dir, 's1', emptyState('s1'), 'r', T, { git: false });
  const cmd = m.observed.commands[0]?.command ?? '';
  assert.ok(cmd.includes('deploy'));
  assert.ok(!cmd.includes('abcdef123456'), `secret survived: ${cmd}`);
});

test('PreCompact seals a handoff and PostCompact hands the digest back', () => {
  const dir = tmp();
  mkdirSync(join(dir, '.claude', 'guardian'), { recursive: true });
  seedLedger(dir, 's1');
  writeState(dir, { ...stateWith(), session_id: 's1' });

  const pre = hook('PreCompact', { session_id: 's1', cwd: dir, reason: 'auto' });
  assert.match((pre.out as { systemMessage: string }).systemMessage, /sealed a handoff/);
  assert.ok(readLatest(dir), 'PreCompact did not seal');
  assert.equal(readState(dir, 's1').manifest.sealed_at, T);

  const post = hook('PostCompact', { session_id: 's1', cwd: dir, reason: 'auto' });
  const ctx = (post.out as { additionalContext: string }).additionalContext;
  assert.match(ctx, /Guardian handoff/);
  assert.match(ctx, /Finish token rotation/);
  assert.match(ctx, /do not redo/i);
});

test('PostCompact stays silent when there is nothing sealed', () => {
  const dir = tmp();
  mkdirSync(join(dir, '.claude', 'guardian'), { recursive: true });
  assert.deepEqual(hook('PostCompact', { session_id: 's1', cwd: dir }), { out: null, exit: 0 });
});

test('UserPromptSubmit offers a previous session handoff exactly once', () => {
  const dir = tmp();
  mkdirSync(join(dir, '.claude', 'guardian'), { recursive: true });
  seedLedger(dir, 'old-session');
  seal(dir, 'old-session', stateWith(), 'LAND: out of budget', T, { git: false });

  const first = hook('UserPromptSubmit', { session_id: 'new-session', cwd: dir }, T + 600);
  const ctx = (first.out as { additionalContext: string }).additionalContext;
  assert.match(ctx, /unfinished handoff/);
  assert.match(ctx, /10 minutes ago/);
  assert.match(ctx, /Finish token rotation/);
  assert.match(ctx, /guardian resume/);

  // A latch, so it does not nag on every prompt for the rest of the session.
  const second = hook('UserPromptSubmit', { session_id: 'new-session', cwd: dir }, T + 700);
  assert.equal(second.out, null);
});

test('UserPromptSubmit does not offer a session its own handoff', () => {
  const dir = tmp();
  mkdirSync(join(dir, '.claude', 'guardian'), { recursive: true });
  seedLedger(dir, 's1');
  seal(dir, 's1', stateWith(), 'PreCompact', T, { git: false });
  assert.equal(hook('UserPromptSubmit', { session_id: 's1', cwd: dir }, T + 60).out, null);
});

test('UserPromptSubmit does not offer a handoff that was already consumed', () => {
  const dir = tmp();
  mkdirSync(join(dir, '.claude', 'guardian'), { recursive: true });
  seedLedger(dir, 'old');
  seal(dir, 'old', stateWith(), 'r', T, { git: false });
  markConsumed(dir, T + 1);
  assert.equal(hook('UserPromptSubmit', { session_id: 'fresh', cwd: dir }, T + 60).out, null);
});

test('SessionEnd seals, and does so without a git checkpoint', () => {
  const dir = tmp();
  mkdirSync(join(dir, '.claude', 'guardian'), { recursive: true });
  seedLedger(dir, 's1');
  writeState(dir, { ...stateWith(), session_id: 's1', updated_at: T });
  hook('SessionEnd', { session_id: 's1', cwd: dir, reason: 'clear' });
  const m = readLatest(dir);
  assert.match(m?.seal_reason ?? '', /SessionEnd \(clear\)/);
  // SessionEnd shares a 1.5s budget with every other SessionEnd hook.
  assert.equal(m?.observed.checkpoint, null);
});

test('SessionEnd does not seal an empty session', () => {
  const dir = tmp();
  mkdirSync(join(dir, '.claude', 'guardian'), { recursive: true });
  hook('SessionEnd', { session_id: 's1', cwd: dir, reason: 'other' });
  assert.equal(readLatest(dir), null);
});

test('task and agent events reach the ledger', () => {
  const dir = tmp();
  mkdirSync(join(dir, '.claude', 'guardian'), { recursive: true });
  hook('TaskCreated', { session_id: 's1', cwd: dir, task_id: 't9', task_title: 'Do a thing' });
  hook('TaskCompleted', { session_id: 's1', cwd: dir, task_id: 't9', task_title: 'Do a thing' });
  hook('SubagentStart', { session_id: 's1', cwd: dir, agent_id: 'a1', agent_type: 'Explore' });
  hook('SubagentStop', {
    session_id: 's1',
    cwd: dir,
    agent_id: 'a1',
    agent_type: 'Explore',
    last_assistant_message: 'done looking',
  });
  const m = buildManifest(dir, 's1', emptyState('s1'), 'r', T, { git: false });
  assert.deepEqual(m.tasks.completed, ['Do a thing']);
  assert.equal(m.agents[0]?.status, 'RETURNED');
  assert.equal(m.agents[0]?.summary, 'done looking');
});

test('hooks fail open on garbage, unknown events, and a disabled config', () => {
  const dir = tmp();
  mkdirSync(join(dir, '.claude', 'guardian'), { recursive: true });

  assert.deepEqual(handle('PostToolUse', '{not json', T), { stdout: '', exit: 0 });
  assert.deepEqual(handle('NoSuchEvent', JSON.stringify({ cwd: dir }), T), { stdout: '', exit: 0 });

  writeFileSync(configPath(dir), JSON.stringify({ enabled: false }));
  seedLedger(dir, 's1');
  seal(dir, 's1', stateWith(), 'r', T, { git: false });
  // Disabled means silent, even where there is something to say.
  assert.deepEqual(handle('PostCompact', JSON.stringify({ session_id: 's1', cwd: dir }), T), {
    stdout: '',
    exit: 0,
  });
});

test('a redacted test command is not handed back as something to run verbatim', () => {
  const dir = tmp();
  appendEvent(dir, 's1', {
    k: 'command',
    t: T,
    command: 'npm test -- --token=[REDACTED]',
    kind: 'test',
    ok: true,
  });
  const m = buildManifest(dir, 's1', emptyState('s1'), 'r', T, { git: false });
  const step = m.resume_protocol.find((s) => /baseline|Run `/.test(s)) ?? '';
  assert.match(step, /secret was stripped/);
  assert.doesNotMatch(step, /^Run `/);
});

test('an intact test command is still handed back as a command to run', () => {
  const dir = tmp();
  appendEvent(dir, 's1', { k: 'command', t: T, command: 'npm test', kind: 'test', ok: true });
  const m = buildManifest(dir, 's1', emptyState('s1'), 'r', T, { git: false });
  assert.ok(m.resume_protocol.some((s) => s.startsWith('Run `npm test`')));
});

test('Guardian ignores its own state tree the first time it writes, not only on install', () => {
  const dir = tmp();
  // No install() call: the directory comes into existence through a plain hook write.
  appendEvent(dir, 's1', { k: 'note', t: T, field: 'objective', text: 'x' });
  assert.equal(
    readFileSync(join(dir, '.claude', 'guardian', '.gitignore'), 'utf8').trim(),
    '*',
    'a git checkpoint would otherwise capture prompts and commands',
  );
});

test('notes reach the session the hooks are actually recording into', () => {
  // A session that has a ledger but no state file yet: hooks have run, the status line
  // has not. `note` used to miss this session entirely and write to a phantom one.
  const dir = tmp();
  appendEvent(dir, 'real-session', { k: 'note', t: T, field: 'objective', text: 'x' });
  const r = spawnSync(process.execPath, [BUNDLE, 'note', '--next', 'Finish token rotation'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, GUARDIAN_NOW: String(T + 5) },
  });
  assert.equal(r.status, 0, r.stderr);
  const m = buildManifest(dir, 'real-session', emptyState('real-session'), 'r', T + 10, {
    git: false,
  });
  assert.equal(m.claude_supplied.next_action, 'Finish token rotation');
});

test("an agent's own notes travel in the handoff", () => {
  const dir = tmp();
  const notes = join(dir, '.claude', 'guardian', 'agent-notes');
  mkdirSync(notes, { recursive: true });
  writeFileSync(
    join(notes, 'map-call-sites.md'),
    [
      'Established: recordSample is called from statusline.ts:64 only.',
      'Next: check subagents.ts.',
    ].join(String.fromCharCode(10)),
  );

  // Guardian tells agents near a wall to keep these files current, then never read them
  // back: the handoff said "agent X was running" and not one line of what X had found.
  const m = seal(dir, 's1', emptyState('s1'), 'r', T, { git: false });
  assert.equal(m.observed.agent_notes.length, 1);
  assert.match(m.observed.agent_notes[0]!.file, /agent-notes\/map-call-sites\.md/);
  assert.match(m.observed.agent_notes[0]!.excerpt, /statusline\.ts:64/);

  const digest = renderDigest(m, dir);
  assert.match(digest, /What the agents wrote down/);
  assert.match(digest, /Next: check subagents\.ts/);
});

// ------------------------------------------------------------------ retention

test('sealing keeps the recent history and lets go of the rest', () => {
  const dir = tmp();
  for (let i = 0; i < 24; i++) seal(dir, 'sess-A', stateWith(), `seal ${i}`, T + i * 60, { git: false });
  const kept = readdirSync(join(dir, '.claude', 'guardian', 'handoff', 'history')).sort();
  assert.equal(kept.length, 20, 'an unbounded set of tree-pinning snapshots is a growing repo');
  // The newest survive: the oldest four stamps are the ones gone.
  assert.ok(kept[kept.length - 1]!.includes(new Date((T + 23 * 60) * 1000).toISOString().slice(0, 10)));
  assert.equal(readLatest(dir)?.seal_reason, 'seal 23');
});

// ------------------------------------------------------------------ the unstated next action

test('a digest with no stated next action says what was in flight, and says it is not intent', () => {
  const dir = tmp();
  appendEvent(dir, 'sess-A', { k: 'task', t: T - 30, id: 't1', title: 'Wire the reuse branch', status: 'created' });
  appendEvent(dir, 'sess-A', { k: 'agent', t: T - 20, id: 'ag1', type: 'Explore', status: 'start' });
  const m = buildManifest(dir, 'sess-A', stateWith(), 'auto-seal (LAND)', T, { git: false });
  const digest = renderDigest(m, dir);

  assert.match(digest, /## Next action — NOT STATED/);
  assert.match(digest, /task still open: Wire the reuse branch/);
  assert.match(digest, /agent Explore \(ag1\) was still running/);
  assert.doesNotMatch(digest, /^## Next action$/m, 'an observation must never be printed as a stated one');
});

test('a stated next action still wins outright', () => {
  const dir = tmp();
  appendEvent(dir, 'sess-A', { k: 'note', t: T - 5, field: 'next_action', text: 'Finish rotateRefreshToken()' });
  appendEvent(dir, 'sess-A', { k: 'task', t: T - 30, id: 't1', title: 'something open', status: 'created' });
  const digest = renderDigest(buildManifest(dir, 'sess-A', stateWith(), 'manual', T, { git: false }), dir);
  assert.match(digest, /## Next action\nFinish rotateRefreshToken\(\)/);
  assert.doesNotMatch(digest, /NOT STATED/);
});
