import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import type { GuardianState } from '../types.ts';
import { readLedger, hashFile, type LedgerEvent } from './ledger.ts';
import { checkpoint, headMatches, type CheckpointResult } from './git.ts';
import { handoffDir, ensureGuardianDir } from '../core/paths.ts';
import { fmtMin } from '../budget/mode.ts';

const BACKSLASH = /\\/g;
const toPosix = (p: string): string => p.replace(BACKSLASH, '/');

export interface ManifestFile {
  path: string;
  sha256: string | null;
  bytes: number | null;
  last_edit: number;
}

export interface Manifest {
  schema: 1;
  sealed_at: number;
  sealed_at_iso: string;
  seal_reason: string;
  /** Set when a session actually resumes from this manifest, so it cannot double-apply. */
  consumed_at: number | null;
  session: { id: string; cwd: string; model: string | null };
  usage_at_seal: {
    mode: string;
    binding_axis: string | null;
    context_pct: number | null;
    five_hour_pct: number | null;
    five_hour_resets_at: number | null;
    seven_day_pct: number | null;
  };
  objective: string | null;
  observed: {
    files_touched: ManifestFile[];
    commits: Array<{ sha: string; subject: string }>;
    commands: Array<{ command: string; kind: string; ok: boolean | null; t: number }>;
    tests: { command: string; ok: boolean | null; at: number } | null;
    checkpoint: CheckpointResult | null;
    /** Irreversible operations that began and were never seen to return. */
    in_flight_at_seal: Array<{ command: string; started_at: number }>;
  };
  tasks: { completed: string[]; in_progress: string[] };
  agents: Array<{
    id: string;
    type: string;
    status: 'RETURNED' | 'IN_FLIGHT_AT_SEAL';
    summary: string | null;
    redo_cost_estimate: 'low' | 'medium' | 'unknown';
  }>;
  claude_supplied: { next_action: string | null; open_decisions: string[]; gotchas: string[] };
  resume_protocol: string[];
}

function notes(events: LedgerEvent[], field: string): string[] {
  return events
    .filter((e): e is Extract<LedgerEvent, { k: 'note' }> => e.k === 'note' && e.field === field)
    .map((e) => e.text);
}

/** Fold the ledger into a manifest. Everything here was observed as the session ran, so
 *  sealing is nearly free — which is the whole point. The design doc had Claude author a
 *  large reflective document at 95% usage, exactly when there is no budget left to
 *  reflect. Only `claude_supplied` needs the model, and it is a few short lines. */
export function buildManifest(
  projectDir: string,
  sessionId: string,
  state: GuardianState,
  reason: string,
  now: number,
  opts: { git?: boolean } = {},
): Manifest {
  const events = readLedger(projectDir, sessionId);
  const stamp = new Date(now * 1000).toISOString().replace(/[:.]/g, '-');

  // Latest observation per path wins: a file edited five times is one entry.
  const files = new Map<string, ManifestFile>();
  const commits: Array<{ sha: string; subject: string }> = [];
  const commands: Array<{ command: string; kind: string; ok: boolean | null; t: number }> = [];
  const boundaries = new Map<string, number>();
  const tasksDone = new Set<string>();
  const tasksOpen = new Map<string, string>();
  const agents = new Map<string, Manifest['agents'][number]>();
  let tests: Manifest['observed']['tests'] = null;

  for (const e of events) {
    switch (e.k) {
      case 'file':
        files.set(e.path, { path: e.path, sha256: e.sha256, bytes: e.bytes, last_edit: e.t });
        break;
      case 'commit':
        commits.push({ sha: e.sha, subject: e.subject });
        break;
      case 'command':
        commands.push({ command: e.command, kind: e.kind, ok: e.ok, t: e.t });
        if (e.kind === 'test') tests = { command: e.command, ok: e.ok, at: e.t };
        // PostToolUse only fires once a command returns, so seeing it here clears the
        // matching boundary marker. Whatever is left began and never came back.
        boundaries.delete(e.command);
        break;
      case 'boundary':
        boundaries.set(e.command, e.t);
        break;
      case 'task':
        if (e.status === 'completed') {
          tasksDone.add(e.title);
          tasksOpen.delete(e.id);
        } else {
          tasksOpen.set(e.id, e.title);
        }
        break;
      case 'agent':
        if (e.status === 'start') {
          agents.set(e.id, {
            id: e.id,
            type: e.type,
            status: 'IN_FLIGHT_AT_SEAL',
            summary: null,
            redo_cost_estimate: 'unknown',
          });
        } else {
          const prev = agents.get(e.id);
          agents.set(e.id, {
            id: e.id,
            type: e.type || prev?.type || 'unknown',
            status: 'RETURNED',
            summary: e.summary ?? null,
            // Re-running a read-only explorer is cheap; re-running one that wrote code is
            // not, and the resuming session needs to know which it is looking at.
            redo_cost_estimate: /explore|search|research|review/i.test(e.type || '')
              ? 'low'
              : 'medium',
          });
        }
        break;
      default:
        break;
    }
  }

  const ax = state.axes;
  const cp = opts.git === false ? null : checkpoint(projectDir, sessionId, stamp);

  return {
    schema: 1,
    sealed_at: now,
    sealed_at_iso: new Date(now * 1000).toISOString(),
    seal_reason: reason,
    consumed_at: null,
    session: { id: sessionId, cwd: projectDir, model: state.model },
    usage_at_seal: {
      mode: state.mode,
      binding_axis: state.binding_axis,
      context_pct: ax.context?.used_pct ?? null,
      five_hour_pct: ax.five_hour?.used_pct ?? null,
      five_hour_resets_at: ax.five_hour?.resets_at ?? null,
      seven_day_pct: ax.seven_day?.used_pct ?? null,
    },
    objective: notes(events, 'objective').at(-1) ?? null,
    observed: {
      files_touched: [...files.values()].sort((a, b) => b.last_edit - a.last_edit),
      commits,
      commands: commands.slice(-25),
      tests,
      checkpoint: cp,
      in_flight_at_seal: [...boundaries.entries()].map(([command, started_at]) => ({
        command,
        started_at,
      })),
    },
    tasks: { completed: [...tasksDone], in_progress: [...tasksOpen.values()] },
    agents: [...agents.values()],
    claude_supplied: {
      next_action: notes(events, 'next_action').at(-1) ?? null,
      open_decisions: notes(events, 'decision'),
      gotchas: notes(events, 'gotcha'),
    },
    // Only steps this manifest can actually back. A fixed list promises sections that a
    // digest may not carry — "verify the file hashes below" with no hashes below, "do not
    // redo anything under completed" with no completed section — and a cold reader is left
    // deciding whether the file is truncated or the tool is lying. Both readings cost it
    // the trust the handoff runs on.
    resume_protocol: [
      files.size
        ? 'Verify the file hashes below still match. A mismatch means the file changed outside this handoff.'
        : 'No files were recorded for this session; treat the working tree as unverified.',
      testStep(tests?.command ?? null),
      ...(tasksDone.size ? ['Do NOT redo anything listed under "completed".'] : []),
      'Resume from "next action". If it is absent, re-derive it from in-progress work before editing.',
    ],
  };
}

