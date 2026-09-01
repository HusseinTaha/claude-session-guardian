import {
  readFileSync,
  readdirSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  realpathSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import type { GuardianState } from '../types.ts';
import { loadConfig } from '../core/config.ts';
import { readLatest, verify, latestDigestPath, type Manifest } from '../handoff/manifest.ts';
import { listCheckpoints, isRepo } from '../handoff/git.ts';
import { readUserConfig, validateConfig } from './configCmd.ts';
import { userSettingsPath, stateDir, settingsChain, logPath } from '../core/paths.ts';
import { typeStats } from '../sensors/agents.ts';
import { readTail } from '../actuators/landing.ts';
import { probeChained } from '../sensors/statusline.ts';


export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
  /** What to do about it. Omitted when there is nothing to do. */
  fix?: string;
}

const MARK: Record<CheckStatus, string> = { pass: 'ok  ', warn: 'warn', fail: 'FAIL', skip: '--  ' };

/** Static audit. Costs nothing and answers the only question that matters about a handoff:
 *  if this session died right now, could a fresh one actually continue?
 *
 *  A handoff system that has never been checked is a handoff system that does not work, and
 *  the failure mode is silence — you find out at the worst possible moment. */
export function audit(
  projectDir: string,
  state: GuardianState | null,
  now: number,
  settingsFile = userSettingsPath(),
): Check[] {
  const checks: Check[] = [];
  const cfg = loadConfig(projectDir);

  // ---------------------------------------------------------------- installation
  // The status line that actually runs is the highest-precedence one, not the user's. A
  // project's own `statusLine` replaces it outright, so checking only the user file
  // reports a confident "points at Guardian" for a project where the sensor never runs —
  // which is the exact failure this check exists to catch.
  let statusLineCmd: string | null = null;
  let subagentCmd: string | null = null;
  let deciding = settingsFile;
  for (const file of settingsChain(projectDir, settingsFile)) {
    let settings: { statusLine?: { command?: string }; subagentStatusLine?: { command?: string } };
    try {
      settings = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      continue; // absent or malformed: it decides nothing
    }
    if (typeof settings.statusLine?.command === 'string') {
      statusLineCmd = settings.statusLine.command;
      deciding = file;
    }
    if (typeof settings.subagentStatusLine?.command === 'string') {
      subagentCmd = settings.subagentStatusLine.command;
    }
  }

  const senses = !!statusLineCmd?.includes('guardian.cjs');
  checks.push(
    senses
      ? { name: 'status line', status: 'pass', detail: 'points at Guardian' }
      : {
          name: 'status line',
          status: 'fail',
          detail: statusLineCmd
            ? `${deciding} points elsewhere: ${statusLineCmd}`
            : 'not configured',
          // `init` rather than `install`: whatever is winning here has to be taken over
          // where it is, and it may not be the user's settings file.
          fix: 'run `guardian init`, then restart Claude Code',
        },
  );
  checks.push(
    subagentCmd?.includes('guardian.cjs')
      ? { name: 'agent rows', status: 'pass', detail: 'per-agent sensing is wired' }
      : {
          name: 'agent rows',
          status: 'warn',
          detail: 'subagentStatusLine not set; per-agent context and pace are unavailable',
          fix: 'run `guardian init`',
        },
  );

  if (cfg.statusline.manage && cfg.statusline.chain_existing) {
    const probe = probeChained(projectDir, cfg);
    const failures = recentChainFailures(projectDir, now);
    if (probe.cmd) {
      checks.push(
        probe.ok && failures === 0
          ? { name: 'chained bar', status: 'pass', detail: 'the status line Guardian chained still runs' }
          : probe.ok
            ? {
                name: 'chained bar',
                status: 'warn',
                detail: `runs here, but was dropped ${failures} time(s) in the last 6h of real ticks`,
                fix: 'see `guardian log`; the segment is missing from the bar whenever that happens',
              }
            : {
              name: 'chained bar',
              status: 'warn',
              detail: `produced nothing when run: ${probe.cmd}`,
              fix: 'see `guardian log`; the segment is silently missing from every tick',
            },
      );
      if (!cfg.statusline.chained_from) {
        checks.push({
          name: 'chain source',
          status: 'warn',
          detail: 'chained_command is a snapshot and chained_from is unset, so later edits to that command never reach Guardian',
          fix: 'run `guardian init` to re-read it live',
        });
      }
    }
  }

  checks.push(
    cfg.enabled
      ? { name: 'enabled', status: 'pass', detail: 'Guardian is active for this project' }
      : {
          name: 'enabled',
          status: 'fail',
          detail: 'disabled by config; Guardian is silent',
          fix: 'run `guardian on`',
        },
  );

  const problems = validateConfig(readUserConfig(projectDir));
  const errs = problems.filter((p) => p.severity === 'error');
  checks.push(
    errs.length
      ? {
          name: 'config',
          status: 'fail',
          detail: errs.map((p) => `${p.path}: ${p.message}`).join('; '),
          fix: 'run `guardian config check`',
        }
      : problems.length
        ? {
            name: 'config',
            status: 'warn',
            detail: problems.map((p) => `${p.path}: ${p.message}`).join('; '),
          }
        : { name: 'config', status: 'pass', detail: 'valid' },
  );

  // ---------------------------------------------------------------- sensor health
  if (!state) {
    checks.push({
      name: 'sensor',
      status: 'fail',
      detail: 'no session state; the status line has never run here',
      fix: 'restart Claude Code after installing',
    });
  } else {
    const age = (now - state.updated_at) / 60;
    checks.push(
      state.samples.length === 0
        ? {
            name: 'sensor',
            status: 'warn',
            detail: 'state exists but holds no samples yet',
          }
        : {
            name: 'sensor',
            status: age > 60 ? 'warn' : 'pass',
            detail: `${state.samples.length} sample(s), last updated ${age < 1 ? 'just now' : `${Math.round(age)}m ago`}`,
          },
    );

    const hasRateLimits = state.axes.five_hour || state.axes.seven_day;
    checks.push(
      hasRateLimits
        ? { name: 'rate limits', status: 'pass', detail: 'account usage is being reported' }
        : {
            name: 'rate limits',
            status: 'warn',
            detail: 'no rate_limits in the payload; only the context window is tracked',
            fix: 'this is expected outside Claude.ai Pro and Max plans',
          },
    );

    const measurable = Object.values(state.axes).some((a) => a?.burn_pct_per_min !== null);
    checks.push({
      name: 'burn rate',
      status: measurable ? 'pass' : 'warn',
      detail: measurable
        ? 'measurable, so time-to-wall is real'
        : 'not yet measurable; percentage floors are guarding instead',
    });
  }

  // ---------------------------------------------------------------- the handoff itself
  const m = readLatest(projectDir);
  if (!m) {
    checks.push({
      name: 'handoff',
      status: 'fail',
      detail: 'no manifest has ever been sealed in this project',
      fix: 'run `guardian handoff` — until then a lost session loses its work',
    });
    return checks;
  }

  const sealedAgo = (now - m.sealed_at) / 60;
  const ago = sealedAgo < 1 ? 'just now' : `${Math.round(sealedAgo)}m ago`;
  // A manifest is a photograph, and the audit below reads it as if it were the state of
  // play. Count what has been recorded since, or doctor reports a finished plan as the
  // thing to do next -- confidently, which is the failure mode that costs the most.
  // Minutes of work recorded AFTER the seal, in any session: a resumed project seals under
  // one session id and goes on working under another, so asking only the sealed session's
  // ledger reports a fresh manifest for a session that has moved on for hours.
  const since = Math.max(0, (newestActivity(projectDir) - m.sealed_at) / 60);
  checks.push({
    name: 'handoff',
    status: since > 0 ? 'warn' : 'pass',
    detail:
      since > 0
        ? `sealed ${ago} — ${m.seal_reason}; work recorded ${Math.round(since)}m later, so everything below is that stale`
        : `sealed ${ago} — ${m.seal_reason}`,
    ...(since > 0 ? { fix: 'run `guardian handoff` to seal the current state' } : {}),
  });

  checks.push(...auditManifest(projectDir, m));
  return checks;
}

