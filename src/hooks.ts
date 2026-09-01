import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolveStateRoot } from './paths.ts';
import { loadConfig } from './config.ts';
import { readState, writeState } from './state.ts';
import { appendEvent, fileEvent, commandEvent, classifyCommand } from './ledger.ts';
import { seal, hasUnconsumed, latestDigestPath, readLatest } from './manifest.ts';
import { log } from './log.ts';

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
    return NOTHING;
  }

  if (tool === 'Bash' || tool === 'PowerShell') {
    const cmd = typeof inp.tool_input?.command === 'string' ? inp.tool_input.command : '';
    if (!cmd) return NOTHING;
    appendEvent(projectDir, sid, commandEvent(cmd, inp.tool_output ?? '', now));

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

/** The one place Guardian can put text into a fresh session's context. Offers the handoff
 *  rather than applying it: silently resuming days-old work would be worse than the
 *  problem it solves. */
function onUserPromptSubmit(projectDir: string, sid: string, now: number): HookResult {
  const state = readState(projectDir, sid);
  if (state.latches.resume_offered) return NOTHING;

  const m = hasUnconsumed(projectDir);
  writeState(projectDir, {
    ...state,
    session_id: sid,
    latches: { ...state.latches, resume_offered: true },
  });
  if (!m || m.session.id === sid) return NOTHING;

  const ageMin = (now - m.sealed_at) / 60;
  const age =
    ageMin < 60
      ? `${Math.round(ageMin)} minutes ago`
      : ageMin < 60 * 48
        ? `${(ageMin / 60).toFixed(1)} hours ago`
        : `${Math.round(ageMin / 60 / 24)} days ago`;
  const next = m.claude_supplied.next_action;

  return ok({
    additionalContext:
      `[Guardian] An unfinished handoff from a previous session in this project was sealed ` +
      `${age}: "${m.seal_reason}".` +
      (m.objective ? ` Objective: ${m.objective}.` : '') +
      (next ? ` Next action recorded: ${next}` : '') +
      `\nIf the user's request relates to that work, run \`/guardian resume\` to load the ` +
      `full digest and verify the workspace before editing. If it is unrelated, ignore this ` +
      `and do not mention it.`,
  });
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

      default:
        return NOTHING;
    }
  } catch (err) {
    log(projectDir, 'error', `hook ${event} failed: ${(err as Error)?.stack ?? String(err)}`);
    // Fail open. Exit 0 with no output: the session continues as if Guardian were absent.
    return NOTHING;
  }
}
