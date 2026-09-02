import {
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  existsSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join, dirname, relative } from 'node:path';
import type { GuardianState } from '../types.ts';
import { readLedger, hashFile, testCommand, type LedgerEvent } from './ledger.ts';
import {
  checkpoint,
  headMatches,
  pruneCheckpoints,
  type CheckpointResult,
} from './git.ts';
import {
  handoffDir,
  ensureGuardianDir,
  agentNotesDir,
  agentNotesFile,
} from '../core/paths.ts';
import { readAgents, isLive, type AgentSnapshot } from '../core/agents.ts';
import { log } from '../core/log.ts';
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
    /** What each agent wrote down for itself while it worked. An agent cannot be resumed,
     *  but the ground it covered does not have to be walked twice. */
    agent_notes: Array<{ file: string; updated_at: number; excerpt: string }>;
    checkpoint: CheckpointResult | null;
    /** Irreversible operations that began and were never seen to return. */
    in_flight_at_seal: Array<{ command: string; started_at: number }>;
  };
  tasks: { completed: string[]; in_progress: string[] };
  /** One entry per subagent, and each is its own small handoff: an agent cannot be paused
   *  or resumed, so what it was asked to do, how far it got, and where it wrote things down
   *  is everything the next session gets. */
  agents: Array<{
    id: string;
    type: string;
    status: 'RETURNED' | 'IN_FLIGHT_AT_SEAL';
    summary: string | null;
    redo_cost_estimate: 'low' | 'medium' | 'unknown';
    /** What it was asked to do, from the live registry the subagent status line writes. */
    description: string | null;
    started_at: number | null;
    elapsed_min: number | null;
    /** How full its own context window was — an agent has a wall of its own. */
    context_pct: number | null;
    /** Its own notes file, and whether anything is in it. An in-flight agent with nothing
     *  written down is work that does not survive this seal. */
    notes_file: string | null;
    notes_recorded: boolean;
  }>;
  claude_supplied: {
    next_action: string | null;
    /** When that note was written. The next action is the one field with a shelf life:
     *  written once, it goes on reading as current for as long as the manifest lives. */
    next_action_at: number | null;
    /** Work recorded after the note. Non-null means the note describes a state the session
     *  had already left by the time it sealed. */
    next_action_superseded: { commits: number; files: number } | null;
    open_decisions: string[];
    gotchas: string[];
  };
  resume_protocol: string[];
}

const NOTE_EXCERPT = 1500;

/** Collect what the agents wrote for themselves.
 *
 *  Near a wall Guardian tells every new subagent to record findings in
 *  `.claude/guardian/agent-notes/` as it goes, because an agent cut off at minute four of
 *  an eighteen-minute task should leave something behind. Those files were being written
 *  and never read: the handoff carried "agent X was running" and not one line of what X had
 *  established. An agent still cannot be resumed — its state is its context — but the next
 *  session can pick up the ground it covered instead of sending someone over it again. */
function readAgentNotes(projectDir: string): Manifest['observed']['agent_notes'] {
  const dir = agentNotesDir(projectDir);
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }
  const out: Manifest['observed']['agent_notes'] = [];
  for (const name of names) {
    const file = join(dir, name);
    try {
      const text = readFileSync(file, 'utf8').trim();
      if (!text) continue;
      out.push({
        file: toPosix(relative(projectDir, file)),
        updated_at: Math.floor(statSync(file).mtimeMs / 1000),
        excerpt: text.length > NOTE_EXCERPT ? `${text.slice(0, NOTE_EXCERPT)}
…` : text,
      });
    } catch {
      /* unreadable: it contributes nothing, and a seal must not fail over it */
    }
  }
  return out.sort((a, b) => b.updated_at - a.updated_at);
}

function noteEvents(
  events: LedgerEvent[],
  field: string,
): Array<Extract<LedgerEvent, { k: 'note' }>> {
  return events.filter(
    (e): e is Extract<LedgerEvent, { k: 'note' }> => e.k === 'note' && e.field === field,
  );
}

