import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolveStateRoot } from '../core/paths.ts';
import { loadConfig } from '../core/config.ts';
import { readState, writeState } from '../core/state.ts';
import {
  appendEvent,
  fileEvent,
  commandEvent,
  classifyCommand,
  readLedger,
} from '../handoff/ledger.ts';
import {
  seal,
  hasUnconsumed,
  latestDigestPath,
  latestPath,
  readLatest,
} from '../handoff/manifest.ts';
import { gateSpawn, markBoundary } from './gate.ts';
import { readAgents, writeAgents, recordDuration } from '../sensors/agents.ts';
import {
  injectionFor,
  forceSealInstruction,
  parseRateLimitTombstone,
  isRateLimitError,
} from './landing.ts';
import { severity } from '../budget/mode.ts';
import { log } from '../core/log.ts';

/** Fields Guardian reads from a hook payload. Every hook receives the common set
 *  (session_id, transcript_path, cwd, permission_mode, hook_event_name) plus its own. */
export interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  // Tool events
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  /** PostToolUse carries the tool's result here. `tool_output` is accepted too, but it is
   *  not what Claude Code sends: reading only that field meant every command Guardian ever
   *  recorded on a real machine had `ok: null`. */
  tool_response?: unknown;
  tool_output?: string;
  tool_use_id?: string;
  // Session / compaction events
  reason?: string;
  messages_compacted?: number;
  // Agent events
  agent_id?: string;
  agent_type?: string;
  last_assistant_message?: string;
  // Task events
  task_id?: string;
  task_title?: string;
  // Prompt events
  prompt?: string;
  source?: string;
  // Stop / StopFailure
  last_assistant_message_stop?: string;
  stop_reason?: string;
  error_type?: string;
  error_message?: string;
  // PostToolBatch
  tool_calls?: unknown[];
}

/** Only the output fields Guardian actually uses. Which of these a given event honours
 *  differs — notably `SessionStart` accepts `systemMessage` but NOT `additionalContext`,
 *  so resume injection has to ride `UserPromptSubmit` instead. */
export interface HookOutput {
  additionalContext?: string;
  systemMessage?: string;
  hookSpecificOutput?: Record<string, unknown>;
}

export interface HookResult {
  stdout: string;
  exit: number;
  /** Shown to Claude when exit is 2. */
  stderr?: string;
}

const NOTHING: HookResult = { stdout: '', exit: 0 };

function ok(out: HookOutput): HookResult {
  return { stdout: JSON.stringify(out), exit: 0 };
}

function git(cwd: string, args: string[]): string | null {
  try {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 5000, windowsHide: true });
    return r.status === 0 ? (r.stdout ?? '').trim() : null;
  } catch {
    return null;
  }
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

/** A tool's output, whichever field carried it. An object is stringified rather than
 *  dropped: the pass/fail words a test run leaves behind are in there either way. */
function toolOutput(inp: HookInput): string {
  const r = inp.tool_response ?? inp.tool_output;
  if (typeof r === 'string') return r;
  if (r === undefined || r === null) return '';
  try {
    return JSON.stringify(r);
  } catch {
    return '';
  }
}

