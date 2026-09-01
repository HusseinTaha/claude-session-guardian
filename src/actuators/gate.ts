import type { GuardianConfig, GuardianState, Mode } from '../types.ts';
import { severity, fmtMin } from '../budget/mode.ts';
import { readAgents, liveCount, typeStats } from '../sensors/agents.ts';
import { appendEvent } from '../handoff/ledger.ts';
import { redact, clip } from '../handoff/redact.ts';
import { stateDir } from '../core/paths.ts';
import { join, relative } from 'node:path';

const SPAWN_TOOLS = new Set(['Task', 'Agent']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

export interface GateDecision {
  /** null means "no opinion": the normal permission flow continues untouched. */
  decision: 'deny' | null;
  reason?: string;
  updatedInput?: Record<string, unknown>;
  systemMessage?: string;
}

/** `*migrate*` style patterns, anchored so a pattern without wildcards must match wholly. */
export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/[*?]/g, (m) =>
    m === '*' ? '.*' : '.',
  );
  return new RegExp(`^${escaped}$`, 'i');
}

export function isSafeBoundaryCommand(command: string, patterns: string[]): boolean {
  const c = command.trim();
  return patterns.some((p) => globToRegExp(p).test(c));
}

function budgetPhrase(state: GuardianState): string {
  const axis = state.binding_axis;
  const st = axis ? state.axes[axis] : undefined;
  if (!st || st.time_to_wall_min === null || !Number.isFinite(st.time_to_wall_min)) {
    return `${state.mode} (${state.reason})`;
  }
  return `${state.mode}: about ${fmtMin(st.time_to_wall_min)} of ${axis} budget left`;
}

/** Note appended to a subagent's own prompt as it is spawned.
 *
 *  This is the honest answer to "pause and checkpoint the agent". A running subagent has no
 *  external handle — its state *is* its context, so there is nothing to freeze. What can be
 *  done is make it self-checkpointing at the moment it is born, so an agent cut off at
 *  minute four of an eighteen-minute task leaves usable work behind instead of nothing. */
export function checkpointNote(state: GuardianState, notesDir: string): string {
  return [
    '',
    '---',
    `Budget note from Session Guardian: this session is at ${budgetPhrase(state)}.`,
    'Work so that being cut off early still leaves something useful:',
    `- Write findings to \`${notesDir}\` as you go, rather than only at the end.`,
    '- Prefer returning a partial answer over returning nothing.',
    '- Do not start work you cannot bring to a reportable state quickly.',
  ].join('\n');
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'agent'
  );
}

/** The spawn gate. The only synchronous hook Guardian installs, and it fires rarely. */
export function gateSpawn(
  toolInput: Record<string, unknown> | undefined,
  state: GuardianState,
  cfg: GuardianConfig,
  projectDir: string,
  sessionId: string,
  now: number,
): GateDecision {
  const mode = state.mode;
  const denyFrom = cfg.agents.deny_spawn_from as Mode;
  const noteFrom = cfg.agents.inject_checkpoint_prompt_from as Mode;

  if (severity(mode) >= severity(denyFrom)) {
    const live = liveCount(readAgents(projectDir, sessionId), now);
    const reason =
      `Session Guardian is in ${mode} — ${state.reason}. ` +
      `New subagents are blocked because a delegated task cannot be checkpointed or ` +
      `resumed once the session stops.` +
      (live ? ` ${live} agent(s) already running; let them return.` : '') +
      ` Finish or seal the current work instead (\`/guardian handoff\`), or do the task ` +
      `inline where its partial results stay in this session. ` +
      `To override, raise agents.deny_spawn_from in .claude/guardian/config.json.`;
    return { decision: 'deny', reason };
  }

  if (severity(mode) >= severity(noteFrom) && toolInput) {
    const prompt = toolInput.prompt;
    if (typeof prompt !== 'string') return { decision: null };

    // Already annotated: a retried spawn must not accumulate notes.
    if (prompt.includes('Budget note from Session Guardian')) return { decision: null };

    const desc = typeof toolInput.description === 'string' ? toolInput.description : 'agent';
    const notesFile = join(stateDir(projectDir), 'agent-notes', `${slug(desc)}.md`);
    const rel = relative(projectDir, notesFile).replace(/\\/g, '/') || notesFile;

    return {
      decision: null,
      updatedInput: { ...toolInput, prompt: prompt + checkpointNote(state, rel) },
      systemMessage: `🛡 Guardian asked this agent to checkpoint as it goes (${mode}).`,
    };
  }

  return { decision: null };
}

/** Irreversible, long-running shell work — migrations, deploys, terraform.
 *
 *  Guardian deliberately does NOT block these near a wall. Refusing to start a migration
 *  is sometimes right and sometimes leaves a system half-configured, and Guardian cannot
 *  tell which. What it can do is record that one began, so that if the session dies before
 *  it returns, the handoff says so rather than leaving the next session to discover it. */
export function markBoundary(
  toolInput: Record<string, unknown> | undefined,
  cfg: GuardianConfig,
  projectDir: string,
  sessionId: string,
  now: number,
): GateDecision {
  const command = typeof toolInput?.command === 'string' ? toolInput.command : '';
  if (!command) return { decision: null };
  if (!isSafeBoundaryCommand(command, cfg.safe_boundary_commands)) return { decision: null };

  appendEvent(projectDir, sessionId, {
    k: 'boundary',
    t: now,
    command: clip(redact(command), 300),
  });
  return { decision: null };
}

export function agentEtaNote(projectDir: string, type: string): string | null {
  const s = typeStats(projectDir)[type];
  return s ? `agents of type ${type} usually take ≈${fmtMin(s.median_s / 60)} (n=${s.count})` : null;
}