/** When work was last recorded in this project, in ANY session. Only the tail of each
 *  ledger is read: the newest event is the last line, and doctor should not parse megabytes
 *  to answer "has anything happened since?". */
function newestActivity(projectDir: string): number {
  let newest = 0;
  try {
    const dir = join(stateDir(projectDir), 'sessions');
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.ledger.jsonl')) continue;
      const lines = readTail(join(dir, f), 64 * 1024).split(String.fromCharCode(10));
      for (let i = lines.length - 1; i >= 0; i--) {
        const l = lines[i]!.trim();
        if (!l.startsWith('{')) continue;
        try {
          const t = (JSON.parse(l) as { t?: number }).t;
          if (typeof t === 'number' && Number.isFinite(t)) newest = Math.max(newest, t);
        } catch {
          continue; // a half-written tail line: keep looking backwards
        }
        break;
      }
    }
  } catch {
    /* no sessions directory yet */
  }
  return newest;
}

/** How often Guardian has had to drop the chained status line lately. The probe runs the
 *  command once, with a synthetic payload, from doctor's cwd — which is not enough: the
 *  failures seen in practice were payload- and environment-specific, and the log is the
 *  only record of what actually happened on a tick. */
function recentChainFailures(projectDir: string, now: number): number {
  try {
    const lines = readFileSync(logPath(projectDir), 'utf8').split('\n').slice(-400);
    let n = 0;
    for (const l of lines) {
      if (!l.includes('chained status line produced nothing')) continue;
      const t = Date.parse(l.slice(0, 24));
      if (Number.isFinite(t) && (now - t / 1000) / 3600 < 6) n++;
    }
    return n;
  } catch {
    return 0;
  }
}