function editedPath(input: Record<string, unknown> | undefined): string | null {
  if (!input) return null;
  for (const key of ['file_path', 'notebook_path', 'path']) {
    const v = input[key];
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

/** Observe a completed tool call. Runs as an async hook, so it may take a moment and can
 *  shell out to git without holding anything up. */
function onPostToolUse(inp: HookInput, projectDir: string, sid: string, now: number): HookResult {
  const tool = inp.tool_name ?? '';

  if (EDIT_TOOLS.has(tool)) {
    const p = editedPath(inp.tool_input);
    if (p) appendEvent(projectDir, sid, fileEvent(p, tool, now));
    return autoSeal(projectDir, sid, now);
  }

  const cmd =
    tool === 'Bash' || tool === 'PowerShell'
      ? typeof inp.tool_input?.command === 'string'
        ? inp.tool_input.command
        : ''
      : '';

  if (cmd) {
    const output = toolOutput(inp);
    if (!output) {
      // Without output there is no verdict, and a manifest that says "result unclear" for
      // every command is how this went unnoticed for a whole release. Name the keys that
      // did arrive, so the next payload change is caught by evidence, not inference.
      log(projectDir, 'warn', `PostToolUse carried no tool output; keys: ${Object.keys(inp).join(',')}`);
    }
    appendEvent(projectDir, sid, commandEvent(cmd, output, now));

    // A commit is worth recording as a durable landmark, but the command text is not the
    // commit: `git commit -m x` may have failed, been amended, or been a --dry-run. Ask
    // git what HEAD actually is.
    if (classifyCommand(cmd) === 'git' && /\bcommit\b/.test(cmd) && !/--dry-run/.test(cmd)) {
      const sha = git(projectDir, ['rev-parse', 'HEAD']);
      const subject = git(projectDir, ['log', '-1', '--format=%s']);
      if (sha) {
        const seen = readLatest(projectDir)?.observed.commits.some((c) => c.sha === sha);
        if (!seen) {
          appendEvent(projectDir, sid, { k: 'commit', t: now, sha, subject: subject ?? '' });
        }
      }
    }
  }
  return autoSeal(projectDir, sid, now);
}

/** Seal without being asked, once the session is close enough to a wall.
 *
 *  `force_seal_turn` asks the model to seal and waits for a turn to end; both of those can
 *  fail — a turn that never ends, or a model that reads the instruction and keeps working —
 *  and what is lost when they do is the whole session. This path needs neither. It fires
 *  from an async hook by necessity: a seal runs git, which belongs nowhere near the
 *  synchronous gate or the sensor's 2.4ms budget.
 *
 *  The latch is written BEFORE the seal, for the same reason the Stop latch is: a seal that
 *  throws must not be retried on every subsequent tool call. It clears when the mode falls
 *  back below the threshold, so a session that climbs, recovers and climbs again seals
 *  twice — the second time with the work the first seal could not have seen. */
function autoSeal(projectDir: string, sid: string, now: number): HookResult {
  const cfg = loadConfig(projectDir);
  const state = readState(projectDir, sid);
  const armed = severity(state.mode) >= severity(cfg.landing.auto_seal_from);

  if (!armed) {
    // Re-arm on the way down, and only then: a write on every calm tool call would be a
    // needless one on the commonest path of all.
    if (state.latches.auto_sealed) {
      writeState(projectDir, { ...state, latches: { ...state.latches, auto_sealed: false } });
    }
    return NOTHING;
  }
  if (state.latches.auto_sealed) return NOTHING;

  // A handoff sealed by hand counts. Guardian tells the model to seal at LAND, so the
  // common case is that it already has — and re-sealing seconds later would announce a
  // handoff the model just made. Only work recorded AFTER that seal earns another one;
  // until then this stays armed rather than latched, so the next edit is still covered.
  const sealedAt = state.manifest.sealed_at;
  if (sealedAt !== null && !readLedger(projectDir, sid).some((e) => e.t > sealedAt)) {
    return NOTHING;
  }

  const latched: typeof state = {
    ...state,
    latches: { ...state.latches, auto_sealed: true },
  };
  writeState(projectDir, latched);

  const m = seal(projectDir, sid, latched, `auto-seal (${state.mode})`, now);
  writeState(projectDir, { ...latched, manifest: { sealed_at: m.sealed_at } });

  const n = m.observed.files_touched.length;
  const flying = m.agents.filter((a) => a.status === 'IN_FLIGHT_AT_SEAL').length;
  log(
    projectDir,
    'info',
    `auto-sealed at ${state.mode} (${state.reason}): ${n} file(s), ` +
      `${m.observed.commits.length} commit(s), ${flying} agent(s) in flight`,
  );
  return ok({
    systemMessage:
      `🛡 Guardian auto-sealed a handoff at ${state.mode} — ${n} file${n === 1 ? '' : 's'} ` +
      `tracked, manifest at ${latestPath(projectDir)}.` +
      (flying
        ? ` ${flying} agent(s) were still running; the seal records them but does not pause them.`
        : '') +
      (m.claude_supplied.next_action
        ? ''
        : ' No next action is recorded yet — add one with `guardian note --next "..."`.'),
  });
}

const SPAWN_TOOLS = new Set(['Task', 'Agent']);

/** The gate. Denies a spawn outright near a wall, and annotates one just before that.
 *  Synchronous by necessity — a decision after the fact is not a decision. */
function onPreToolUse(inp: HookInput, projectDir: string, sid: string, now: number): HookResult {
  const tool = inp.tool_name ?? '';
  const cfg = loadConfig(projectDir);
  const state = readState(projectDir, sid);

  const g = SPAWN_TOOLS.has(tool)
    ? gateSpawn(inp.tool_input, state, cfg, projectDir, sid, now)
    : tool === 'Bash' || tool === 'PowerShell'
      ? markBoundary(inp.tool_input, cfg, projectDir, sid, now)
      : { decision: null as null };

  if (g.decision === 'deny') {
    return ok({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: g.reason,
      },
    });
  }
  if (g.updatedInput) {
    return ok({
      hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: g.updatedInput },
      ...(g.systemMessage ? { systemMessage: g.systemMessage } : {}),
    });
  }
  return NOTHING;
}

