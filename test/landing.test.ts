import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  injectionFor,
  forceSealInstruction,
  parseRateLimitTombstone,
  isRateLimitError,
  readTail,
  countdown,
} from '../src/actuators/landing.ts';
import { handle } from '../src/actuators/dispatch.ts';
import { emptyState, readState, writeState } from '../src/core/state.ts';
import { readLatest, seal } from '../src/handoff/manifest.ts';
import { DEFAULT_CONFIG } from '../src/core/config.ts';
import { configPath, logPath } from '../src/core/paths.ts';
import { appendEvent } from '../src/handoff/ledger.ts';
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

  // Sealed AND carrying a next action: there is nothing left to ask for.
  appendEvent(dir, 'sealed', { k: 'note', t: T - 20, field: 'next_action', text: 'finish the branch' });
  writeState(dir, { ...stateAt('LAND'), session_id: 'sealed', manifest: { sealed_at: T - 10 } });
  seal(dir, 'sealed', stateAt('LAND'), 'manual', T - 10, { git: false });
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

// ------------------------------------------------------------------ the auto-seal

/** A completed Bash call: the async path Guardian seals from, and it leaves a ledger
 *  event behind, which is what makes the work "newer than the last seal". */
function toolCall(dir: string, sid: string, t: number, cmd = 'echo hi') {
  const payload = { session_id: sid, cwd: dir, tool_name: 'Bash', tool_input: { command: cmd } };
  return hook('PostToolUse', payload, t);
}

test('auto-seal fires once at LAND, without being asked and without a turn ending', () => {
  const dir = tmp();
  writeState(dir, stateAt('LAND'));

  const r = toolCall(dir, 's1', T);
  assert.match(r.out.systemMessage, /auto-sealed a handoff at LAND/);
  assert.match(r.out.systemMessage, /latest\.json/, 'the message must name the manifest');
  assert.match(readLatest(dir)!.seal_reason, /^auto-seal \(LAND\)$/);

  const st = readState(dir, 's1');
  assert.equal(st.latches.auto_sealed, true, 'the latch must be persisted');
  assert.equal(st.manifest.sealed_at, T, 'the state must agree with the manifest on disk');
});

test('auto-seal is single-shot while the mode holds', () => {
  const dir = tmp();
  writeState(dir, stateAt('EMERGENCY'));
  assert.ok(toolCall(dir, 's1', T).out.systemMessage);

  for (let i = 1; i <= 10; i++) {
    const again = toolCall(dir, 's1', T + i * 10);
    assert.equal(again.out, null, `auto-seal fired again on tool call ${i + 1}`);
  }
  assert.equal(readLatest(dir)!.sealed_at, T, 'only the first seal should exist');
});

test('auto-seal re-arms when the mode falls back, and seals again on a later climb', () => {
  const dir = tmp();
  writeState(dir, stateAt('LAND'));
  assert.ok(toolCall(dir, 's1', T).out.systemMessage);

  // Recovered: the window refilled faster than the session burned it.
  writeState(dir, { ...readState(dir, 's1'), mode: 'WATCH' });
  assert.equal(toolCall(dir, 's1', T + 100).out, null);
  const down = readState(dir, 's1');
  assert.equal(down.latches.auto_sealed, false, 'the latch must clear on the way down');

  writeState(dir, { ...readState(dir, 's1'), mode: 'LAND' });
  const second = toolCall(dir, 's1', T + 200);
  assert.ok(second.out?.systemMessage, 'a later climb must seal again');
  assert.equal(readLatest(dir)!.sealed_at, T + 200, 'the second seal must supersede the first');
});

// The load-bearing constraint: sealing runs git. On the synchronous gate that would sit in
// front of every tool call, and in the sensor it would blow a 2.4ms budget.
test('auto-seal never fires from a synchronous hook', () => {
  const dir = tmp();
  writeState(dir, stateAt('EMERGENCY'));

  const gate = hook(
    'PreToolUse',
    { session_id: 's1', cwd: dir, tool_name: 'Bash', tool_input: { command: 'echo hi' } },
    T,
  );
  assert.equal(gate.exit, 0);
  assert.equal(readLatest(dir), null, 'PreToolUse must not seal');
  assert.equal(readState(dir, 's1').latches.auto_sealed, undefined);
});