function notes(events: LedgerEvent[], field: string): string[] {
  return noteEvents(events, field).map((e) => e.text);
}

export interface NextActionStatus {
  text: string;
  at: number;
  /** Non-null when work was recorded after the note was written. */
  superseded: { commits: number; files: number } | null;
}

export function nextActionFrom(events: LedgerEvent[]): NextActionStatus | null {
  const last = noteEvents(events, 'next_action').at(-1);
  if (!last) return null;
  return { text: last.text, at: last.t, superseded: supersededSince(events, last.t) };
}

/** The recorded intent for one session, straight from its ledger. Cheap enough for the
 *  landing brief, which has to say whether the note the model wrote hours ago still
 *  describes anything. */
export function nextActionStatus(projectDir: string, sessionId: string): NextActionStatus | null {
  return nextActionFrom(readLedger(projectDir, sessionId));
}

/** What was recorded after the next action was written.
 *
 *  A long session writes its next action once and then keeps working. Yesterday's
 *  "ONLY LANE K REMAINS" seals unchanged into today's handoff and reads as current — the
 *  most confident line in the digest is the one nobody has looked at since. The counts
 *  here are what lets every surface say so instead of presenting it straight. */
function supersededSince(events: LedgerEvent[], t: number): { commits: number; files: number } | null {
  let commits = 0;
  const files = new Set<string>();
  for (const e of events) {
    if (e.t <= t) continue;
    if (e.k === 'commit') commits++;
    else if (e.k === 'file') files.add(e.path);
  }
  return commits || files.size ? { commits, files: files.size } : null;
}

type ManifestAgent = Manifest['agents'][number];

const BLANK_AGENT: ManifestAgent = {
  id: '',
  type: 'unknown',
  status: 'IN_FLIGHT_AT_SEAL',
  summary: null,
  redo_cost_estimate: 'unknown',
  description: null,
  started_at: null,
  elapsed_min: null,
  context_pct: null,
  notes_file: null,
  notes_recorded: false,
};

function redoCost(type: string): ManifestAgent['redo_cost_estimate'] {
  if (!type) return 'unknown';
  return /explore|search|research|review/i.test(type) ? 'low' : 'medium';
}

/** Everything the live registry knows about one agent, folded into its manifest entry.
 *
 *  The ledger says an agent started and stopped; the registry the subagent status line
 *  writes says what it was asked to do, how long it has been at it and how full its own
 *  context is. A handoff that carries only the first tells the next session that "agent
 *  ag2 was running" and nothing it could act on. */
function fromRegistry(
  a: AgentSnapshot,
  projectDir: string,
  now: number,
  live: boolean,
  prev: ManifestAgent | undefined,
): ManifestAgent {
  const notes = a.description ? agentNotesFile(projectDir, a.description) : null;
  let recorded = false;
  if (notes) {
    try {
      recorded = readFileSync(notes, 'utf8').trim().length > 0;
    } catch {
      recorded = false;
    }
  }
  const type = a.type || prev?.type || 'unknown';
  return {
    ...(prev ?? BLANK_AGENT),
    id: a.id,
    type,
    status: prev?.status === 'RETURNED' || !live ? (prev?.status ?? 'RETURNED') : 'IN_FLIGHT_AT_SEAL',
    redo_cost_estimate: prev?.redo_cost_estimate === 'unknown' || !prev ? redoCost(type) : prev.redo_cost_estimate,
    description: a.description ?? prev?.description ?? null,
    started_at: a.started_at,
    elapsed_min: a.started_at ? Math.max(0, (now - a.started_at) / 60) : null,
    context_pct:
      a.context_window && a.token_count !== null
        ? Math.min(100, (a.token_count / a.context_window) * 100)
        : null,
    notes_file: notes ? toPosix(relative(projectDir, notes)) : null,
    notes_recorded: recorded,
  };
}

/** In-flight agents that left nothing behind. The count the resume protocol has to lead
 *  with: it is the only part of a session that cannot be recovered from disk. */