/** The completeness checks. Each one corresponds to something a resuming session would
 *  otherwise have to rediscover, guess at, or get wrong. */
export function auditManifest(projectDir: string, m: Manifest): Check[] {
  const checks: Check[] = [];

  checks.push(
    m.claude_supplied.next_action
      ? { name: 'next action', status: 'pass', detail: `"${m.claude_supplied.next_action}"` }
      : {
          name: 'next action',
          status: 'fail',
          detail: 'absent — the resuming session has to guess where to start',
          fix: 'guardian note --next "<the single most specific next step>"',
        },
  );

  checks.push(
    m.objective
      ? { name: 'objective', status: 'pass', detail: m.objective }
      : {
          name: 'objective',
          status: 'warn',
          detail: 'absent; the resuming session knows the steps but not the goal',
          fix: 'guardian note --objective "..."',
        },
  );

  const files = m.observed.files_touched;
  const hashed = files.filter((f) => f.sha256).length;
  checks.push(
    files.length === 0
      ? { name: 'files', status: 'warn', detail: 'no file edits recorded this session' }
      : {
          name: 'files',
          status: hashed === files.length ? 'pass' : 'warn',
          detail: `${files.length} tracked, ${hashed} verifiable by hash`,
        },
  );

  if (files.length) {
    const v = verify(projectDir, m);
    const changed = v.files.filter((f) => f.status === 'changed').length;
    const missing = v.files.filter((f) => f.status === 'missing').length;
    checks.push(
      changed || missing
        ? {
            name: 'workspace',
            status: 'warn',
            detail: `${changed} file(s) changed and ${missing} missing since the seal`,
            fix: 'expected if work continued; reconcile on resume',
          }
        : { name: 'workspace', status: 'pass', detail: 'matches the sealed manifest' },
    );
  }

  checks.push(
    m.observed.tests
      ? {
          name: 'test baseline',
          status: m.observed.tests.ok === false ? 'warn' : 'pass',
          detail: `\`${m.observed.tests.command}\` — ${
            m.observed.tests.ok === null ? 'result unclear' : m.observed.tests.ok ? 'passing' : 'FAILING at seal time'
          }`,
        }
      : {
          name: 'test baseline',
          status: 'warn',
          detail: 'no test command recorded; the resuming session cannot confirm the starting state',
        },
  );

  const cp = m.observed.checkpoint;
  if (!isRepo(projectDir)) {
    checks.push({
      name: 'checkpoint',
      status: 'skip',
      detail: 'not a git repository; only hashes and a file list are recoverable',
    });
  } else if (cp?.kind === 'ref' || cp?.kind === 'stash') {
    const live = listCheckpoints(projectDir).includes(cp.ref ?? '');
    checks.push(
      live
        ? { name: 'checkpoint', status: 'pass', detail: `${cp.ref} (\`git show ${cp.sha?.slice(0, 8)}\`)` }
        : {
            name: 'checkpoint',
            status: 'fail',
            detail: `${cp.ref} is recorded but no longer exists`,
            fix: 'the ref was deleted; uncommitted work at seal time is not recoverable',
          },
    );
  } else {
    checks.push({
      name: 'checkpoint',
      status: 'warn',
      detail: cp?.detail ?? 'no checkpoint recorded',
    });
  }

  if (m.observed.in_flight_at_seal.length) {
    checks.push({
      name: 'in flight',
      status: 'warn',
      detail: `${m.observed.in_flight_at_seal.length} irreversible operation(s) started and never seen to return`,
      fix: 'verify their state before trusting the workspace',
    });
  }

  const stranded = m.agents.filter((a) => a.status === 'IN_FLIGHT_AT_SEAL');
  if (stranded.length) {
    checks.push({
      name: 'agents',
      status: 'warn',
      detail: `${stranded.length} subagent(s) were still running at seal time; their work is lost`,
      fix: 'they are recorded but not resumable — re-run if needed',
    });
  }

  const digestExists = existsSync(latestDigestPath(projectDir));
  checks.push(
    digestExists
      ? { name: 'digest', status: 'pass', detail: 'the injectable summary exists' }
      : { name: 'digest', status: 'fail', detail: 'latest.md is missing', fix: 're-seal with `guardian handoff`' },
  );

  return checks;
}

