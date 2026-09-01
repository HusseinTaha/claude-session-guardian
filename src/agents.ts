import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { stateDir, sanitize, ensureGuardianDir } from './paths.ts';

/** One live subagent, as reported by `subagentStatusLine` and sampled over time. */
export interface AgentSnapshot {
  id: string;
  name: string | null;
  type: string | null;
  status: string | null;
  /** Epoch seconds. */
  started_at: number | null;
  token_count: number | null;
  context_window: number | null;
  /** Bounded ring of (epoch seconds, token count), oldest first. */
  samples: Array<{ t: number; tokens: number }>;
  tokens_per_min: number | null;
  last_seen: number;
}

export interface AgentsFile {
  schema: 1;
  session_id: string;
  updated_at: number;
  agents: Record<string, AgentSnapshot>;
}

/** A task row from the `subagentStatusLine` payload. Every field is optional: `model` and
 *  `contextWindowSize` are documented as absent until the task's model resolves, and
 *  `effort` is absent when the subagent inherits the session's level. */
export interface TaskRow {
  id?: string;
  name?: string;
  type?: string;
  status?: string;
  description?: string;
  label?: string;
  startTime?: number | string;
  model?: string;
  effort?: string | number;
  contextWindowSize?: number;
  tokenCount?: number;
  tokenSamples?: unknown;
  cwd?: string;
}

const MAX_SAMPLES = 40;
const MAX_DURATIONS = 50;

export function agentsPath(projectDir: string, sessionId: string): string {
  return join(stateDir(projectDir), 'sessions', `${sanitize(sessionId)}.agents.json`);
}

export function statsPath(projectDir: string): string {
  return join(stateDir(projectDir), 'agent-stats.json');
}

function writeAtomic(projectDir: string, p: string, content: string): void {
  ensureGuardianDir(projectDir, dirname(p));
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, p);
}

export function emptyAgents(sessionId: string): AgentsFile {
  return { schema: 1, session_id: sessionId, updated_at: 0, agents: {} };
}

export function readAgents(projectDir: string, sessionId: string): AgentsFile {
  try {
    const f = JSON.parse(readFileSync(agentsPath(projectDir, sessionId), 'utf8')) as AgentsFile;
    return f?.schema === 1 ? f : emptyAgents(sessionId);
  } catch {
    return emptyAgents(sessionId);
  }
}

export function writeAgents(projectDir: string, f: AgentsFile): void {
  writeAtomic(projectDir, agentsPath(projectDir, f.session_id), `${JSON.stringify(f, null, 2)}\n`);
}

/** Timestamps arrive as epoch milliseconds in some payloads and seconds in others; a value
 *  above ~2001 in seconds is unambiguously milliseconds. */
export function toEpochSeconds(v: number | string | undefined): number | null {
  if (v === undefined || v === null) return null;
  const n = typeof v === 'string' ? Date.parse(v) / 1000 : v;
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 1e11 ? n / 1000 : n;
}

/** Tokens per minute for one agent, measured from Guardian's own timestamped samples.
 *
 *  The payload also carries `tokenSamples`, but its element shape is not something to
 *  depend on, and a rate needs timestamps Guardian can trust. Sampling on our own ticks is
 *  both simpler and verifiable. */
function rate(samples: Array<{ t: number; tokens: number }>): number | null {
  if (samples.length < 2) return null;
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  const spanS = last.t - first.t;
  if (spanS < 20) return null;
  const delta = last.tokens - first.tokens;
  if (delta <= 0) return null;
  return delta / (spanS / 60);
}

/** Fold a tick's task rows into the persisted snapshot set. */
export function updateAgents(prev: AgentsFile, rows: TaskRow[], now: number): AgentsFile {
  const agents: Record<string, AgentSnapshot> = {};

  for (const row of rows) {
    const id = row.id;
    if (!id) continue;
    const old = prev.agents[id];
    const tokens = typeof row.tokenCount === 'number' ? row.tokenCount : null;

    let samples = old?.samples ?? [];
    if (tokens !== null) {
      const last = samples[samples.length - 1];
      // Thin to one sample per 5s, matching the main sensor.
      if (last && now - last.t < 5) samples = [...samples.slice(0, -1), { t: now, tokens }];
      else samples = [...samples, { t: now, tokens }];
      samples = samples.slice(-MAX_SAMPLES);
    }

    agents[id] = {
      id,
      name: row.name ?? old?.name ?? null,
      type: row.type ?? old?.type ?? null,
      status: row.status ?? null,
      started_at: toEpochSeconds(row.startTime) ?? old?.started_at ?? null,
      token_count: tokens ?? old?.token_count ?? null,
      context_window:
        typeof row.contextWindowSize === 'number'
          ? row.contextWindowSize
          : (old?.context_window ?? null),
      samples,
      tokens_per_min: rate(samples),
      last_seen: now,
    };
  }

  return { schema: 1, session_id: prev.session_id, updated_at: now, agents };
}

export function liveCount(f: AgentsFile, now: number, staleAfterS = 120): number {
  return Object.values(f.agents).filter((a) => now - a.last_seen <= staleAfterS).length;
}

// ------------------------------------------------------------ historical durations

interface StatsFile {
  schema: 1;
  types: Record<string, { durations: number[] }>;
}

export interface TypeStats {
  count: number;
  median_s: number;
}

function readStatsFile(projectDir: string): StatsFile {
  try {
    const f = JSON.parse(readFileSync(statsPath(projectDir), 'utf8')) as StatsFile;
    return f?.schema === 1 ? f : { schema: 1, types: {} };
  } catch {
    return { schema: 1, types: {} };
  }
}

/** How long agents of this type have historically taken, accumulated across sessions.
 *
 *  This is the only defensible basis for an ETA. Guardian cannot know how much work a
 *  running agent has left — nothing exposes that — but "agents of this type usually finish
 *  in about six minutes" is a real measurement, and it is what makes "will this fit in the
 *  remaining budget?" answerable rather than a guess. */
export function typeStats(projectDir: string): Record<string, TypeStats> {
  const f = readStatsFile(projectDir);
  const out: Record<string, TypeStats> = {};
  for (const [type, { durations }] of Object.entries(f.types)) {
    if (!durations?.length) continue;
    const sorted = [...durations].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    out[type] = {
      count: sorted.length,
      median_s:
        sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2,
    };
  }
  return out;
}

export function recordDuration(projectDir: string, type: string, seconds: number): void {
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 6 * 3600) return;
  const f = readStatsFile(projectDir);
  const entry = f.types[type] ?? { durations: [] };
  entry.durations = [...entry.durations, Math.round(seconds)].slice(-MAX_DURATIONS);
  f.types[type] = entry;
  writeAtomic(projectDir, statsPath(projectDir), `${JSON.stringify(f)}\n`);
}

/** Minutes until an agent fills its own context window, or null when unmeasurable.
 *  Distinct from "when will it finish" — this one is knowable. */
export function contextWallMin(a: AgentSnapshot): number | null {
  if (!a.context_window || a.token_count === null || !a.tokens_per_min) return null;
  const remaining = a.context_window - a.token_count;
  if (remaining <= 0) return 0;
  return remaining / a.tokens_per_min;
}