function lostAgents(agents: Map<string, ManifestAgent>): number {
  return [...agents.values()].filter((a) => a.status === 'IN_FLIGHT_AT_SEAL' && !a.notes_recorded)
    .length;
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
        // Store the runnable command, not the compound line it was buried in: the resume
        // protocol tells the next session to run this one verbatim.
        if (e.kind === 'test') {
          tests = { command: testCommand(e.command) ?? e.command, ok: e.ok, at: e.t };
        }
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
          agents.set(e.id, { ...BLANK_AGENT, id: e.id, type: e.type, status: 'IN_FLIGHT_AT_SEAL' });
        } else {
          const prev = agents.get(e.id);
          agents.set(e.id, {
            ...(prev ?? BLANK_AGENT),
            id: e.id,
            type: e.type || prev?.type || 'unknown',
            status: 'RETURNED',
            summary: e.summary ?? null,
            // Re-running a read-only explorer is cheap; re-running one that wrote code is
            // not, and the resuming session needs to know which it is looking at.
            redo_cost_estimate: redoCost(e.type || prev?.type || ''),
          });
        }
        break;
      default:
        break;
    }
  }

  // Each running agent is handed over on its own terms, not just counted. The registry is
  // keyed by the same task id the SubagentStart hook reports; an id only the registry knows
  // is still listed, because an agent Guardian can see running is one the next session has
  // to account for.
  for (const a of Object.values(readAgents(projectDir, sessionId).agents)) {
    if (!a.id) continue;
    agents.set(a.id, fromRegistry(a, projectDir, now, isLive(a, now), agents.get(a.id)));
  }

  const next = nextActionFrom(events);
  const ax = state.axes;
  const cp = opts.git === false ? null : checkpoint(projectDir, sessionId, stamp);
  // A checkpoint that quietly degrades is one you discover at the moment you need it. The
  // manifest already carries the reason; the log is what a later session actually reads.
  if (cp && cp.kind !== 'ref' && cp.kind !== 'none') {
    log(projectDir, 'warn', `checkpoint degraded to ${cp.kind}: ${cp.detail}`);
  }

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
      agent_notes: readAgentNotes(projectDir),
      checkpoint: cp,
      in_flight_at_seal: [...boundaries.entries()].map(([command, started_at]) => ({
        command,
        started_at,
      })),
    },
    tasks: { completed: [...tasksDone], in_progress: [...tasksOpen.values()] },
    agents: [...agents.values()],
    claude_supplied: {
      next_action: next?.text ?? null,
      next_action_at: next?.at ?? null,
      next_action_superseded: next?.superseded ?? null,
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
      ...(lostAgents(agents)
        ? [
            `${lostAgents(agents)} agent(s) were still running with nothing written down. ` +
              'Assume their work is lost and re-derive it; the "Agents" section says what each was asked to do.',
          ]
        : []),
      testStep(tests?.command ?? null),
      ...(tasksDone.size ? ['Do NOT redo anything listed under "completed".'] : []),
      next?.superseded
        ? 'The recorded next action is STALE — see the warning under it. Re-derive the next step from the work listed below before acting on it.'
        : 'Resume from "next action". If it is absent, re-derive it from in-progress work before editing.',
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

/** The best available answer to "what was happening?" when nobody said what should happen
 *  next. Ordered by how specific each signal is. */
function observedContinuation(m: Manifest): string[] {
  const out: string[] = [];
  for (const t of m.tasks.in_progress.slice(0, 3)) out.push(`task still open: ${t}`);
  for (const b of m.observed.in_flight_at_seal.slice(0, 2)) {
    out.push(`began and never seen to return: \`${b.command}\``);
  }
  for (const a of m.agents.filter((x) => x.status === 'IN_FLIGHT_AT_SEAL').slice(0, 3)) {
    out.push(
      `agent ${a.type} (${a.id}) was still running` +
        (a.description ? `, asked to: ${a.description}` : '') +
        ` — redo cost ${a.redo_cost_estimate}` +
        (a.notes_recorded ? ', notes recorded' : ', nothing written down'),
    );
  }
  const f = m.observed.files_touched;
  if (!out.length && f.length) {
    const newest = [...f].sort((a, b) => b.last_edit - a.last_edit)[0]!;
    out.push(`last file edited: ${newest.path}`);
  }
  if (m.observed.tests && m.observed.tests.ok === false) {
    out.push(`the recorded test run failed: \`${m.observed.tests.command}\``);
  }
  return out;
}

/** Coarse age in words. Minutes below 90, then hours, then days — a next action written
 *  yesterday and one written eight hours ago are different problems. */
export function ageWords(min: number): string {
  if (min < 90) return `${Math.max(1, Math.round(min))} minutes`;
  if (min < 60 * 48) return `${(min / 60).toFixed(1)} hours`;
  return `${Math.round(min / 60 / 24)} days`;
}

/** How long before the seal the next action was written. */
export function staleAge(m: Manifest): string {
  const at = m.claude_supplied.next_action_at;
  return at == null ? 'an unknown time' : ageWords((m.sealed_at - at) / 60);
}

export function describeSuperseded(s: { commits: number; files: number }): string {
  const parts: string[] = [];
  if (s.commits) parts.push(`${s.commits} commit${s.commits === 1 ? '' : 's'}`);
  if (s.files) parts.push(`${s.files} file edit${s.files === 1 ? '' : 's'}`);
  return parts.join(' and ') || 'later work';
}

/** Nothing observed and nothing said: a session that opened, idled and exited.
 *
 *  Its seal is a 400-byte digest, and `latest` is one file for the whole project — so such
 *  a seal used to overwrite the handoff of the session next door two minutes after it
 *  landed, leaving `/guardian resume` to offer a manifest with no files, no commits and no
 *  next action. Worth naming rather than scoring: an emptier-but-real handoff should still
 *  win on recency, an empty one never should. */
export function carriesNothing(m: Manifest): boolean {
  const o = m.observed;
  const c = m.claude_supplied;
  return (
    o.files_touched.length === 0 &&
    o.commits.length === 0 &&
    o.commands.length === 0 &&
    o.agent_notes.length === 0 &&
    o.in_flight_at_seal.length === 0 &&
    m.tasks.completed.length === 0 &&
    m.tasks.in_progress.length === 0 &&
    m.agents.length === 0 &&
    !m.objective &&
    !c.next_action &&
    c.open_decisions.length === 0 &&
    c.gotchas.length === 0
  );
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
  writeSeal(projectDir, m);
  return m;
}

/** Write a built manifest to disk: always to `history`, and to `latest` unless that would
 *  replace a real handoff with an empty one.
 *
 *  `latest` is project-wide, and every session seals on the way out — so the last session
 *  to exit wins the file regardless of whether it did any work. The rescue path in
 *  `readBestHandoff` exists because this guard did not, and history keeps the evidence
 *  either way. */
export function writeSeal(projectDir: string, m: Manifest): void {
  const stamp = m.sealed_at_iso.replace(/[:.]/g, '-');
  writeAtomic(
    projectDir,
    join(handoffDir(projectDir), 'history', `${stamp}.json`),
    `${JSON.stringify(m)}\n`,
  );

  const prev = readLatest(projectDir);
  const displaced =
    !prev ||
    prev.session.id === m.session.id ||
    !carriesNothing(m) ||
    carriesNothing(prev);

  if (displaced) {
    writeAtomic(projectDir, latestPath(projectDir), `${JSON.stringify(m, null, 2)}\n`);
    writeAtomic(projectDir, latestDigestPath(projectDir), renderDigest(m, projectDir));
  } else {
    // Failing open is not failing silently: the seal happened, and the reason it is not
    // the one on offer belongs in the log rather than in a later forensic dig.
    log(
      projectDir,
      'info',
      `seal ${stamp} (${m.seal_reason}) recorded nothing; kept latest from session ` +
        `${prev.session.id} (${prev.seal_reason}, ${prev.observed.files_touched.length} file(s), ` +
        `${prev.observed.commits.length} commit(s)). Archived at history/${stamp}.json.`,
    );
  }
  prune(projectDir);
}

/** How many sealed handoffs to keep. Enough that anything anyone would resume from is
 *  still there, and bounded, which matters now that a seal happens on every climb into LAND
 *  rather than once a session. */
const KEEP = 20;

/** Housekeeping, and never allowed to break a seal. Each checkpoint ref pins a whole tree,
 *  and a reachable ref is one `git gc` can never reclaim, so an unbounded set of them is a
 *  repository that grows for as long as Guardian stays installed. */
function prune(projectDir: string): void {
  try {
    const dir = join(handoffDir(projectDir), 'history');
    // Whatever `latest` points at survives pruning however old it is. A burst of short
    // sessions each seals once, and twenty of them would otherwise evict the archive copy
    // of the very handoff still on offer.
    const keep = readLatest(projectDir);
    const keepFile = keep ? `${keep.sealed_at_iso.replace(/[:.]/g, '-')}.json` : null;
    const stale = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort() // ISO stamps: oldest first
      .slice(0, -KEEP)
      .filter((f) => f !== keepFile);
    for (const f of stale) unlinkSync(join(dir, f));
  } catch {
    /* ignore */
  }
  try {
    pruneCheckpoints(projectDir, KEEP);
  } catch {
    /* ignore */
  }
}

function readManifestFile(p: string): Manifest | null {
  try {
    const m = JSON.parse(readFileSync(p, 'utf8')) as Manifest;
    if (m?.schema !== 1) return null;
    // Fields added after the first manifests were written. A handoff sealed by an older
    // build is still worth resuming from; it just cannot say how old its next action is.
    m.claude_supplied.next_action_at ??= null;
    m.claude_supplied.next_action_superseded ??= null;
    return m;
  } catch {
    return null;
  }
}

export function readLatest(projectDir: string): Manifest | null {
  return readManifestFile(latestPath(projectDir));
}

export interface HandoffRef {
  manifest: Manifest;
  /** The file this manifest was read from — where `consumed_at` has to be written back. */
  path: string;
  /** True when `latest` carried nothing and this came out of `history` instead. */
  rescued: boolean;
}

/** The best handoff on disk: `latest`, unless it records nothing and history holds one that
 *  does.
 *
 *  Guardian's own logs are how this was found: the real 108KB manifest sat in `history/`
 *  while `latest` held 397 bytes sealed by a session that had done nothing. The write guard
 *  in `writeSeal` stops that happening again; this reads past a clobber that already has,
 *  which includes every project carrying one today. */
export function readBestHandoff(projectDir: string): HandoffRef | null {
  const latest = readLatest(projectDir);
  if (latest && !carriesNothing(latest)) {
    return { manifest: latest, path: latestPath(projectDir), rescued: false };
  }

  const dir = join(handoffDir(projectDir), 'history');
  let names: string[] = [];
  try {
    names = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .reverse(); // ISO stamps: newest first
  } catch {
    /* no history: whatever latest holds is all there is */
  }
  for (const name of names) {
    const p = join(dir, name);
    const m = readManifestFile(p);
    if (!m || carriesNothing(m)) continue;
    return { manifest: m, path: p, rescued: true };
  }

  return latest ? { manifest: latest, path: latestPath(projectDir), rescued: false } : null;
}

export function markConsumed(projectDir: string, now: number): Manifest | null {
  const ref = readBestHandoff(projectDir);
  if (!ref) return null;
  ref.manifest.consumed_at = now;
  writeAtomic(projectDir, ref.path, `${JSON.stringify(ref.manifest, null, 2)}\n`);
  // Stamp the archive copy too. `consumed_at` lived only in `latest`, so a handoff resumed
  // from there and then displaced would be rescued out of history and offered a second
  // time as if nobody had ever read it.
  const twin = join(handoffDir(projectDir), 'history', `${ref.manifest.sealed_at_iso.replace(/[:.]/g, '-')}.json`);
  if (twin !== ref.path && existsSync(twin)) {
    writeAtomic(projectDir, twin, `${JSON.stringify(ref.manifest)}\n`);
  }
  // A rescued handoff has just been resumed from; make it the one on offer, so the next
  // reader does not have to go looking through history again.
  if (ref.rescued) {
    writeAtomic(projectDir, latestPath(projectDir), `${JSON.stringify(ref.manifest, null, 2)}\n`);
    writeAtomic(projectDir, latestDigestPath(projectDir), renderDigest(ref.manifest, projectDir));
  }
  return ref.manifest;
}

export function hasUnconsumed(projectDir: string): Manifest | null {
  const ref = readBestHandoff(projectDir);
  return ref && ref.manifest.consumed_at === null ? ref.manifest : null;
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
    const stale = m.claude_supplied.next_action_superseded;
    L.push(stale ? '## Next action — STALE' : '## Next action');
    L.push(m.claude_supplied.next_action);
    if (stale) {
      L.push('');
      L.push(
        `⚠ Written ${staleAge(m)} before this seal, and ${describeSuperseded(stale)} were ` +
          'recorded after it. It describes a state this session had already left. Treat it as ' +
          'background, re-derive the real next step from the sections below, and record the ' +
          'new one with `guardian note --next "..."`.',
      );
    }
    L.push('');
  } else {
    // An automatic seal happens before the model has said anything: intent is written in
    // response to the landing brief, and the seal is what preceded it. Guardian still knows
    // what was in flight, so the slot carries that instead of nothing -- labelled, because
    // an observation is not a stated intention and must never be read as one.
    const observed = observedContinuation(m);
    if (observed.length) {
      L.push('## Next action — NOT STATED');
      L.push('Nobody recorded one. What Guardian observed in flight, which is not the same');
      L.push('thing and may not be what should happen next:');
      for (const o of observed) L.push(`- ${o}`);
      L.push('');
    }
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
    // Each agent gets its own small handoff. The one thing the next session cannot recover
    // is an in-flight agent that wrote nothing down, so that is stated outright rather than
    // left to be inferred from a missing file.
    L.push('## Agents');
    for (const a of m.agents) {
      const flying = a.status === 'IN_FLIGHT_AT_SEAL';
      L.push(
        `- ${a.id} (${a.type}) — ${flying ? 'STILL RUNNING AT SEAL' : 'returned'}, ` +
          `redo cost ${a.redo_cost_estimate}`,
      );
      if (a.description) L.push(`  asked to: ${a.description}`);
      const vitals: string[] = [];
      if (a.elapsed_min !== null) vitals.push(`running ${fmtMin(a.elapsed_min)}`);
      if (a.context_pct !== null) vitals.push(`its own context ${a.context_pct.toFixed(0)}%`);
      if (vitals.length) L.push(`  ${vitals.join(', ')}`);
      if (a.summary) L.push(`  ${a.summary}`);
      if (a.notes_recorded && a.notes_file) L.push(`  notes: ${a.notes_file} (below)`);
      else if (flying) {
        L.push(
          `  ⚠ nothing written down${a.notes_file ? ` in ${a.notes_file}` : ''} — whatever this ` +
            `agent had established does not survive the seal; redo cost ${a.redo_cost_estimate}`,
        );
      }
    }
    L.push('');
  }

  // Verbatim, and last among the observed sections: this is the only place the handoff
  // carries an agent's own account of where it got to, and paraphrasing it would be
  // inventing progress. An agent cannot be restarted from where it stopped — but whoever
  // picks the work up does not have to rediscover what it already established.
  if (m.observed.agent_notes.length) {
    L.push('## What the agents wrote down');
    L.push('');
    L.push('Their own notes, kept as they worked. Read these before re-running any agent:');
    L.push('');
    for (const n of m.observed.agent_notes) {
      L.push(`### ${n.file}`);
      L.push(n.excerpt);
      L.push('');
    }
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