export function renderChecks(checks: Check[]): string {
  const L: string[] = [];
  for (const c of checks) {
    L.push(`  [${MARK[c.status]}] ${c.name.padEnd(14)} ${c.detail}`);
    if (c.fix) L.push(`${' '.repeat(23)}→ ${c.fix}`);
  }
  return L.join('\n');
}

export function verdict(checks: Check[]): { text: string; resumable: boolean } {
  const fails = checks.filter((c) => c.status === 'fail');
  const warns = checks.filter((c) => c.status === 'warn');
  if (fails.length) {
    return {
      resumable: false,
      text:
        `NOT RESUMABLE — ${fails.length} problem(s) would stop a fresh session from ` +
        `continuing this work. Fix the FAIL lines above.`,
    };
  }
  if (warns.length) {
    return {
      resumable: true,
      text: `RESUMABLE with gaps — ${warns.length} thing(s) a fresh session would have to rediscover.`,
    };
  }
  return { resumable: true, text: 'RESUMABLE — a fresh session has everything it needs.' };
}

// ------------------------------------------------------------------ the cold resume

export interface ColdResult {
  ok: boolean;
  detail: string;
  answer?: string;
  namedAFile?: boolean;
  echoedNextAction?: boolean;
  worktree?: string;
}

/** Proof the prompt survived the trip. Without it a cold session that received nothing
 *  still answers something, and an answer is all the keyword checks need to see. */
const COLD_MARKER = 'HANDOFF-READ';

const COLD_PROMPT = [
  `Begin your reply with the token ${COLD_MARKER}.`,
  'Read .claude/guardian/handoff/latest.md and nothing else. Do not explore the codebase.',
  'Answer in at most 120 words:',
  '1. What is the single next action?',
  '2. Which file paths would you touch first?',
  '3. What can you NOT determine from the handoff alone?',
].join(' ');

/** Windows hands out 8.3 short paths for the temp directory; a cold session refuses to
 *  read through one. Resolve to the long form where the path exists. */
