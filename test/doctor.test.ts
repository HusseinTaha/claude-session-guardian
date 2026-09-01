import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { audit, auditManifest, renderChecks, verdict, coldResume, logTail } from '../src/ui/doctor.ts';
import { emptyState, writeState } from '../src/core/state.ts';
import { seal, readLatest, type Manifest } from '../src/handoff/manifest.ts';
import { appendEvent, fileEvent } from '../src/handoff/ledger.ts';
import { configPath } from '../src/core/paths.ts';
import { install } from '../src/ui/install.ts';
import type { Check, CheckStatus } from '../src/ui/doctor.ts';
import type { GuardianState } from '../src/types.ts';

const T = 1_800_000_000;
const BUNDLE = fileURLToPath(new URL('../dist/guardian.cjs', import.meta.url));

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'guardian-doc-'));
  mkdirSync(join(d, '.claude', 'guardian'), { recursive: true });
  return d;
}

function g(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  return (r.stdout ?? '').trim();
}

function repo(): string {
  const dir = tmp();
  g(dir, 'init', '-q');
  g(dir, 'config', 'user.name', 'Test');
  g(dir, 'config', 'user.email', 't@e.com');
  g(dir, 'config', 'commit.gpgsign', 'false');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'auth.ts'), 'export const a = 1;\n');
  g(dir, 'add', '-A');
  g(dir, 'commit', '-q', '-m', 'initial');
  return dir;
}

function state(over: Partial<GuardianState> = {}): GuardianState {
  return {
    ...emptyState('s1'),
    updated_at: T,
    samples: [
      { t: T - 60, five_hour: 50 },
      { t: T - 30, five_hour: 52 },
      { t: T, five_hour: 54 },
    ],
    axes: {
      five_hour: {
        used_pct: 54,
        burn_pct_per_min: 2,
        resets_at: T + 3600,
        time_to_wall_min: 23,
        mode: 'WATCH',
      },
    },
    ...over,
  };
}

/** A fully-populated session, so the audit has something to pass on. */
function fullSession(dir: string): Manifest {
  const f = join(dir, 'src', 'auth.ts');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(f, 'export const a = 1;\n');
  appendEvent(dir, 's1', fileEvent(f, 'Edit', T - 100));
  appendEvent(dir, 's1', { k: 'command', t: T - 90, command: 'npm test', kind: 'test', ok: true });
  appendEvent(dir, 's1', { k: 'note', t: T - 80, field: 'objective', text: 'Implement auth' });
  appendEvent(dir, 's1', {
    k: 'note',
    t: T - 70,
    field: 'next_action',
    text: 'Finish rotateRefreshToken in src/auth.ts',
  });
  writeState(dir, state());
  return seal(dir, 's1', state(), 'test seal', T, { git: false });
}

function byName(checks: Check[], name: string): Check | undefined {
  return checks.find((c) => c.name === name);
}
function statusOf(checks: Check[], name: string): CheckStatus | undefined {
  return byName(checks, name)?.status;
}

// ------------------------------------------------------------------ static audit

test('a project with nothing set up fails on the things that matter', () => {
  const dir = tmp();
  const checks = audit(dir, null, T, join(dir, 'no-settings.json'));
  assert.equal(statusOf(checks, 'status line'), 'fail');
  assert.equal(statusOf(checks, 'sensor'), 'fail');
  assert.equal(statusOf(checks, 'handoff'), 'fail');
  assert.equal(verdict(checks).resumable, false);
  // Every failure has to say what to do about it.
  for (const c of checks.filter((x) => x.status === 'fail')) {
    assert.ok(c.fix, `"${c.name}" failed with no fix offered`);
  }
});

