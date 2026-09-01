import { appendFileSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { ledgerPath, ensureGuardianDir } from '../core/paths.ts';
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
  | { k: 'boundary'; t: number; command: string }
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

/** Everything before the first heredoc marker.
 *
 *  A heredoc body is data, not commands: a commit message, a python script patching a doc.
 *  Classifying the whole line reads that data as instructions — and a commit message
 *  describing a bad test baseline got itself recorded as the test baseline, which is a neat
 *  demonstration and a useless handoff. */
function commandHead(cmd: string): string {
  const stripped = stripHeredocs(cmd);
  const i = stripped.indexOf('<<');
  return i === -1 ? stripped : stripped.slice(0, i);
}

/** Remove each heredoc from its marker to its terminator, keeping what follows.
 *
 *  Truncating at the first `<<` was the earlier fix, and it threw away every command after
 *  the body: a call that opened with a `python - <<PY` patch and went on to commit was
 *  classified by the word `python`, so the commit never reached the manifest. Guardian's own
 *  handoff was missing its own last commit. A heredoc with no terminator in sight -- a
 *  clipped command -- matches nothing here, and the caller still truncates. */
function stripHeredocs(cmd: string): string {
  return cmd.replace(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*?^\2[ \t]*$/gm, '');
}

/** Blank out quoted spans, for classification only.
 *
 *  The heredoc rule with a different delivery: a quoted argument is data too. Guardian
 *  recorded `guardian note --next "... 223 tests green (npm run check) ..."` as this
 *  session's test baseline, because the words were in the note, and the resume protocol then
 *  tells the next session to run that as its baseline. Extraction keeps the original text;
 *  only the matching sees this. */
function stripQuoted(s: string): string {
  return s.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
}

export function classifyCommand(cmd: string): CommandKind {
  const head = stripQuoted(commandHead(cmd));
  if (TEST_RE.test(head)) return 'test';
  if (BUILD_RE.test(head)) return 'build';
  if (GIT_RE.test(head)) return 'git';
  return 'other';
}

/** The runnable part of a line that happens to contain a test command.
 *
 *  People do not type `npm test`. They type it inside a compound line with a grep, a
 *  reinstall and three echoes, and the whole string was being stored as the session's test
 *  baseline — then handed to the next session as "run this to confirm the starting state".
 *  One real capture told a fresh session to run `npm install -g .` and a `guardian resume`
 *  that consumes a manifest. A baseline has to be the command, not the transcript of how it
 *  was invoked that once. */
export function testCommand(cmd: string): string | null {
  for (const segment of commandHead(cmd).split(/;|&&|\|\||\n/)) {
    if (!TEST_RE.test(stripQuoted(segment))) continue;
    // Drop a display pipeline and any redirection: `npm test 2>&1 | grep -E ...` is one
    // person's way of reading the output, not part of establishing the baseline.
    const bare = segment.split('|')[0]!.replace(/\d?>&?\d?\s*\S*/g, '').trim();
    if (bare) return bare;
  }
  return null;
}

/** Whether this line actually ran a commit, heredoc bodies and quoted text aside.
 *
 *  Not the same question as `classifyCommand(cmd) === 'git'`: that anchors on the start of
 *  the line, and a commit is very often the second thing a line does. The sha is still taken
 *  from git afterwards, never from the command text. */
export function mentionsGitCommit(cmd: string): boolean {
  const head = stripQuoted(commandHead(cmd));
  return /\bgit\b[^|;&\n]*\bcommit\b/.test(head) && !/--dry-run/.test(head);
}

/** Guardian sees a command's output but not its exit code (PostToolUse carries the result in
 *  `tool_response`; failures arrive on the separate PostToolUseFailure event). So success is
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
