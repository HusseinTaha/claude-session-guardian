import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  injectionFor,
  forceSealInstruction,
  parseRateLimitTombstone,
  isRateLimitError,
  readTail,
  countdown,
} from '../src/landing.ts';
import { handle } from '../src/hooks.ts';
import { emptyState, readState, writeState } from '../src/state.ts';
import { readLatest, seal } from '../src/manifest.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { configPath } from '../src/paths.ts';
import { appendEvent } from '../src/ledger.ts';
import type { GuardianState, Mode } from '../src/types.ts';

const T = 1_800_000_000;
const cfg = DEFAULT_CONFIG;

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'guardian-land-'));
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

function hook(event: string, payload: object, t = T) {
  const r = handle(event, JSON.stringify(payload), t);
  return { out: r.stdout ? (JSON.parse(r.stdout) as any) : null, exit: r.exit, stderr: r.stderr };
}

// ------------------------------------------------------------------ tiered injection

test('nothing is injected below the configured mode', () => {
  for (const m of ['NORMAL', 'WATCH'] as Mode[]) {
    assert.equal(injectionFor(stateAt(m), cfg), null, `${m} should be silent`);
  }
});

test('injection cost rises with severity, and stays small at PREPARE', () => {
  const prepare = injectionFor(stateAt('PREPARE'), cfg)!;
  const land = injectionFor(stateAt('LAND'), cfg)!;
  const emergency = injectionFor(stateAt('EMERGENCY'), cfg)!;

  // Guardian exists to conserve budget, so it must not spend much of it talking.
  assert.ok(prepare.length < 220, `PREPARE brief was ${prepare.length} chars`);
  assert.ok(land.length > prepare.length);
  assert.ok(land.length < 900, `LAND protocol was ${land.length} chars`);
  assert.ok(emergency.length < prepare.length + 200);

  assert.match(prepare, /PREPARE/);
  assert.match(prepare, /cannot reach a reportable state/);
  assert.match(land, /guardian handoff/);
  assert.match(land, /note --next/);
  assert.match(land, /New subagents are blocked/);
  assert.match(emergency, /Start nothing else/);
});

test('the LAND protocol asks for intent, since everything else is already observed', () => {
  const land = injectionFor(stateAt('LAND'), cfg)!;
  assert.match(land, /files, commands, commits, tasks and tests/);
  // The sentence wraps, so match across the line break.
  assert.match(land, /cannot\s+see is intent/);
});

test('inject_from is configurable', () => {
  const late = { ...cfg, landing: { ...cfg.landing, inject_from: 'LAND' as Mode } };
  assert.equal(injectionFor(stateAt('PREPARE'), late), null);
  assert.ok(injectionFor(stateAt('LAND'), late));

  const early = { ...cfg, landing: { ...cfg.landing, inject_from: 'WATCH' as Mode } };
  // WATCH has no brief of its own, so it stays silent even when enabled.
  assert.equal(injectionFor(stateAt('WATCH'), early), null);
});

test('HARD_STOPPED says when the window reopens and what to do', () => {
  const s = injectionFor(stateAt('HARD_STOPPED'), cfg)!;
  assert.match(s, /HARD_STOPPED/);
  assert.match(s, /refused a request/);
  assert.match(s, /guardian wait/);
  assert.match(s, /Do not retry/);
  assert.match(s, /2027-01-15 09:00/); // T + 3600, rendered to the minute
});

test('the HARD_STOPPED brief takes the reset time from the 429 record itself', () => {
  // A session can be refused before the status line has ever run, leaving the axes empty.
  // The reset time is the single most important fact in this message, so it must not come
  // only from a gauge that may not exist.
  const bare = {
    ...emptyState('s1'),
    mode: 'HARD_STOPPED' as Mode,
    reason: 'five_hour rate limit refused a request',
    hard_stop: { at: T, kind: 'five_hour', resets_at: T + 5400 },
  };
  const s = injectionFor(bare, cfg)!;
  assert.match(s, /\(five_hour\)/);
  assert.match(s, /2027-01-15 09:30/);
  assert.match(s, /nothing will succeed before then/);
});

test('an unrecorded reset time is admitted rather than glossed over', () => {
  const s = injectionFor(
    {
      ...emptyState('s1'),
      mode: 'HARD_STOPPED' as Mode,
      reason: 'r',
      hard_stop: { at: T, kind: 'unknown', resets_at: null },
    },
    cfg,
  )!;
  assert.match(s, /reset time was not recorded/);
});

test('UserPromptSubmit carries both the resume offer and the mode brief', () => {
  const dir = tmp();
  appendEvent(dir, 'old', { k: 'note', t: T - 100, field: 'next_action', text: 'Finish rotation' });
  seal(dir, 'old', stateAt('LAND'), 'LAND: out of budget', T - 50, { git: false });
  writeState(dir, stateAt('LAND'));

  const r = hook('UserPromptSubmit', { session_id: 's1', cwd: dir }, T);
  const ctx = r.out.additionalContext as string;
  assert.match(ctx, /unfinished handoff/);
  assert.match(ctx, /Finish rotation/);
  assert.match(ctx, /Guardian: LAND/);
});