test('a fully set-up project with a complete handoff reports resumable', () => {
  const dir = repo();
  const settings = join(dir, 'settings.json');
  writeFileSync(settings, '{}');
  install(dir, settings);
  fullSession(dir);
  seal(dir, 's1', state(), 'test seal', T); // with a git checkpoint this time

  const checks = audit(dir, state(), T, settings);
  assert.equal(statusOf(checks, 'status line'), 'pass');
  assert.equal(statusOf(checks, 'agent rows'), 'pass');
  assert.equal(statusOf(checks, 'enabled'), 'pass');
  assert.equal(statusOf(checks, 'config'), 'pass');
  assert.equal(statusOf(checks, 'sensor'), 'pass');
  assert.equal(statusOf(checks, 'next action'), 'pass');
  assert.equal(statusOf(checks, 'checkpoint'), 'pass');
  assert.equal(verdict(checks).resumable, true);
  assert.equal(checks.filter((c) => c.status === 'fail').length, 0);
});

test('a missing next action is a failure, not a warning', () => {
  // It is the one field nothing else can substitute for: without it the resuming session
  // has to guess where to start, which is the exact failure the handoff exists to prevent.
  const dir = tmp();
  writeState(dir, state());
  const m = seal(dir, 's1', state(), 'r', T, { git: false });
  assert.equal(m.claude_supplied.next_action, null);
  assert.equal(statusOf(auditManifest(dir, m), 'next action'), 'fail');
});

test('the audit notices a checkpoint ref that has since been deleted', () => {
  const dir = repo();
  fullSession(dir);
  writeFileSync(join(dir, 'src', 'auth.ts'), 'modified\n');
  const m = seal(dir, 's1', state(), 'r', T);
  assert.equal(statusOf(auditManifest(dir, m), 'checkpoint'), 'pass');

  // Someone runs uninstall, or garbage-collects the refs.
  g(dir, 'update-ref', '-d', m.observed.checkpoint!.ref!);
  const after = auditManifest(dir, m);
  assert.equal(statusOf(after, 'checkpoint'), 'fail');
  assert.match(byName(after, 'checkpoint')!.detail, /no longer exists/);
});

test('the audit reports workspace drift since the seal', () => {
  const dir = tmp();
  const m = fullSession(dir);
  assert.equal(statusOf(auditManifest(dir, m), 'workspace'), 'pass');
  writeFileSync(join(dir, 'src', 'auth.ts'), 'someone else edited this\n');
  const after = auditManifest(dir, m);
  assert.equal(statusOf(after, 'workspace'), 'warn');
  assert.match(byName(after, 'workspace')!.detail, /1 file\(s\) changed/);
});

test('the audit surfaces stranded agents and interrupted operations', () => {
  const dir = tmp();
  fullSession(dir);
  appendEvent(dir, 's1', { k: 'agent', t: T - 20, id: 'a1', type: 'Explore', status: 'start' });
  appendEvent(dir, 's1', { k: 'boundary', t: T - 10, command: 'npm run migrate' });
  const m = seal(dir, 's1', state(), 'r', T, { git: false });

  const checks = auditManifest(dir, m);
  assert.equal(statusOf(checks, 'agents'), 'warn');
  assert.match(byName(checks, 'agents')!.detail, /still running at seal time/);
  assert.equal(statusOf(checks, 'in flight'), 'warn');
  assert.match(byName(checks, 'in flight')!.detail, /never seen to return/);
});

test('a failing test baseline is reported rather than glossed over', () => {
  const dir = tmp();
  appendEvent(dir, 's1', { k: 'command', t: T, command: 'npm test', kind: 'test', ok: false });
  const m = seal(dir, 's1', state(), 'r', T, { git: false });
  const c = byName(auditManifest(dir, m), 'test baseline')!;
  assert.equal(c.status, 'warn');
  assert.match(c.detail, /FAILING at seal time/);
});

test('a disabled Guardian is a failure, since it is silently doing nothing', () => {
  const dir = tmp();
  writeFileSync(configPath(dir), JSON.stringify({ enabled: false }));
  const checks = audit(dir, state(), T, join(dir, 'nope.json'));
  assert.equal(statusOf(checks, 'enabled'), 'fail');
});

test('an invalid config is reported with the offending key', () => {
  const dir = tmp();
  writeFileSync(configPath(dir), JSON.stringify({ thresholds_minutes: { land: 99 } }));
  const c = byName(audit(dir, state(), T, join(dir, 'nope.json')), 'config')!;
  assert.equal(c.status, 'fail');
  assert.match(c.detail, /thresholds_minutes\.land/);
});