/** Compaction is the wall Guardian meets most often, and the cheapest to make survivable:
 *  seal on the way in, hand the digest back on the way out. */
function onPreCompact(inp: HookInput, projectDir: string, sid: string, now: number): HookResult {
  const state = readState(projectDir, sid);
  const m = seal(projectDir, sid, state, `PreCompact (${inp.reason ?? 'auto'})`, now);
  writeState(projectDir, { ...state, manifest: { sealed_at: now } });
  const n = m.observed.files_touched.length;
  return ok({
    systemMessage: `🛡 Guardian sealed a handoff before compaction (${n} file${n === 1 ? '' : 's'} tracked).`,
  });
}

function onPostCompact(projectDir: string, now: number): HookResult {
  const digest = readDigest(projectDir);
  if (!digest) return NOTHING;
  return ok({
    additionalContext:
      'Context was just compacted. The following handoff was sealed immediately beforehand ' +
      'and is authoritative for what has already been done — do not redo work listed as ' +
      `completed.\n\n${digest}`,
    systemMessage: '🛡 Guardian restored the pre-compaction handoff digest.',
  });
}

function readDigest(projectDir: string): string | null {
  try {
    return readFileSync(latestDigestPath(projectDir), 'utf8');
  } catch {
    return null;
  }
}

/** SessionEnd shares a 1.5s budget with every other SessionEnd hook, so this path skips
 *  the git checkpoint: a truncated seal is worth more than a timed-out one. */
function onSessionEnd(inp: HookInput, projectDir: string, sid: string, now: number): HookResult {
  const state = readState(projectDir, sid);
  if (state.updated_at === 0 && state.samples.length === 0) return NOTHING;
  seal(projectDir, sid, state, `SessionEnd (${inp.reason ?? 'other'})`, now, { git: false });
  return NOTHING;
}

/** The one place Guardian can put text into a fresh session's context.
 *
 *  Two jobs: offer a previous session's handoff (once), and inject the mode-appropriate
 *  brief (every prompt, while the mode warrants it). `SessionStart` cannot do the first —
 *  it accepts `systemMessage` but not `additionalContext` — which is why both ride here. */
