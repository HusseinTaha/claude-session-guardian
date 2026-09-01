import { appendFileSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { ledgerPath, ensureGuardianDir } from './paths.ts';
import { redact, clip } from './redact.ts';

/** Everything Guardian can learn by watching, as opposed to by asking.
 *
 *  This is the core of Phase 2: the design doc had Claude author a large reflective
 *  manifest at 95% usage — exactly the moment there is no budget left to reflect. Hooks
 *  observe most of it continuously and for free, so sealing costs almost nothing. */
export type LedgerEvent =
  | { k: 'file'; t: number; path: string; sha256: string | null; bytes: number | null; tool: string }
  | { k: 'command'; t: number; command: string; kind: CommandKind; ok: boolean | null }
  | { k: 'commit'; t: number; sha: string; subject: string }
  | { k: 'task'; t: number; id: string; title: string; status: 'created' | 'completed' }
  | { k: 'agent'; t: number; id: string; type: string; status: 'start' | 'stop'; summary?: string }
  | { k: 'note'; t: number; field: NoteField; text: string }
  | { k: 'seal'; t: number; reason: string };

export type CommandKind = 'test' | 'build' | 'git' | 'other';
export type NoteField = 'objective' | 'next_action' | 'decision' | 'gotcha';

export function appendEvent(projectDir: string, sessionId: string, ev: LedgerEvent): void {
  const p = ledgerPath(projectDir, sessionId);
  ensureGuardianDir(projectDir, dirname(p));
  appendFileSync(p, `${JSON.stringify(ev)}\n`);
}

/** A truncated final line is normal — the process can die mid-append — so a bad line is
 *  skipped rather than allowed to invalidate the whole ledger. */
export function readLedger(projectDir: string, sessionId: string): LedgerEvent[] {
  let raw: string;
  try {
    raw = readFileSync(ledgerPath(projectDir, sessionId), 'utf8');
  } catch {
    return [];
  }
  const out: LedgerEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as LedgerEvent);
    } catch {
      /* skip */
    }
  }
  return out;
}

const HASH_LIMIT = 4 * 1024 * 1024;

/** Hash of a file's current contents, so a resuming session can *prove* the work is still
 *  there instead of assuming it. Large files record size only: the point is change
 *  detection, and hashing a 200 MB artifact on a hot path is not worth it. */
export function hashFile(path: string): { sha256: string | null; bytes: number | null } {
  try {
    const st = statSync(path);
    if (!st.isFile()) return { sha256: null, bytes: null };
    if (st.size > HASH_LIMIT) return { sha256: null, bytes: st.size };
    const h = createHash('sha256').update(readFileSync(path)).digest('hex');
    return { sha256: h, bytes: st.size };
  } catch {
    return { sha256: null, bytes: null };
  }
}

const TEST_RE = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|check)\b|\bnode\s+--test\b|\bpytest\b|\bgo\s+test\b|\bcargo\s+test\b|\bdotnet\s+test\b|\bmvn\s+test\b|\bjest\b|\bvitest\b|\brspec\b/;
const BUILD_RE = /\b(npm|pnpm|yarn|bun)\s+run\s+build\b|\btsc\b|\bcargo\s+build\b|\bgo\s+build\b|\bdotnet\s+build\b|\bmake\b|\bwebpack\b|\bvite\s+build\b/;
const GIT_RE = /^\s*git\s/;

export function classifyCommand(cmd: string): CommandKind {
  if (TEST_RE.test(cmd)) return 'test';
  if (BUILD_RE.test(cmd)) return 'build';
  if (GIT_RE.test(cmd)) return 'git';
  return 'other';
}

/** Guardian sees a command's output but not its exit code (PostToolUse carries
 *  `tool_output`; failures arrive on the separate PostToolUseFailure event). So success is
 *  inferred, and `null` is returned whenever the output is genuinely ambiguous — an
 *  invented verdict in a handoff is worse than an absent one. */
export function inferOk(output: string): boolean | null {
  const s = output.slice(-4000);
  if (/\bfail(ed|ures?)?\b|\berror\b|✖|not ok|Traceback|panic:/i.test(s)) {
    // "0 failures" and "0 errors" are successes that mention the words.
    if (/\b0 (failures?|errors?)\b|fail 0|failures: 0/i.test(s) && !/✖|\bFAILED\b/.test(s)) {
      return true;
    }
    return false;
  }
  if (/\bpass(ed|ing)?\b|\bok\b|✔|\bsucce(ss|eded)\b|\bbuilt\b|Done in/i.test(s)) return true;
  return null;
}

export function fileEvent(path: string, tool: string, t: number): LedgerEvent {
  const { sha256, bytes } = hashFile(path);
  return { k: 'file', t, path, sha256, bytes, tool };
}

export function commandEvent(cmd: string, output: string, t: number): LedgerEvent {
  return {
    k: 'command',
    t,
    command: clip(redact(cmd), 300),
    kind: classifyCommand(cmd),
    ok: inferOk(output),
  };
}