test('the mode brief repeats on later prompts while the resume offer does not', () => {
  const dir = tmp();
  writeState(dir, stateAt('LAND'));
  const first = hook('UserPromptSubmit', { session_id: 's1', cwd: dir }, T);
  const second = hook('UserPromptSubmit', { session_id: 's1', cwd: dir }, T + 60);
  assert.match(first.out.additionalContext, /Guardian: LAND/);
  assert.match(second.out.additionalContext, /Guardian: LAND/);
});

test('a NORMAL session gets nothing injected at all', () => {
  const dir = tmp();
  writeState(dir, stateAt('NORMAL'));
  const r = hook('UserPromptSubmit', { session_id: 's1', cwd: dir }, T);
  assert.equal(r.out, null);
});

// ------------------------------------------------------------------ the Stop latch

test('Stop refuses the turn-end once at LAND with no sealed handoff', () => {
  const dir = tmp();
  writeState(dir, stateAt('LAND'));
  const r = hook('Stop', { session_id: 's1', cwd: dir, stop_reason: 'end_turn' }, T);
  assert.equal(r.exit, 2, 'exit 2 is how Stop prevents the turn ending');
  assert.match(r.stderr!, /Before stopping, do exactly this/);
  assert.match(r.stderr!, /note --next/);
  assert.match(r.stderr!, /handoff --reason/);
});

// The load-bearing property of the whole phase: a Stop hook that can fire twice is a loop,
// and a loop here is far worse than no hook at all.
test('Stop is single-shot, no matter how many times it fires', () => {
  const dir = tmp();
  writeState(dir, stateAt('EMERGENCY'));
  const first = hook('Stop', { session_id: 's1', cwd: dir }, T);
  assert.equal(first.exit, 2);
  assert.equal(readState(dir, 's1').latches.stop_forced, true, 'the latch must be persisted');

  for (let i = 0; i < 10; i++) {
    const again = hook('Stop', { session_id: 's1', cwd: dir }, T + i * 10);
    assert.equal(again.exit, 0, `Stop fired again on attempt ${i + 2}`);
    assert.equal(again.stderr, undefined);
  }
});

test('Stop stays out of the way when there is nothing to force', () => {
  const dir = tmp();

  // Calm modes.
  for (const m of ['NORMAL', 'WATCH', 'PREPARE'] as Mode[]) {
    writeState(dir, { ...stateAt(m), session_id: `sess-${m}` });
    assert.equal(hook('Stop', { session_id: `sess-${m}`, cwd: dir }, T).exit, 0, m);
  }

  // Already sealed: there is nothing left to ask for.
  writeState(dir, { ...stateAt('LAND'), session_id: 'sealed', manifest: { sealed_at: T - 10 } });
  assert.equal(hook('Stop', { session_id: 'sealed', cwd: dir }, T).exit, 0);
});

test('the Stop brake can be switched off entirely', () => {
  const dir = tmp();
  writeFileSync(configPath(dir), JSON.stringify({ landing: { force_seal_turn: false } }));
  writeState(dir, stateAt('EMERGENCY'));
  assert.equal(hook('Stop', { session_id: 's1', cwd: dir }, T).exit, 0);
  assert.equal(readState(dir, 's1').latches.stop_forced, undefined);
});

// ------------------------------------------------------------------ the loop brake

test('the loop brake is off by default', () => {
  const dir = tmp();
  writeState(dir, { ...stateAt('EMERGENCY'), manifest: { sealed_at: T - 5 } });
  assert.equal(hook('PostToolBatch', { session_id: 's1', cwd: dir, tool_calls: [] }, T).exit, 0);
});

test('the loop brake halts only at EMERGENCY with a sealed handoff', () => {
  const dir = tmp();
  writeFileSync(configPath(dir), JSON.stringify({ landing: { halt_loop_at_emergency: true } }));

  writeState(dir, { ...stateAt('EMERGENCY'), session_id: 'a', manifest: { sealed_at: T - 5 } });
  const halted = hook('PostToolBatch', { session_id: 'a', cwd: dir }, T);
  assert.equal(halted.exit, 2);
  assert.match(halted.stderr!, /halted the loop/);

  // Unsealed: stopping now would lose the work the brake exists to protect.
  writeState(dir, { ...stateAt('EMERGENCY'), session_id: 'b', manifest: { sealed_at: null } });
  assert.equal(hook('PostToolBatch', { session_id: 'b', cwd: dir }, T).exit, 0);

  // Not yet at EMERGENCY.
  writeState(dir, { ...stateAt('LAND'), session_id: 'c', manifest: { sealed_at: T - 5 } });
  assert.equal(hook('PostToolBatch', { session_id: 'c', cwd: dir }, T).exit, 0);
});

// ------------------------------------------------------------------ 429 detection

test('isRateLimitError recognises the shapes a rate limit arrives in', () => {
  assert.ok(isRateLimitError('rate_limit_error', undefined));
  assert.ok(isRateLimitError(undefined, 'HTTP 429 Too Many Requests'));
  assert.ok(isRateLimitError('api_error', 'quota exceeded'));
  assert.ok(!isRateLimitError('overloaded_error', 'server is busy'));
  assert.ok(!isRateLimitError(undefined, undefined));
});