function onUserPromptSubmit(projectDir: string, sid: string, now: number): HookResult {
  const cfg = loadConfig(projectDir);
  const state = readState(projectDir, sid);
  const parts: string[] = [];

  if (!state.latches.resume_offered) {
    const m = hasUnconsumed(projectDir);
    writeState(projectDir, {
      ...state,
      session_id: sid,
      latches: { ...state.latches, resume_offered: true },
    });
    if (m && m.session.id !== sid) parts.push(resumeOffer(m, now));
  }

  const brief = injectionFor(state, cfg);
  if (brief) parts.push(brief);

  return parts.length ? ok({ additionalContext: parts.join('\n\n') }) : NOTHING;
}

function resumeOffer(m: NonNullable<ReturnType<typeof hasUnconsumed>>, now: number): string {
  const ageMin = (now - m.sealed_at) / 60;
  const age =
    ageMin < 60
      ? `${Math.round(ageMin)} minutes ago`
      : ageMin < 60 * 48
        ? `${(ageMin / 60).toFixed(1)} hours ago`
        : `${Math.round(ageMin / 60 / 24)} days ago`;
  const next = m.claude_supplied.next_action;
  return (
    `[Guardian] An unfinished handoff from a previous session in this project was sealed ` +
    `${age}: "${m.seal_reason}".` +
    (m.objective ? ` Objective: ${m.objective}.` : '') +
    (next ? ` Next action recorded: ${next}` : '') +
    `\nIf the user's request relates to that work, run \`/guardian resume\` to load the ` +
    `full digest and verify the workspace before editing. If it is unrelated, ignore this ` +
    `and do not mention it.`
  );
}

/** Refuse one turn-end so the session seals before it goes quiet.
 *
 *  A `Stop` hook that can fire twice is a loop, and a loop here would be far worse than no
 *  hook at all — so the latch is written to state BEFORE the refusal is returned, and the
 *  refusal is returned at most once per session whatever happens next. */
function onStop(projectDir: string, sid: string, now: number): HookResult {
  const cfg = loadConfig(projectDir);
  if (!cfg.landing.force_seal_turn) return NOTHING;

  const state = readState(projectDir, sid);
  if (state.latches.stop_forced) return NOTHING;
  if (severity(state.mode) < severity('LAND')) return NOTHING;

  // A sealed manifest is no longer the test. Auto-seal sets one on the way into LAND, and
  // it cannot carry intent — intent is written after it, by the model, in response to this
  // very refusal. So refuse while the one thing Guardian cannot observe is still missing,
  // and only for a manifest belonging to this session: a previous session's next action
  // says nothing about this one.
  const sealed = readLatest(projectDir);
  if (sealed && sealed.session.id === sid && sealed.claude_supplied.next_action) return NOTHING;

  writeState(projectDir, { ...state, latches: { ...state.latches, stop_forced: true } });
  // Exit 2 prevents the stop and shows stderr to Claude.
  return { stdout: '', exit: 2, stderr: forceSealInstruction(state) };
}

/** Optional hard brake. Off by default. */
function onPostToolBatch(projectDir: string, sid: string): HookResult {
  const cfg = loadConfig(projectDir);
  if (!cfg.landing.halt_loop_at_emergency) return NOTHING;
  const state = readState(projectDir, sid);
  if (state.mode !== 'EMERGENCY' || state.manifest.sealed_at === null) return NOTHING;
  return {
    stdout: '',
    exit: 2,
    stderr:
      'Session Guardian halted the loop: the handoff is sealed and the budget is spent. ' +
      'Resume in a new session with `/guardian resume`.',
  };
}

/** A turn that ended in an API error. When that error is a rate limit, this is the moment
 *  Guardian learns the window has actually closed — and the transcript records when it
 *  reopens, which no live gauge can tell us after the fact. */