test('auto-seal stays quiet below the configured mode', () => {
  const dir = tmp();
  for (const m of ['NORMAL', 'WATCH', 'PREPARE'] as Mode[]) {
    writeState(dir, { ...stateAt(m), session_id: `sess-${m}` });
    assert.equal(toolCall(dir, `sess-${m}`, T).out, null, m);
    assert.equal(readLatest(dir), null, m);
  }
});

test('auto-seal counts a handoff sealed by hand, until there is newer work to seal', () => {
  const dir = tmp();
  seal(dir, 's1', stateAt('LAND'), 'manual', T - 10, { git: false });
  writeState(dir, { ...stateAt('LAND'), manifest: { sealed_at: T - 10 } });

  // A tool call that records nothing: no work has happened since the manual seal.
  assert.equal(hook('PostToolUse', { session_id: 's1', cwd: dir, tool_name: 'Read' }, T).out, null);
  assert.equal(readLatest(dir)!.seal_reason, 'manual');
  assert.equal(readState(dir, 's1').latches.auto_sealed, undefined, 'still armed, not latched');

  // Work after the seal is exactly what the automatic one is for.
  assert.ok(toolCall(dir, 's1', T + 5).out?.systemMessage);
  assert.match(readLatest(dir)!.seal_reason, /^auto-seal/);
});

test('the mode auto-seal fires at is configurable, and HARD_STOPPED switches it off', () => {
  const dir = tmp();
  writeFileSync(configPath(dir), JSON.stringify({ landing: { auto_seal_from: 'EMERGENCY' } }));

  writeState(dir, { ...stateAt('LAND'), session_id: 'a' });
  assert.equal(toolCall(dir, 'a', T).out, null, 'LAND is below the configured mode');

  writeState(dir, { ...stateAt('EMERGENCY'), session_id: 'b' });
  assert.ok(toolCall(dir, 'b', T + 10).out?.systemMessage);

  writeFileSync(configPath(dir), JSON.stringify({ landing: { auto_seal_from: 'HARD_STOPPED' } }));
  writeState(dir, { ...stateAt('EMERGENCY'), session_id: 'c' });
  assert.equal(toolCall(dir, 'c', T + 20).out, null, 'HARD_STOPPED is the off switch');
});

test('a failed auto-seal is not retried on every tool call after it', () => {
  const dir = tmp();
  writeState(dir, stateAt('LAND'));
  // A directory where the manifest should go: every write path through seal() throws.
  mkdirSync(join(dir, '.claude', 'guardian', 'handoff', 'latest.json'), { recursive: true });

  for (let i = 0; i < 3; i++) {
    const r = toolCall(dir, 's1', T + i * 10);
    assert.equal(r.exit, 0, 'a broken seal must still fail open');
    assert.equal(r.out, null);
  }
  const st = readState(dir, 's1');
  // The latch is written before the seal, precisely so a broken seal cannot storm.
  assert.equal(st.latches.auto_sealed, true, 'the latch must be set even when the seal fails');
});

// A sealed manifest used to disarm this brake, and auto-seal produces one on the way into
// LAND -- so the refusal stopped firing exactly when it mattered, and with it the only
// prompt that ever asks for the one thing Guardian cannot observe.
test('Stop still refuses when a manifest is sealed but carries no next action', () => {
  const dir = tmp();
  writeState(dir, { ...stateAt('LAND'), manifest: { sealed_at: T - 10 } });
  seal(dir, 's1', stateAt('LAND'), 'auto-seal (LAND)', T - 10, { git: false });

  const r = hook('Stop', { session_id: 's1', cwd: dir }, T);
  assert.equal(r.exit, 2, 'an automatic seal cannot have the intent; it precedes it');
  assert.match(r.stderr!, /note --next/);
});