/** A recorded test command may have had a secret stripped out of it, which makes it
 *  unrunnable. Telling the next session to run a redacted command verbatim wastes a turn
 *  and looks like a bug, so say what actually happened instead. */
function testStep(command: string | null): string {
  if (!command) return 'Establish a build/test baseline before writing anything.';
  if (command.includes('[REDACTED]')) {
    return (
      'Establish a build/test baseline before writing anything. The last test command was ' +
      `recorded as \`${command}\` — a secret was stripped, so supply it again rather than ` +
      'running that string as-is.'
    );
  }
  return `Run \`${command}\` before writing anything, to confirm the starting state.`;
}

export function latestPath(projectDir: string): string {
  return join(handoffDir(projectDir), 'latest.json');
}
export function latestDigestPath(projectDir: string): string {
  return join(handoffDir(projectDir), 'latest.md');
}

function writeAtomic(projectDir: string, p: string, content: string): void {
  ensureGuardianDir(projectDir, dirname(p));
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, p);
}

export function seal(
  projectDir: string,
  sessionId: string,
  state: GuardianState,
  reason: string,
  now: number,
  opts: { git?: boolean } = {},
): Manifest {
  const m = buildManifest(projectDir, sessionId, state, reason, now, opts);
  const stamp = m.sealed_at_iso.replace(/[:.]/g, '-');
  writeAtomic(projectDir, latestPath(projectDir), `${JSON.stringify(m, null, 2)}\n`);
  writeAtomic(projectDir, latestDigestPath(projectDir), renderDigest(m, projectDir));
  writeAtomic(
    projectDir,
    join(handoffDir(projectDir), 'history', `${stamp}.json`),
    `${JSON.stringify(m)}\n`,
  );
  return m;
}

export function readLatest(projectDir: string): Manifest | null {
  try {
    const m = JSON.parse(readFileSync(latestPath(projectDir), 'utf8')) as Manifest;
    return m?.schema === 1 ? m : null;
  } catch {
    return null;
  }
}

export function markConsumed(projectDir: string, now: number): Manifest | null {
  const m = readLatest(projectDir);
  if (!m) return null;
  m.consumed_at = now;
  writeAtomic(projectDir, latestPath(projectDir), `${JSON.stringify(m, null, 2)}\n`);
  return m;
}

export function hasUnconsumed(projectDir: string): Manifest | null {
  const m = readLatest(projectDir);
  return m && m.consumed_at === null ? m : null;
}

const MAX_FILES_IN_DIGEST = 25;

/** The artifact that actually gets injected into a context window, so every line has to
 *  earn its tokens. Roughly 300-500 tokens for a busy session. */
