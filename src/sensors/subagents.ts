import {
  readAgents,
  writeAgents,
  updateAgents,
  typeStats,
  contextWallMin,
  type AgentSnapshot,
  type TaskRow,
  type TypeStats,
} from './agents.ts';
import { resolveStateRoot } from '../core/paths.ts';
import { loadConfig } from '../core/config.ts';
import { log } from '../core/log.ts';
import { fmtMin, fmtElapsed } from '../budget/mode.ts';

interface SubagentPayload {
  session_id?: string;
  cwd?: string;
  columns?: number;
  tasks?: TaskRow[];
}

/** One row body per visible subagent.
 *
 *  Replaces the default `name · description · token count` with the two things that
 *  actually inform a decision near a wall: how full the agent's own context is, and how
 *  long agents of its type usually take. */
export function renderAgentRow(
  a: AgentSnapshot,
  stats: Record<string, TypeStats>,
  now: number,
  columns: number,
): string {
  const parts: string[] = [];
  parts.push(a.name ?? a.type ?? a.id.slice(0, 8));

  if (a.context_window && a.token_count !== null) {
    parts.push(`ctx ${((a.token_count / a.context_window) * 100).toFixed(0)}%`);
  } else if (a.token_count !== null) {
    parts.push(`${(a.token_count / 1000).toFixed(1)}k tok`);
  }

  if (a.started_at) {
    const elapsed = (now - a.started_at) / 60;
    const typical = a.type ? stats[a.type] : undefined;
    // "≈" and the sample count keep this honest: it is a median of past runs, not a
    // prediction about this one.
    parts.push(
      typical
        ? `${fmtElapsed(elapsed)} of ≈${fmtMin(typical.median_s / 60)} (n=${typical.count})`
        : `${fmtElapsed(elapsed)} elapsed`,
    );
  }

  const wall = contextWallMin(a);
  if (wall !== null && wall <= 5) parts.push(`⚠ ctx full ~${fmtMin(wall)}`);

  // What it is doing, second — two agents of the same type are otherwise indistinguishable,
  // and "which one do I let finish" is a question about the work, not the meter.
  //
  // The description is also the only part that can be arbitrarily long, so it absorbs the
  // truncation alone. Trimming the whole line instead would cut from the right, taking the
  // context warning and the elapsed clock — the fields a decision near a wall is made on —
  // to keep the beginning of a sentence.
  const meters = parts.slice(1);
  const head = parts[0]!;
  if (!a.description) return clip(parts.join(' · '), columns);

  const fixed = [head, ...meters].join(' · ').length + ' · '.length;
  const room = columns > 10 ? columns - fixed : a.description.length;
  const desc = room >= 12 ? clip(a.description, room) : null;
  return clip([head, ...(desc ? [desc] : []), ...meters].join(' · '), columns);
}

function clip(s: string, columns: number): string {
  return columns > 10 && s.length > columns ? `${s.slice(0, columns - 1)}…` : s;
}

/** Entry point for the `subagentStatusLine` command. Emits one JSON line per row it
 *  overrides. Must never throw: a broken row body would take the agent panel with it. */
export function senseAgents(raw: string, now = Date.now() / 1000): string {
  let payload: SubagentPayload = {};
  try {
    payload = JSON.parse(raw) as SubagentPayload;
  } catch {
    return '';
  }

  const projectDir = resolveStateRoot(payload.cwd || process.cwd());
  const rows = Array.isArray(payload.tasks) ? payload.tasks : [];
  if (!rows.length) return '';

  try {
    const cfg = loadConfig(projectDir);
    if (!cfg.enabled) return '';

    const sid = payload.session_id || 'unknown';
    const next = updateAgents(readAgents(projectDir, sid), rows, now);
    writeAgents(projectDir, next);

    const stats = typeStats(projectDir);
    const columns = typeof payload.columns === 'number' ? payload.columns : 80;

    return Object.values(next.agents)
      .map((a) => JSON.stringify({ id: a.id, content: renderAgentRow(a, stats, now, columns) }))
      .join('\n');
  } catch (err) {
    log(projectDir, 'error', `sense-agents failed: ${(err as Error)?.stack ?? String(err)}`);
    // Emitting nothing leaves every row with its default rendering.
    return '';
  }
}