test("Stop ignores a previous session's next action", () => {
  const dir = tmp();
  appendEvent(dir, 'older', { k: 'note', t: T - 200, field: 'next_action', text: 'last session' });
  seal(dir, 'older', stateAt('LAND'), 'manual', T - 100, { git: false });
  writeState(dir, stateAt('LAND'));
  assert.equal(hook('Stop', { session_id: 's1', cwd: dir }, T).exit, 2);
});

// ------------------------------------------------------------------ tool output

test('a command verdict is read from tool_response, which is the field that arrives', () => {
  const dir = tmp();
  const payload = {
    session_id: 's1',
    cwd: dir,
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
    tool_response: { stdout: 'pass 213, fail 0', interrupted: false },
  };
  hook('PostToolUse', payload, T);
  const m = seal(dir, 's1', stateAt('NORMAL'), 'manual', T + 1, { git: false });
  assert.equal(m.observed.tests?.ok, true, '154 of 154 commands recorded ok:null before this');
  assert.equal(m.observed.tests?.command, 'npm test');
});

test('a missing tool output is recorded as unclear and leaves a mark in the log', () => {
  const dir = tmp();
  hook('PostToolUse', { session_id: 's1', cwd: dir, tool_name: 'Bash', tool_input: { command: 'npm test' } }, T);
  const m = seal(dir, 's1', stateAt('NORMAL'), 'manual', T + 1, { git: false });
  assert.equal(m.observed.tests?.ok, null, 'an invented verdict is worse than an absent one');
  const log = readFileSync(join(dir, '.claude', 'guardian', 'logs', 'guardian.log'), 'utf8');
  assert.match(log, /carried no tool output; keys: /);
});

// ------------------------------------------------------------------ stale intent

/** The failure this covers, in full: a nine-hour session records its next action early,
 *  keeps working, climbs to EMERGENCY, auto-seals — and hands over a note from the previous
 *  day as if it were the plan. Every surface that reads a next action has to be able to say
 *  "that one is spent". */
function seedStaleIntent(dir: string, sid = 's1'): void {
  appendEvent(dir, sid, {
    k: 'note',
    t: T - 86_400,
    field: 'next_action',
    text: 'ONLY LANE K REMAINS — HEAD decdc74c0',
  });
  appendEvent(dir, sid, { k: 'commit', t: T - 3600, sha: 'aa11bb22', subject: 'lane L' });
  appendEvent(dir, sid, { k: 'commit', t: T - 1800, sha: 'cc33dd44', subject: 'lane M' });
}

test('Stop refuses again when the recorded next action predates the work', () => {
  const dir = tmp();
  seedStaleIntent(dir);
  writeState(dir, { ...stateAt('LAND'), manifest: { sealed_at: T - 10 } });
  seal(dir, 's1', stateAt('LAND'), 'auto-seal (LAND)', T - 10, { git: false });
  assert.ok(readLatest(dir)!.claude_supplied.next_action, 'a note is on file');

  const r = hook('Stop', { session_id: 's1', cwd: dir }, T);
  assert.equal(r.exit, 2, 'a note written before two commits is not this turn’s intent');
  assert.match(r.stderr!, /24\.0 hours old/);
  assert.match(r.stderr!, /2 commits were recorded after it/);
  assert.match(r.stderr!, /replace the/);
});

test('Stop stays out of the way once the next action is current', () => {
  const dir = tmp();
  appendEvent(dir, 's1', { k: 'commit', t: T - 3600, sha: 'aa11bb22', subject: 'lane L' });
  appendEvent(dir, 's1', { k: 'note', t: T - 20, field: 'next_action', text: 'Run npm run check' });
  writeState(dir, { ...stateAt('LAND'), manifest: { sealed_at: T - 10 } });
  seal(dir, 's1', stateAt('LAND'), 'manual', T - 10, { git: false });
  assert.equal(hook('Stop', { session_id: 's1', cwd: dir }, T).exit, 0);
});

