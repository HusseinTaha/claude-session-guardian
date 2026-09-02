import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir, sanitize } from './paths.ts';

/** One live subagent, as reported by `subagentStatusLine` and sampled over time. */
export interface AgentSnapshot {
  id: string;
  name: string | null;
  type: string | null;
  status: string | null;
  /** What this agent was actually asked to do. The default row leads with it, and dropping
   *  it for a gauge trades the only field that says which agent this is. */
  description: string | null;
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

export function agentsPath(projectDir: string, sessionId: string): string {
  return join(stateDir(projectDir), 'sessions', `${sanitize(sessionId)}.agents.json`);
}

export function emptyAgents(sessionId: string): AgentsFile {
  return { schema: 1, session_id: sessionId, updated_at: 0, agents: {} };
}

/** The registry lives in core, not with the sensor that writes it: the handoff has to read
 *  it to hand over each running agent, and the handoff layer sits below sensors. */
export function readAgents(projectDir: string, sessionId: string): AgentsFile {
  try {
    const f = JSON.parse(readFileSync(agentsPath(projectDir, sessionId), 'utf8')) as AgentsFile;
    return f?.schema === 1 ? f : emptyAgents(sessionId);
  } catch {
    return emptyAgents(sessionId);
  }
}

/** An agent Guardian has seen recently enough to believe it is still working. The
 *  subagent status line ticks while any agent is live, so silence means gone. */
export function isLive(a: AgentSnapshot, now: number, staleAfterS = 120): boolean {
  return now - a.last_seen <= staleAfterS;
}

export function liveCount(f: AgentsFile, now: number, staleAfterS = 120): number {
  return Object.values(f.agents).filter((a) => isLive(a, now, staleAfterS)).length;
}