function realNative(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

/** Test the parachute.
 *
 *  Everything else in Guardian is checked by its own tests. This checks the thing none of
 *  them can: whether a model that has never seen this session can actually pick the work up
 *  from the manifest. It is deliberately opt-in — it spends real budget. */
export function coldResume(
  projectDir: string,
  m: Manifest,
  opts: { keep?: boolean; timeoutMs?: number } = {},
): ColdResult {
  const ref = m.observed.checkpoint?.ref;
  if (!isRepo(projectDir)) {
    return { ok: false, detail: 'not a git repository, so there is no checkpoint to resume from' };
  }
  if (!ref || !listCheckpoints(projectDir).includes(ref)) {
    return { ok: false, detail: 'the manifest has no live checkpoint ref to build a worktree from' };
  }

  // Long form, not the 8.3 short path Windows hands out for the temp directory: a cold
  // session refuses to read through `HUSSEI~1.AZU` as a suspicious path pattern, and
  // non-interactively there is nobody to approve it.
  const wt = realNative(mkdtempSync(join(tmpdir(), 'guardian-cold-')));
  const dir = join(wt, 'tree');
  try {
    const add = spawnSync('git', ['worktree', 'add', '--detach', dir, ref], {
      cwd: projectDir,
      encoding: 'utf8',
      timeout: 60_000,
      windowsHide: true,
    });
    if (add.status !== 0) {
      return { ok: false, detail: `git worktree add failed: ${(add.stderr ?? '').trim()}` };
    }

    // The checkpoint deliberately excludes Guardian's own state, so the digest has to be
    // placed into the worktree explicitly. That is also the point: the cold session sees
    // the handoff and the code, and nothing else about the session that produced them.
    const digestDest = join(dir, '.claude', 'guardian', 'handoff', 'latest.md');
    mkdirSync(dirname(digestDest), { recursive: true });
    writeFileSync(digestDest, readFileSync(latestDigestPath(projectDir), 'utf8'));

    // The prompt goes on stdin, never in argv. `claude` is a .cmd shim on Windows, so this
    // needs a shell — and a shell concatenates arguments without escaping them, which split
    // the prompt on its spaces and delivered `-p` the single word "Read". The cold session
    // then answered the question "Read", and every check downstream scored that answer as
    // though the handoff had been read. Single-token flags are safe to pass as argv.
    const run = spawnSync('claude', ['-p', '--allowedTools', 'Read'], {
      cwd: dir,
      input: COLD_PROMPT,
      encoding: 'utf8',
      timeout: opts.timeoutMs ?? 240_000,
      windowsHide: true,
      shell: process.platform === 'win32',
    });
    if (run.error || run.status !== 0) {
      return {
        ok: false,
        detail: `claude -p did not complete: ${run.error?.message ?? ((run.stderr ?? '').trim() || `exit ${run.status}`)}`,
        worktree: dir,
      };
    }

    const answer = (run.stdout ?? '').trim();
    if (!answer.includes(COLD_MARKER)) {
      return {
        ok: false,
        detail:
          'the prompt never reached the cold session — it replied without the marker, so its ' +
          'answer says nothing about the handoff',
        answer,
        worktree: dir,
      };
    }
    return {
      ok: true,
      detail: 'a cold session read the handoff and answered',
      answer,
      namedAFile: namedARecordedFile(answer, m, projectDir),
      echoedNextAction: echoedNextAction(answer, m),
      worktree: dir,
    };
  } finally {
    if (!opts.keep) {
      spawnSync('git', ['worktree', 'remove', '--force', dir], {
        cwd: projectDir,
        timeout: 30_000,
        windowsHide: true,
      });
      try {
        rmSync(wt, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

function namedARecordedFile(answer: string, m: Manifest, projectDir: string): boolean {
  const hay = answer.toLowerCase();
  return m.observed.files_touched.some((f) => {
    const rel = relative(projectDir, f.path).replace(/\\/g, '/').toLowerCase();
    const base = rel.split('/').pop() ?? '';
    return base.length > 3 && hay.includes(base);
  });
}

/** Deliberately mechanical. Guardian does not claim to grade the answer's meaning — the
 *  point of printing it is that a person can judge that far better than a keyword check. */
function echoedNextAction(answer: string, m: Manifest): boolean {
  const next = m.claude_supplied.next_action;
  if (!next) return false;
  const words = next
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((w) => w.length > 4);
  if (!words.length) return false;
  const hay = answer.toLowerCase();
  const hits = words.filter((w) => hay.includes(w)).length;
  return hits / words.length >= 0.4;
}

export function logTail(projectDir: string, lines = 40): string {
  try {
    const raw = readFileSync(join(stateDir(projectDir), 'logs', 'guardian.log'), 'utf8');
    const all = raw.split('\n').filter(Boolean);
    return all.slice(-lines).join('\n') || '(log is empty)';
  } catch {
    return '(no log; nothing has failed, since every hook fails open silently)';
  }
}

export function agentSummary(projectDir: string): string {
  const stats = typeStats(projectDir);
  const entries = Object.entries(stats);
  if (!entries.length) return 'no completed agents recorded';
  return entries.map(([t, s]) => `${t} ~${Math.round(s.median_s / 60)}m (n=${s.count})`).join(', ');
}