test('a non-repository skips the checkpoint check instead of failing it', () => {
  const dir = tmp();
  const m = fullSession(dir);
  assert.equal(statusOf(auditManifest(dir, m), 'checkpoint'), 'skip');
});

test('an account without rate limits warns and explains why', () => {
  const dir = tmp();
  const noLimits = { ...state(), axes: { context: { used_pct: 30, burn_pct_per_min: 1, time_to_wall_min: 70, mode: 'NORMAL' as const } } };
  const c = byName(audit(dir, noLimits, T, join(dir, 'nope.json')), 'rate limits')!;
  assert.equal(c.status, 'warn');
  assert.match(c.fix!, /expected outside Claude.ai Pro and Max/);
});

test('the report renders every check and every fix', () => {
  const dir = tmp();
  const out = renderChecks(audit(dir, null, T, join(dir, 'nope.json')));
  assert.match(out, /\[FAIL\] status line/);
  assert.match(out, /→ run `guardian init`/);
});

test('verdict distinguishes not-resumable, resumable-with-gaps, and clean', () => {
  const mk = (s: CheckStatus): Check[] => [{ name: 'x', status: s, detail: 'd' }];
  assert.equal(verdict(mk('fail')).resumable, false);
  assert.match(verdict(mk('fail')).text, /NOT RESUMABLE/);
  assert.match(verdict(mk('warn')).text, /RESUMABLE with gaps/);
  assert.match(verdict(mk('pass')).text, /a fresh session has everything it needs/);
});

// ------------------------------------------------------------------ cold resume

test('cold resume declines cleanly outside a git repository', () => {
  const dir = tmp();
  const m = fullSession(dir);
  const r = coldResume(dir, m);
  assert.equal(r.ok, false);
  assert.match(r.detail, /not a git repository/);
});

test('cold resume declines when the manifest has no live checkpoint', () => {
  const dir = repo();
  const m = fullSession(dir); // sealed with git: false, so no ref
  const r = coldResume(dir, m);
  assert.equal(r.ok, false);
  assert.match(r.detail, /no live checkpoint ref/);
});

test('cold resume cleans up its worktree even when the model call fails', () => {
  const dir = repo();
  fullSession(dir);
  writeFileSync(join(dir, 'src', 'auth.ts'), 'modified\n');
  const m = seal(dir, 's1', state(), 'r', T);
  assert.equal(m.observed.checkpoint?.kind, 'ref');

  // `claude` is almost certainly not runnable in a test environment; what matters is that
  // the failure is reported and nothing is left behind.
  const r = coldResume(dir, m, { timeoutMs: 5000 });
  if (!r.ok) assert.match(r.detail, /claude -p did not complete|worktree/);
  assert.equal(g(dir, 'worktree', 'list').split('\n').length, 1, 'a worktree was left behind');
});

// ------------------------------------------------------------------ log

test('an absent log says so rather than looking broken', () => {
  assert.match(logTail(tmp()), /nothing has failed/);
});

test('the log tail is bounded', () => {
  const dir = tmp();
  mkdirSync(join(dir, '.claude', 'guardian', 'logs'), { recursive: true });
  const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
  writeFileSync(join(dir, '.claude', 'guardian', 'logs', 'guardian.log'), lines);
  const tail = logTail(dir, 10);
  assert.equal(tail.split('\n').length, 10);
  assert.match(tail, /line 199/);
});

// ------------------------------------------------------------------ through the CLI

test('doctor runs, reports, and exits 0 by default even when unhealthy', () => {
  const dir = tmp();
  const r = spawnSync(process.execPath, [BUNDLE, 'doctor'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, GUARDIAN_NOW: String(T) },
  });
  // A diagnostic that fails the build by default would be a nuisance.
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Guardian self-check/);
  assert.match(r.stdout, /NOT RESUMABLE/);
  assert.match(r.stdout, /doctor --cold/);
});

test('doctor --strict exits nonzero when the work is not resumable', () => {
  const dir = tmp();
  const r = spawnSync(process.execPath, [BUNDLE, 'doctor', '--strict'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, GUARDIAN_NOW: String(T) },
  });
  assert.equal(r.status, 1);
});