test('the landing brief says whether the intent on file is spent', () => {
  const dir = tmp();
  seedStaleIntent(dir);
  writeState(dir, stateAt('EMERGENCY'));
  const ctx = hook('UserPromptSubmit', { session_id: 's1', cwd: dir }, T).out.additionalContext;
  assert.match(ctx, /Guardian: EMERGENCY/);
  assert.match(ctx, /a next action IS recorded, written 24\.0 hours ago/);
  assert.match(ctx, /2 commits have been recorded since/);
  assert.match(ctx, /It is stale/);
});

test('the landing brief says when nothing has been recorded at all', () => {
  const dir = tmp();
  writeState(dir, stateAt('LAND'));
  const ctx = hook('UserPromptSubmit', { session_id: 's1', cwd: dir }, T).out.additionalContext;
  assert.match(ctx, /no next action recorded for this session yet/);
});

test('a calm session gets no word about its intent either way', () => {
  const dir = tmp();
  writeState(dir, stateAt('PREPARE'));
  const ctx = hook('UserPromptSubmit', { session_id: 's1', cwd: dir }, T).out.additionalContext;
  assert.doesNotMatch(ctx, /next action/);
});

test('the auto-seal message asks for a fresh next action when the one on file is spent', () => {
  const dir = tmp();
  seedStaleIntent(dir);
  writeState(dir, stateAt('LAND'));
  const msg = toolCall(dir, 's1', T).out.systemMessage;
  assert.match(msg, /recorded next action is 24\.0 hours old/);
  assert.match(msg, /Replace it now/);
});

test('a session that observed nothing seals no handoff on the way out', () => {
  const dir = tmp();
  writeState(dir, { ...stateAt('NORMAL'), samples: [{ t: T - 60, context: 4 }] });
  assert.equal(hook('SessionEnd', { session_id: 's1', cwd: dir, reason: 'other' }, T).exit, 0);
  assert.equal(readLatest(dir), null, 'nothing observed is nothing to hand over');
  assert.match(readFileSync(logPath(dir), 'utf8'), /nothing observed/);
});

// ------------------------------------------------------------------ agents already running

test('an agent already running is asked to write its own handoff, once', () => {
  const dir = tmp();
  writeState(dir, stateAt('LAND'));
  const payload = {
    session_id: 's1',
    cwd: dir,
    tool_name: 'Read',
    tool_input: { file_path: join(dir, 'x.ts') },
    agent_id: 'ag7',
    agent_type: 'general-purpose',
  };

  const first = hook('PostToolUse', payload, T);
  const ctx = first.out.hookSpecificOutput.additionalContext as string;
  // The spawn gate cannot reach this one: it was born before the session climbed.
  assert.match(ctx, /You are a subagent/);
  assert.match(ctx, /agent-notes\/general-purpose\.md/);
  assert.equal(first.exit, 0, 'a nudge must never look like a refusal');

  // Once per agent. Every tool call it makes must not re-ask.
  const second = hook('PostToolUse', payload, T + 5);
  assert.equal(second.out?.hookSpecificOutput, undefined);
  assert.deepEqual(readState(dir, 's1').latches.agents_asked, ['ag7']);
});

test('a main-thread tool call is not mistaken for an agent, and says so in the log', () => {
  const dir = tmp();
  writeState(dir, stateAt('LAND'));
  const r = hook('PostToolUse', { session_id: 's1', cwd: dir, tool_name: 'Read', tool_input: {} }, T);
  assert.equal(r.out?.hookSpecificOutput, undefined);
  // The field may simply not arrive on this build of Claude Code. That is a fact to record,
  // not to assume either way: 154 nulls once passed for a working feature here.
  assert.match(readFileSync(logPath(dir), 'utf8'), /no agent identity on a PostToolUse at LAND; keys:/);
});

test('a calm session leaves running agents alone', () => {
  const dir = tmp();
  writeState(dir, stateAt('WATCH'));
  const r = hook(
    'PostToolUse',
    { session_id: 's1', cwd: dir, tool_name: 'Read', tool_input: {}, agent_id: 'ag7' },
    T,
  );
  assert.equal(r.out, null);
});
