import { readFileSync } from 'node:fs';
import { resolveStateRoot, stateDir } from './paths.ts';
import { loadConfig } from './config.ts';
import { readState } from './state.ts';
import { renderDashboard } from './render.ts';
import { seal, readLatest, latestDigestPath } from './manifest.ts';
import { appendEvent } from './ledger.ts';
import { latestSessionIn } from './sessions.ts';
import { log } from './log.ts';

/** A minimal MCP stdio server: JSON-RPC 2.0, newline-delimited, no dependencies.
 *
 *  Deliberately three tools. Every tool schema is resident context in every request, so a
 *  fourteen-tool server would spend budget on every turn — self-defeating in a tool whose
 *  entire purpose is conserving it. The hooks already cover the workflow; this exists only
 *  so Claude can ask on purpose rather than wait to be told. */

interface Req {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

const SERVER = { name: 'claude-session-guardian', version: '0.5.0' };
const FALLBACK_PROTOCOL = '2025-06-18';

const TOOLS = [
  {
    name: 'guardian_status',
    description:
      'Current session budget: mode, per-axis usage, burn rate, and minutes until each ' +
      'wall. Call this before deciding whether a large task or a subagent fan-out fits in ' +
      'the remaining budget. "refills first" means that window replenishes faster than it ' +
      'is being consumed and is safe at any percentage.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'guardian_checkpoint',
    description:
      'Seal a resumable handoff of the work so far. Pass next_action: the single most ' +
      'specific next step. Guardian already records files, commands, commits, tasks and ' +
      'tests by watching; intent is the only thing it cannot observe, so next_action is ' +
      'the field that matters.',
    inputSchema: {
      type: 'object',
      properties: {
        next_action: { type: 'string', description: 'The single most specific next step.' },
        objective: { type: 'string', description: 'One sentence on the overall goal.' },
        gotcha: { type: 'string', description: 'Something a fresh session would get wrong.' },
        reason: { type: 'string', description: 'Why the handoff is being sealed now.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'guardian_resume_context',
    description:
      'The digest of the last sealed handoff: objective, next action, completed work not ' +
      'to redo, files touched with hashes, and the git checkpoint. Call this when picking ' +
      'up work from a previous session.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
] as const;

function text(s: string, isError = false): Record<string, unknown> {
  return { content: [{ type: 'text', text: s }], ...(isError ? { isError: true } : {}) };
}

function callTool(name: string, args: Record<string, unknown>, now: number): Record<string, unknown> {
  const projectDir = resolveStateRoot(process.cwd());
  const cfg = loadConfig(projectDir);
  const sid = latestSessionIn(projectDir);

  switch (name) {
    case 'guardian_status': {
      if (!sid) return text('Guardian has no state for this project yet; the status line sensor has not run.');
      return text(renderDashboard(readState(projectDir, sid), cfg));
    }

    case 'guardian_checkpoint': {
      if (!sid) return text('Guardian has no state for this project yet; nothing to seal.', true);
      const notes: Array<[string, string]> = [
        ['next_action', 'next_action'],
        ['objective', 'objective'],
        ['gotcha', 'gotcha'],
      ];
      for (const [key, field] of notes) {
        const v = args[key];
        if (typeof v === 'string' && v.trim()) {
          appendEvent(projectDir, sid, {
            k: 'note',
            t: now,
            field: field as 'next_action' | 'objective' | 'gotcha',
            text: v.trim(),
          });
        }
      }
      const reason = typeof args.reason === 'string' && args.reason ? args.reason : 'mcp checkpoint';
      const m = seal(projectDir, sid, readState(projectDir, sid), reason, now);
      const cp = m.observed.checkpoint;
      const lines = [
        `Sealed a handoff (${reason}).`,
        `  files tracked: ${m.observed.files_touched.length}`,
        `  commits:       ${m.observed.commits.length}`,
        `  checkpoint:    ${cp?.ref ?? cp?.detail ?? 'none'}`,
        m.claude_supplied.next_action
          ? `  next action:   ${m.claude_supplied.next_action}`
          : '  next action:   MISSING — a resuming session will have to guess. Call again with next_action.',
      ];
      return text(lines.join('\n'));
    }

    case 'guardian_resume_context': {
      const m = readLatest(projectDir);
      if (!m) return text('No sealed handoff exists for this project.');
      try {
        return text(readFileSync(latestDigestPath(projectDir), 'utf8'));
      } catch {
        return text(`Manifest exists but its digest is missing. Raw manifest is in ${stateDir(projectDir)}.`, true);
      }
    }

    default:
      return text(`Unknown tool: ${name}`, true);
  }
}

function handleRequest(req: Req, now: number): Record<string, unknown> | null {
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: req.id ?? null, result });
  const fail = (code: number, message: string) => ({
    jsonrpc: '2.0',
    id: req.id ?? null,
    error: { code, message },
  });

  switch (req.method) {
    case 'initialize': {
      // Echo the client's protocol version when it offers one; guessing high on our own
      // would break older clients for no benefit.
      const asked = req.params?.protocolVersion;
      return reply({
        protocolVersion: typeof asked === 'string' ? asked : FALLBACK_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: SERVER,
      });
    }

    case 'notifications/initialized':
    case 'initialized':
      return null; // a notification takes no reply

    case 'tools/list':
      return reply({ tools: TOOLS });

    case 'tools/call': {
      const name = req.params?.name;
      if (typeof name !== 'string') return fail(-32602, 'params.name must be a string');
      const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        return reply(callTool(name, args, now));
      } catch (err) {
        return reply(text(`Guardian failed: ${(err as Error).message}`, true));
      }
    }

    case 'ping':
      return reply({});

    default:
      if (req.method?.startsWith('notifications/')) return null;
      return fail(-32601, `Method not found: ${req.method}`);
  }
}

/** Read newline-delimited JSON-RPC from stdin and write replies to stdout. Anything that is
 *  not a well-formed request is ignored rather than crashing the server. */
export function serve(now: () => number = () => Date.now() / 1000): void {
  const projectDir = resolveStateRoot(process.cwd());
  let buffer = '';

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const req = JSON.parse(line) as Req;
        const res = handleRequest(req, now());
        if (res) process.stdout.write(`${JSON.stringify(res)}\n`);
      } catch (err) {
        log(projectDir, 'error', `mcp line failed: ${(err as Error).message}`);
      }
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

/** Exported for tests: one request in, one reply out. */
export function handleLine(line: string, now: number): string | null {
  try {
    const res = handleRequest(JSON.parse(line) as Req, now);
    return res ? JSON.stringify(res) : null;
  } catch {
    return null;
  }
}

export { TOOLS };