export function renderDigest(m: Manifest, projectDir: string): string {
  const rel = (p: string): string => {
    const r = relative(projectDir, p);
    return r && !r.startsWith('..') ? toPosix(r) : toPosix(p);
  };
  const L: string[] = [];
  L.push('# Guardian handoff');
  L.push('');
  L.push(`Sealed ${m.sealed_at_iso} — ${m.seal_reason}`);
  if (m.objective) L.push(`Objective: ${m.objective}`);
  L.push('');

  if (m.claude_supplied.next_action) {
    L.push('## Next action');
    L.push(m.claude_supplied.next_action);
    L.push('');
  }

  if (m.tasks.completed.length) {
    L.push('## Completed — do not redo');
    for (const t of m.tasks.completed) L.push(`- ${t}`);
    L.push('');
  }
  if (m.tasks.in_progress.length) {
    L.push('## In progress');
    for (const t of m.tasks.in_progress) L.push(`- ${t}`);
    L.push('');
  }

  const f = m.observed.files_touched;
  if (f.length) {
    L.push(`## Files touched (${f.length})`);
    for (const x of f.slice(0, MAX_FILES_IN_DIGEST)) {
      L.push(`- ${rel(x.path)}${x.sha256 ? ` \`${x.sha256.slice(0, 12)}\`` : ''}`);
    }
    if (f.length > MAX_FILES_IN_DIGEST) L.push(`- …and ${f.length - MAX_FILES_IN_DIGEST} more`);
    L.push('');
  }

  const cp = m.observed.checkpoint;
  if (cp && cp.kind !== 'none') {
    L.push('## Repository');
    if (cp.branch) {
      L.push(`- branch \`${cp.branch}\`${cp.head ? ` at \`${cp.head.slice(0, 8)}\`` : ''}`);
    }
    if (cp.ref) L.push(`- checkpoint \`${cp.ref}\` (\`git show ${cp.sha?.slice(0, 8)}\`)`);
    if (cp.dirty_files) L.push(`- ${cp.dirty_files} uncommitted file(s) at seal time`);
    L.push('');
  }
  if (m.observed.commits.length) {
    L.push('## Commits this session');
    for (const c of m.observed.commits) L.push(`- \`${c.sha.slice(0, 8)}\` ${c.subject}`);
    L.push('');
  }

  if (m.observed.in_flight_at_seal.length) {
    // The most important thing a resuming session can be told: something irreversible may
    // be half-done, and nothing on disk will necessarily reveal it.
    L.push('## ⚠ Possibly interrupted mid-operation');
    for (const b of m.observed.in_flight_at_seal) {
      L.push(`- \`${b.command}\` started and was never seen to finish`);
    }
    L.push('Check the state of these before assuming the workspace is consistent.');
    L.push('');
  }

  if (m.observed.tests) {
    const t = m.observed.tests;
    const verdict = t.ok === null ? 'result unclear' : t.ok ? 'passing' : 'FAILING';
    L.push('## Tests');
    L.push(`\`${t.command}\` — ${verdict}`);
    L.push('');
  }

  if (m.agents.length) {
    L.push('## Agents');
    for (const a of m.agents) {
      L.push(`- ${a.id} (${a.type}) — ${a.status}, redo cost ${a.redo_cost_estimate}`);
      if (a.summary) L.push(`  ${a.summary}`);
    }
    L.push('');
  }

  if (m.claude_supplied.open_decisions.length) {
    L.push('## Open decisions');
    for (const d of m.claude_supplied.open_decisions) L.push(`- ${d}`);
    L.push('');
  }
  if (m.claude_supplied.gotchas.length) {
    L.push('## Gotchas');
    for (const g of m.claude_supplied.gotchas) L.push(`- ${g}`);
    L.push('');
  }

  L.push('## Resume protocol');
  for (const [i, step] of m.resume_protocol.entries()) L.push(`${i + 1}. ${step}`);

  const u = m.usage_at_seal;
  const parts: string[] = [];
  if (u.context_pct != null) parts.push(`context ${u.context_pct.toFixed(0)}%`);
  if (u.five_hour_pct != null) {
    const r = u.five_hour_resets_at
      ? `, resets in ${fmtMin((u.five_hour_resets_at - m.sealed_at) / 60)}`
      : '';
    parts.push(`5-hour ${u.five_hour_pct.toFixed(0)}%${r}`);
  }
  if (parts.length) {
    L.push('');
    L.push(`_At seal: ${u.mode} — ${parts.join(', ')}._`);
  }
  return `${L.join('\n')}\n`;
}

export interface Verification {
  files: Array<{ path: string; status: 'unchanged' | 'changed' | 'missing' | 'unverifiable' }>;
  head_matches: boolean | null;
}

/** "Do not redo completed work" is unenforceable without this: it turns an assumption
 *  about the workspace into a check the resuming session can actually run. */
export function verify(projectDir: string, m: Manifest): Verification {
  const files = m.observed.files_touched.map((f) => {
    if (!existsSync(f.path)) return { path: f.path, status: 'missing' as const };
    if (f.sha256 === null) return { path: f.path, status: 'unverifiable' as const };
    const now = hashFile(f.path);
    return {
      path: f.path,
      status: now.sha256 === f.sha256 ? ('unchanged' as const) : ('changed' as const),
    };
  });
  return { files, head_matches: headMatches(projectDir, m.observed.checkpoint?.head ?? null) };
}