function onStopFailure(inp: HookInput, projectDir: string, sid: string, now: number): HookResult {
  if (!isRateLimitError(inp.error_type, inp.error_message)) return NOTHING;

  const tomb = parseRateLimitTombstone(inp.transcript_path);
  const state = readState(projectDir, sid);
  const kind = tomb?.kind ?? 'unknown';
  const resets = tomb?.resets_at ?? state.axes.five_hour?.resets_at ?? null;

  const next: typeof state = {
    ...state,
    mode: 'HARD_STOPPED',
    reason: `${kind} rate limit refused a request`,
    hard_stop: { at: now, kind, resets_at: resets },
  };
  writeState(projectDir, next);

  if (state.manifest.sealed_at === null) {
    // No git checkpoint: this fires on a failed turn and speed matters more than the ref.
    seal(projectDir, sid, next, `HARD_STOPPED (${kind} rate limit)`, now, { git: false });
    writeState(projectDir, { ...next, manifest: { sealed_at: now } });
  }
  return NOTHING;
}

/** Feed the historical-duration table, which is the only defensible basis Guardian has for
 *  saying how long an agent of a given type is likely to take. Also drops the finished
 *  agent's snapshot so the live count stays honest. */
function recordAgentDuration(inp: HookInput, projectDir: string, sid: string, now: number): void {
  const id = inp.agent_id;
  const type = inp.agent_type;
  if (!id) return;
  const f = readAgents(projectDir, sid);
  const snap = f.agents[id];
  if (snap?.started_at && type) recordDuration(projectDir, type, now - snap.started_at);
  if (snap) {
    delete f.agents[id];
    writeAgents(projectDir, { ...f, updated_at: now });
  }
}

export function handle(event: string, raw: string, now = Date.now() / 1000): HookResult {
  let inp: HookInput = {};
  try {
    inp = JSON.parse(raw) as HookInput;
  } catch {
    return NOTHING;
  }

  const projectDir = resolveStateRoot(inp.cwd || process.cwd());
  const sid = inp.session_id || 'unknown';

  try {
    if (!loadConfig(projectDir).enabled) return NOTHING;

    switch (event) {
      case 'PreToolUse':
        return onPreToolUse(inp, projectDir, sid, now);

      case 'PostToolUse':
        return onPostToolUse(inp, projectDir, sid, now);

      case 'TaskCreated':
      case 'TaskCompleted':
        if (inp.task_id) {
          appendEvent(projectDir, sid, {
            k: 'task',
            t: now,
            id: inp.task_id,
            title: inp.task_title ?? inp.task_id,
            status: event === 'TaskCompleted' ? 'completed' : 'created',
          });
        }
        return NOTHING;

      case 'SubagentStart':
      case 'SubagentStop':
        if (inp.agent_id) {
          if (event === 'SubagentStop') recordAgentDuration(inp, projectDir, sid, now);
          appendEvent(projectDir, sid, {
            k: 'agent',
            t: now,
            id: inp.agent_id,
            type: inp.agent_type ?? 'unknown',
            status: event === 'SubagentStart' ? 'start' : 'stop',
            ...(inp.last_assistant_message
              ? { summary: inp.last_assistant_message.slice(0, 300) }
              : {}),
          });
        }
        return NOTHING;

      case 'PreCompact':
        return onPreCompact(inp, projectDir, sid, now);

      case 'PostCompact':
        return onPostCompact(projectDir, now);

      case 'SessionEnd':
        return onSessionEnd(inp, projectDir, sid, now);

      case 'UserPromptSubmit':
        return onUserPromptSubmit(projectDir, sid, now);

      case 'Stop':
        return onStop(projectDir, sid, now);

      case 'PostToolBatch':
        return onPostToolBatch(projectDir, sid);

      case 'StopFailure':
        return onStopFailure(inp, projectDir, sid, now);

      default:
        return NOTHING;
    }
  } catch (err) {
    log(projectDir, 'error', `hook ${event} failed: ${(err as Error)?.stack ?? String(err)}`);
    // Fail open. Exit 0 with no output: the session continues as if Guardian were absent.
    return NOTHING;
  }
}