test('readTail returns the end of a large file', () => {
  const dir = tmp();
  const f = join(dir, 'big.jsonl');
  writeFileSync(f, `${'x'.repeat(500_000)}THE-END`);
  const tail = readTail(f, 1024);
  assert.ok(tail.endsWith('THE-END'));
  assert.ok(tail.length <= 1024);
  assert.equal(readTail(join(dir, 'nope'), 100), '');
});

test('the transcript tombstone yields the reset time and limit kind', () => {
  const dir = tmp();
  const f = join(dir, 't.jsonl');
  // The shape these records actually take, observed in a real transcript.
  writeFileSync(
    f,
    `${JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 2 } } })}\n` +
      `${JSON.stringify({
        quotaLimits: {
          status: 'rejected',
          resetsAt: 1788222600,
          rateLimitType: 'five_hour',
          overageStatus: 'rejected',
        },
        error: 'rate_limit',
        isApiErrorMessage: true,
        apiErrorStatus: 429,
      })}\n`,
  );
  const tomb = parseRateLimitTombstone(f)!;
  assert.equal(tomb.kind, 'five_hour');
  assert.equal(tomb.resets_at, 1788222600);
});

test('a transcript with no rejection yields nothing', () => {
  const dir = tmp();
  const f = join(dir, 't.jsonl');
  writeFileSync(f, `${JSON.stringify({ type: 'assistant' })}\n`);
  assert.equal(parseRateLimitTombstone(f), null);
  assert.equal(parseRateLimitTombstone(undefined), null);
  assert.equal(parseRateLimitTombstone(join(dir, 'missing.jsonl')), null);
});

test('an allowed quota record is not mistaken for a rejection', () => {
  const dir = tmp();
  const f = join(dir, 't.jsonl');
  writeFileSync(f, `${JSON.stringify({ quotaLimits: { status: 'allowed', resetsAt: 123 } })}\n`);
  assert.equal(parseRateLimitTombstone(f), null);
});

test('StopFailure on a 429 records the stop, seals, and switches to HARD_STOPPED', () => {
  const dir = tmp();
  const transcript = join(dir, 't.jsonl');
  writeFileSync(
    transcript,
    `${JSON.stringify({
      quotaLimits: { status: 'rejected', resetsAt: T + 5400, rateLimitType: 'five_hour' },
      error: 'rate_limit',
    })}\n`,
  );
  appendEvent(dir, 's1', { k: 'note', t: T - 10, field: 'next_action', text: 'Finish rotation' });
  writeState(dir, stateAt('LAND'));

  const r = hook(
    'StopFailure',
    {
      session_id: 's1',
      cwd: dir,
      transcript_path: transcript,
      error_type: 'rate_limit_error',
      error_message: '429',
    },
    T,
  );
  assert.equal(r.exit, 0, 'StopFailure output is discarded, so it must not try to block');

  const st = readState(dir, 's1');
  assert.equal(st.mode, 'HARD_STOPPED');
  assert.equal(st.hard_stop?.kind, 'five_hour');
  assert.equal(st.hard_stop?.resets_at, T + 5400);

  const m = readLatest(dir);
  assert.match(m!.seal_reason, /HARD_STOPPED \(five_hour rate limit\)/);
  assert.equal(m!.claude_supplied.next_action, 'Finish rotation');
  // Speed matters more than the ref on a failed turn.
  assert.equal(m!.observed.checkpoint, null);
});

test('StopFailure ignores errors that are not rate limits', () => {
  const dir = tmp();
  writeState(dir, stateAt('WATCH'));
  hook(
    'StopFailure',
    { session_id: 's1', cwd: dir, error_type: 'overloaded_error', error_message: 'busy' },
    T,
  );
  assert.equal(readState(dir, 's1').mode, 'WATCH');
  assert.equal(readLatest(dir), null);
});

test('StopFailure does not re-seal over an existing handoff', () => {
  const dir = tmp();
  writeState(dir, { ...stateAt('LAND'), manifest: { sealed_at: T - 100 } });
  seal(dir, 's1', stateAt('LAND'), 'earlier seal', T - 100, { git: false });
  hook(
    'StopFailure',
    { session_id: 's1', cwd: dir, error_type: 'rate_limit_error', error_message: '429' },
    T,
  );
  assert.equal(readLatest(dir)?.seal_reason, 'earlier seal');
  assert.equal(readState(dir, 's1').mode, 'HARD_STOPPED');
});

test('countdown reads sensibly on both sides of the reset', () => {
  assert.match(countdown(T + 1800, T), /30m until the window reopens/);
  assert.match(countdown(T - 10, T), /has reopened/);
  assert.equal(countdown(null, T), 'reset time unknown');
});

test('forceSealInstruction names one action and no others', () => {
  const s = forceSealInstruction(stateAt('EMERGENCY'));
  assert.match(s, /exactly this and nothing more/);
  assert.match(s, /Then stop\./);
  assert.doesNotMatch(s, /continue|carry on|keep going/i);
});
