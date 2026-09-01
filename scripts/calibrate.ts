/**
 * Calibrate burn.alpha and burn.window_min against real transcripts.
 *
 * The plan left this open: "too twitchy and Guardian cries wolf, too smooth and it misses
 * a sudden fan-out spike." That is an empirical question, and the answer is sitting in
 * ~/.claude/projects -- every session ever run on this machine, with per-message token
 * usage and 429 tombstones marking where the wall actually was.
 *
 * The statusLine payload Guardian senses is not recorded anywhere, so it is reconstructed:
 *
 *   context   exact. Context fill IS input + cache_creation + cache_read for a message,
 *             which is what context_window.used_percentage reports.
 *   five_hour a rolling 5h sum of weighted token cost across every transcript on the
 *             machine, subagents included: the budget is per account, so a session cannot
 *             see most of what is being spent against it. The real weighting is not public, so the capacity
 *             constant is solved for from the observed 429s and its spread is reported --
 *             a tight spread means the cost model tracks reality, a wide one means it does
 *             not and the five_hour levels should be read as shape only.
 *
 * The headline metric needs none of that scale, which is what makes it trustworthy:
 * predicted burn rate is compared against the burn rate that actually followed, and a
 * relative error is invariant under any linear rescaling of the percentage axis.
 *
 * Usage:  node --experimental-strip-types scripts/calibrate.ts [--projects DIR] [--quick]
 *         [--alphas A,..] [--windows M,..] [--samples N,..] [--tick S] [--diagnose]
 *         [--per-session]
 *         [--json OUT]
 */
import { readdirSync, statSync, createReadStream, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { DEFAULT_CONFIG } from '../src/core/config.ts';
import { rawBurnRate, smooth, recordSample, spacingS } from '../src/budget/burn.ts';
import { timeToWall, axisMode, severity } from '../src/budget/mode.ts';
import { MODES, type AxisState, type GuardianConfig, type Mode, type Sample } from '../src/types.ts';

const args = process.argv.slice(2);
const flag = (n: string, d: string | null = null): string | null => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1]! : d;
};
const QUICK = args.includes('--quick');
const DIAGNOSE = args.includes('--diagnose');
// The 5-hour budget is per account, so every transcript on the machine is summed by
// default. --per-session reverts to one transcript's own turns, which is what the first
// version of this harness did and why its cost model had a 51% spread instead of 32%.
const ACCOUNT = !args.includes('--per-session');
const PROJECTS = flag('--projects', join(homedir(), '.claude', 'projects'))!;
const JSON_OUT = flag('--json');
const MIN_BYTES = 400_000;
const FIVE_H = 5 * 3600;
// refreshInterval: the status line re-runs on a timer while idle, and faster than that
// while a turn is streaming. --tick models the busier cadence, which is the one the
// sample thinning has to survive.
const TICK_S = Number(flag('--tick', '10'));
const HORIZON_MIN = 5; // how far ahead a burn estimate is implicitly a claim about

/** One assistant turn's token spend. */
interface Ev {
  t: number;
  inp: number;
  cc: number;
  cr: number;
  out: number;
  sub: boolean;
}
interface Wall {
  t: number;
  resetsAt: number | null;
  kind: string;
}
interface Sess {
  project: string;
  id: string;
  hours: number;
  ev: Ev[];
  walls: Wall[];
  subFiles: number;
}

/** Consecutive 429s minutes apart are one wall hit repeatedly, not several walls: the
 *  first tombstone is the event, the rest are retries against a window that is already
 *  closed. Counting them separately counts the same miss over and over. */
const WALL_CLUSTER_S = 1800;
function wallEvents(s: Sess): Wall[] {
  const out: Wall[] = [];
  for (const w of s.walls.filter((x) => x.kind === 'five_hour').sort((a, b) => a.t - b.t)) {
    const prev = out[out.length - 1];
    if (!prev || w.t - prev.t > WALL_CLUSTER_S) out.push(w);
  }
  return out;
}

const epoch = (s: string): number | null => {
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms / 1000 : null;
};

async function readTranscript(path: string, sub: boolean): Promise<{ ev: Ev[]; walls: Wall[] }> {
  const ev: Ev[] = [];
  const walls: Wall[] = [];
  const rl = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    // Cheap prefilter: most lines are neither, and JSON.parse over 700 MB is the cost.
    if (!line.includes('"usage"') && !line.includes('quotaLimits')) continue;
    let o: Record<string, any>;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const t = epoch(o.timestamp || '');
    if (t === null) continue;
    const q = o.quotaLimits;
    if (q && q.status === 'rejected') {
      walls.push({
        t,
        resetsAt: typeof q.resetsAt === 'number' ? q.resetsAt : null,
        kind: q.rateLimitType || 'unknown',
      });
    }
    const u = o.message?.usage;
    if (u && o.type === 'assistant') {
      ev.push({
        t,
        inp: u.input_tokens || 0,
        cc: u.cache_creation_input_tokens || 0,
        cr: u.cache_read_input_tokens || 0,
        out: u.output_tokens || 0,
        sub,
      });
    }
  }
  return { ev, walls };
}

async function loadSessions(): Promise<Sess[]> {
  if (!existsSync(PROJECTS)) throw new Error(`no transcripts at ${PROJECTS}`);
  const out: Sess[] = [];
  for (const proj of readdirSync(PROJECTS)) {
    const pdir = join(PROJECTS, proj);
    let entries: string[];
    try {
      if (!statSync(pdir).isDirectory()) continue;
      entries = readdirSync(pdir);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.endsWith('.jsonl')) continue;
      const main = join(pdir, f);
      let size = 0;
      try {
        size = statSync(main).size;
      } catch {
        continue;
      }
      if (size < MIN_BYTES) continue; // too small to carry a usage curve
      const id = f.slice(0, -6);
      const got = await readTranscript(main, false);
      let ev = got.ev;
      const walls = got.walls;
      let subFiles = 0;
      // Subagent spend counts against the account, and fan-out is the spike case that
      // matters most here, so it has to be folded into the same timeline.
      const subdir = join(pdir, id, 'subagents');
      if (existsSync(subdir)) {
        for (const s of readdirSync(subdir)) {
          if (!s.endsWith('.jsonl')) continue;
          const r = await readTranscript(join(subdir, s), true);
          if (r.ev.length) {
            subFiles++;
            ev = ev.concat(r.ev);
          }
          walls.push(...r.walls);
        }
      }
      if (ev.length < 40) continue;
      ev.sort((a, b) => a.t - b.t);
      walls.sort((a, b) => a.t - b.t);
      // One wall retried a dozen times is still one wall.
      const ded: Wall[] = [];
      for (const w of walls) if (!ded.length || w.t - ded[ded.length - 1]!.t > 60) ded.push(w);
      out.push({
        project: proj,
        id,
        hours: (ev[ev.length - 1]!.t - ev[0]!.t) / 3600,
        ev,
        walls: ded,
        subFiles,
      });
    }
  }
  return out;
}

/** Weighted token cost of one turn. Cache reads are billed far below fresh input and
 *  output far above it, so a flat sum would misstate the shape of the curve badly. */
interface Weights {
  name: string;
  cr: number;
  out: number;
}
const WEIGHTINGS: Weights[] = [
  { name: 'cr=0.1 out=5', cr: 0.1, out: 5 },
  { name: 'cr=0.08 out=1', cr: 0.08, out: 1 },
  { name: 'cr=1.0 out=1', cr: 1.0, out: 1 },
];
const cost = (e: Ev, w: Weights): number => e.inp + e.cc + w.cr * e.cr + w.out * e.out;

/** The account's whole rolling five-hour spend, not just this session's.
 *
 *  The 5-hour budget is per account: every session running against it in the same window
 *  draws on the same pool, and a transcript can only see its own turns. Summing across
 *  every transcript on the machine is the closest an offline reconstruction can get to
 *  what the API was actually counting. Built once, queried by binary search. */
class AccountSpend {
  private readonly t: Float64Array;
  private readonly cum: Float64Array;
  constructor(ev: Ev[], w: Weights) {
    const sorted = ev.slice().sort((a, b) => a.t - b.t);
    this.t = new Float64Array(sorted.length);
    this.cum = new Float64Array(sorted.length + 1);
    for (let i = 0; i < sorted.length; i++) {
      this.t[i] = sorted[i]!.t;
      this.cum[i + 1] = this.cum[i]! + cost(sorted[i]!, w);
    }
  }
  /** Index of the first event strictly after `x`. */
  private upper(x: number): number {
    let lo = 0;
    let hi = this.t.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.t[mid]! <= x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
  at(t: number): number {
    return this.cum[this.upper(t)]! - this.cum[this.upper(t - FIVE_H)]!;
  }
  series(ticks: number[]): number[] {
    return ticks.map((t) => this.at(t));
  }
}

/** Rolling five-hour weighted spend, evaluated at each tick. */
function fiveHourSeries(ev: Ev[], w: Weights, ticks: number[]): number[] {
  const c = ev.map((e) => cost(e, w));
  let lo = 0;
  let hi = 0;
  let sum = 0;
  const out: number[] = [];
  for (const t of ticks) {
    while (hi < ev.length && ev[hi]!.t <= t) {
      sum += c[hi]!;
      hi++;
    }
    while (lo < hi && ev[lo]!.t < t - FIVE_H) {
      sum -= c[lo]!;
      lo++;
    }
    out.push(sum);
  }
  return out;
}

/** Context fill: the main session's latest assistant turn, as a percent of its window. */
function contextSeries(ev: Ev[], ticks: number[]): (number | null)[] {
  const main = ev.filter((e) => !e.sub);
  const totals = main.map((e) => e.inp + e.cc + e.cr);
  const peak = totals.length ? Math.max(...totals) : 0;
  const win = peak > 190_000 ? 1_000_000 : 200_000;
  let i = 0;
  let cur: number | null = null;
  const out: (number | null)[] = [];
  for (const t of ticks) {
    while (i < main.length && main[i]!.t <= t) {
      cur = (totals[i]! / win) * 100;
      i++;
    }
    out.push(cur);
  }
  return out;
}

const cfgWith = (alpha: number, windowMin: number, maxSamples: number): GuardianConfig => ({
  ...DEFAULT_CONFIG,
  burn: { ...DEFAULT_CONFIG.burn, alpha, window_min: windowMin, max_samples: maxSamples },
});

/** Why a real 429 arrived with no LAND warning. Tuning cannot fix any of these; they are
 *  properties of what was observable at the time, which is the point of naming them. */
interface WallDiag {
  session: string;
  ageMin: number; // how long the session had been running when the wall hit
  usedPct: number | null;
  burn: number | null;
  ttwMin: number | null;
  mode: Mode;
  peak: Mode; // worst mode reached in the hour before
  leadMin: number | null; // null when never warned
  reason: string; // '' when warned
}

interface Score {
  errs: number[]; // relative error, predicted burn vs the burn that followed
  flips: number; // ladder direction reversals -- the "crying wolf" failure
  measurable: number; // ticks where a rate could be computed at all
  ticks: number;
  leads: number[]; // minutes of LAND-or-worse warning before a real 429
  missed: number; // real 429s that arrived with no warning
  falseLand: number; // LAND episodes not followed by a wall
}

const newScore = (): Score => ({
  errs: [],
  flips: 0,
  measurable: 0,
  ticks: 0,
  leads: [],
  missed: 0,
  falseLand: 0,
});

/** Replay one session tick by tick through the real estimator. */
function replay(
  s: Sess,
  w: Weights,
  capacity: number,
  alpha: number,
  windowMin: number,
  maxSamples: number,
  sc: Score,
  diag: WallDiag[] | null = null,
  acct: AccountSpend | null = null,
): void {
  const cfg = cfgWith(alpha, windowMin, maxSamples);
  const t0 = s.ev[0]!.t;
  const t1 = s.ev[s.ev.length - 1]!.t;
  const ticks: number[] = [];
  for (let t = t0; t <= t1; t += TICK_S) ticks.push(t);
  if (ticks.length < 10) return;

  const fh = acct ? acct.series(ticks) : fiveHourSeries(s.ev, w, ticks);
  const ctx = contextSeries(s.ev, ticks);

  // Fixed 5h windows anchored on a real observed reset where one exists, so resets_at is
  // measured rather than assumed. With no tombstone the axis gets no reset clock at all,
  // which is exactly what an account that does not report rate_limits looks like.
  const anchor = s.walls.find((x) => x.resetsAt)?.resetsAt ?? null;
  const resetAt = (t: number): number | null => {
    if (anchor === null) return null;
    return anchor + Math.ceil((t - anchor) / FIVE_H) * FIVE_H;
  };

  let samples: Sample[] = [];
  let smFh: number | null = null;
  let smCtx: number | null = null;
  let prevSev: number | null = null;
  let lastSign = 0;
  let landStart: number | null = null;
  // Intervals, not start times. An episode that began two hours before the wall and was
  // still running when it hit is a warning that never stopped, and the old scoring --
  // which kept only the start and required it inside the last hour -- called that a miss.
  const landIntervals: Array<[number, number]> = [];
  const events = wallEvents(s);
  const snap = new Map<number, { used: number | null; burn: number | null; ttw: number | null; sev: number; peak: number }>();

  for (let i = 0; i < ticks.length; i++) {
    const t = ticks[i]!;
    // Percentages arrive rounded in the payload, and that quantisation noise is precisely
    // what the smoothing has to survive, so it is modelled rather than idealised away.
    const fhPct = capacity > 0 ? Math.round(Math.min(100, (fh[i]! / capacity) * 100)) : null;
    const cPct = ctx[i] === null ? null : Math.round(Math.min(100, ctx[i]!));
    samples = recordSample(samples, { t, five_hour: fhPct, context: cPct } as Sample, cfg);

    smFh = smooth(rawBurnRate(samples, 'five_hour', cfg, t), smFh, alpha);
    smCtx = smooth(rawBurnRate(samples, 'context', cfg, t), smCtx, alpha);

    sc.ticks++;
    if (smFh !== null) sc.measurable++;

    // --- headline metric: did the predicted slope match the slope that followed?
    const j = i + (HORIZON_MIN * 60) / TICK_S;
    if (smFh !== null && j < ticks.length && fhPct !== null && capacity > 0) {
      const future = Math.min(100, (fh[j]! / capacity) * 100);
      const realised = (future - fhPct) / HORIZON_MIN;
      // Only score where something actually happened; dividing by a flat stretch would
      // manufacture enormous relative errors out of an idle session.
      if (realised > 0.02) sc.errs.push(Math.abs(smFh - realised) / realised);
    }

    // --- twitchiness and warning quality
    const st: AxisState = {
      used_pct: fhPct,
      burn_pct_per_min: smFh,
      resets_at: resetAt(t),
      time_to_wall_min: timeToWall(fhPct, smFh, resetAt(t), t, cfg.burn.reset_margin_min),
      mode: 'NORMAL',
    } as AxisState;
    const sev = severity(axisMode('five_hour', st, cfg));
    if (diag) {
      for (const wl of events) {
        if (t <= wl.t && wl.t < t + TICK_S) {
          snap.set(wl.t, { used: fhPct, burn: smFh, ttw: st.time_to_wall_min, sev, peak: sev });
        }
        // Worst the ladder reached in the hour before, so a miss can be told apart from a
        // near miss that stalled at WATCH.
        if (t <= wl.t && wl.t - t < 3600) {
          const cur = snap.get(wl.t);
          if (cur) cur.peak = Math.max(cur.peak, sev);
          else snap.set(wl.t, { used: null, burn: null, ttw: null, sev: -1, peak: sev });
        }
      }
    }
    if (prevSev !== null && sev !== prevSev) {
      const sign = Math.sign(sev - prevSev);
      if (lastSign !== 0 && sign !== lastSign) sc.flips++;
      lastSign = sign;
    }
    prevSev = sev;

    const landing = sev >= severity('LAND');
    if (landing && landStart === null) landStart = t;
    if (!landing && landStart !== null) {
      landIntervals.push([landStart, t]);
      landStart = null;
    }
  }
  const lastTick = ticks[ticks.length - 1]!;
  if (landStart !== null) landIntervals.push([landStart, lastTick]);

  for (const wl of events) {
    // Warned if an episode was still running when the wall hit, or ended within the hour
    // before it. Either way the lead is measured from when the warning started.
    const relevant = landIntervals.filter(
      ([a, b]) => (a <= wl.t && wl.t <= b + TICK_S) || (b <= wl.t && wl.t - b < 3600),
    );
    const lead = relevant.length ? (wl.t - Math.min(...relevant.map(([a]) => a))) / 60 : null;
    if (lead === null) sc.missed++;
    else sc.leads.push(lead);

    if (!diag) continue;
    const sn = snap.get(wl.t);
    const covered = wl.t <= lastTick + TICK_S;
    diag.push({
      session: `${s.project}/${s.id.slice(0, 8)}`,
      ageMin: (wl.t - t0) / 60,
      usedPct: sn?.used ?? null,
      burn: sn?.burn ?? null,
      ttwMin: sn?.ttw ?? null,
      mode: sn && sn.sev >= 0 ? MODES[sn.sev]! : 'NORMAL',
      peak: sn ? MODES[sn.peak]! : 'NORMAL',
      leadMin: lead,
      reason:
        lead !== null
          ? ''
          : !covered
            ? 'session transcript ends before the wall — nothing left to sense with'
            : sn === undefined
              ? 'no tick landed on the wall — session idle through it'
              : sn.burn === null
                ? 'burn unmeasurable — no movement to extrapolate from'
                : sn.used !== null && sn.used < 90
                  ? `reconstructed level only ${sn.used}% — the cost model, not the estimator`
                  : `blind spot — sat at ${MODES[sn.peak]} with ${sn.burn.toFixed(2)} %/min`,
    });
  }
  for (const [a] of landIntervals) {
    if (!events.some((wl) => wl.t >= a && wl.t - a < 3600)) sc.falseLand++;
  }
}

const pct = (a: number[], p: number): number => {
  if (!a.length) return NaN;
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};
const fx = (n: number, d: number): string => (Number.isNaN(n) ? '-' : n.toFixed(d));

async function main(): Promise<void> {
  process.stderr.write(`reading transcripts from ${PROJECTS} ...\n`);
  const sessions = await loadSessions();
  const walls = sessions.flatMap((s) => s.walls.filter((w) => w.kind === 'five_hour'));
  const events = sessions.flatMap((s) => wallEvents(s));

  console.log(`\nDataset`);
  console.log(`  sessions        ${sessions.length}`);
  console.log(`  usage records   ${sessions.reduce((a, s) => a + s.ev.length, 0)}`);
  console.log(
    `  real 429 walls  ${walls.length} tombstone(s) -> ${events.length} distinct event(s), ` +
      `in ${sessions.filter((s) => s.walls.length).length} session(s)`,
  );
  console.log(`  wall clock      ${sessions.reduce((a, s) => a + s.hours, 0).toFixed(0)} h`);

  // ---- Step 1: does the token-cost model explain the observed walls at all?
  console.log(`\nCost-model check -- weighted 5h spend at each real 429`);
  console.log(`  A tight spread means the cost model tracks the real limit. A wide one means`);
  console.log(`  five_hour levels here are shape-only and must not be read as percentages.`);
  console.log(
    ACCOUNT
      ? `  scoring against the ACCOUNT's whole 5h spend -- every transcript summed.`
      : `  scoring against each transcript's own turns only (--per-session).`,
  );
  const allEv = sessions.flatMap((s) => s.ev);
  const accounts = new Map<string, AccountSpend>();
  const acctFor = (w: Weights): AccountSpend => {
    let a = accounts.get(w.name);
    if (!a) {
      a = new AccountSpend(allEv, w);
      accounts.set(w.name, a);
    }
    return a;
  };
  let best: { w: Weights; cap: number; cv: number } | null = null;
  for (const w of WEIGHTINGS) {
    const at: number[] = [];
    for (const s of sessions) {
      for (const wl of s.walls) {
        if (wl.kind !== 'five_hour') continue;
        const v = ACCOUNT ? acctFor(w).at(wl.t) : fiveHourSeries(s.ev, w, [wl.t])[0]!;
        if (v > 0) at.push(v);
      }
    }
    if (!at.length) continue;
    const mean = at.reduce((a, b) => a + b, 0) / at.length;
    const sd = Math.sqrt(at.reduce((a, b) => a + (b - mean) ** 2, 0) / at.length);
    const cv = sd / mean;
    console.log(
      `  ${w.name.padEnd(15)} median ${(pct(at, 50) / 1e6).toFixed(2)}M  mean ${(mean / 1e6).toFixed(2)}M  spread(CV) ${(cv * 100).toFixed(0)}%  n=${at.length}`,
    );
    if (!best || cv < best.cv) best = { w, cap: pct(at, 50), cv };
  }
  if (!best) {
    console.log(`  no five_hour walls found -- cannot anchor the scale, aborting`);
    return;
  }
  console.log(
    `  -> ${best.w.name}, capacity ${(best.cap / 1e6).toFixed(2)}M weighted tokens per 5h`,
  );

  // ---- Step 2: grid search over the parameters
  const list = (f: string, dflt: number[], min: number): number[] => {
    const raw = flag(f);
    if (!raw) return dflt;
    return raw
      .split(',')
      .map((x) => Number(x.trim()))
      .filter((x) => Number.isFinite(x) && x >= min);
  };
  const ALPHAS = list('--alphas', QUICK ? [0.2, 0.35, 0.6] : [0.1, 0.15, 0.2, 0.25, 0.35, 0.5, 0.7, 1.0], 0.01);
  const WINDOWS = list('--windows', QUICK ? [5, 10, 20] : [3, 5, 8, 10, 15, 20, 30], 0.5);
  // max_samples belongs in the grid because it is not independent of window_min: the
  // budget decides how far apart retained samples sit, and too small a budget coarsens
  // the very history window_min asks for. Defaults to the shipped value; --samples sweeps.
  const SAMPLES = list('--samples', [DEFAULT_CONFIG.burn.max_samples], 2);
  console.log(
    `\nGrid search -- ${ALPHAS.length} alpha x ${WINDOWS.length} window_min` +
      `${SAMPLES.length > 1 ? ` x ${SAMPLES.length} max_samples` : ''} over ${sessions.length} sessions`,
  );
  console.log(`  err  median relative error of predicted burn vs the burn that actually`);
  console.log(`       followed over the next ${HORIZON_MIN} min. Scale-invariant, so the capacity`);
  console.log(`       constant above cannot flatter it.`);
  console.log(`  meas share of ticks where a rate was computable at all -- a blind estimator`);
  console.log(`       scores a perfect error by never predicting.`);
  // Structurally pessimistic under account-wide scoring, and not an alarm rate: when
  // several sessions share the budget they all see the same exhausted window, and only
  // the one that made the next request gets the tombstone. The others warned correctly
  // about a wall they did not personally hit.
  if (ACCOUNT) {
    console.log(`  falseLAND inflated here: concurrent sessions all see the same exhausted`);
    console.log(`       window, but only one of them records the 429.`);
  }
  console.log('');

  interface Row {
    alpha: number;
    window_min: number;
    max_samples: number;
    spacing_s: number;
    err_p50: number;
    err_p90: number;
    flips: number;
    meas: number;
    lead_p50: number;
    warned: number;
    missed: number;
    falseLand: number;
  }
  const rows: Row[] = [];
  for (const a of ALPHAS) {
    for (const wm of WINDOWS) {
      for (const ms of SAMPLES) {
        const sc = newScore();
        for (const s of sessions)
          replay(s, best.w, best.cap, a, wm, ms, sc, null, ACCOUNT ? acctFor(best.w) : null);
        rows.push({
          alpha: a,
          window_min: wm,
          max_samples: ms,
          spacing_s: spacingS(cfgWith(a, wm, ms)),
          err_p50: pct(sc.errs, 50),
          err_p90: pct(sc.errs, 90),
          flips: sc.flips,
          meas: sc.ticks ? sc.measurable / sc.ticks : 0,
          lead_p50: pct(sc.leads, 50),
          warned: sc.leads.length,
          missed: sc.missed,
          falseLand: sc.falseLand,
        });
      }
    }
  }

  const hdr =
    'alpha  win  samp   gap   err_p50  err_p90   meas   flips  warned/missed  lead_p50  falseLAND';
  console.log(hdr);
  console.log('-'.repeat(hdr.length));
  for (const r of rows) {
    const cur =
      r.alpha === DEFAULT_CONFIG.burn.alpha &&
      r.window_min === DEFAULT_CONFIG.burn.window_min &&
      r.max_samples === DEFAULT_CONFIG.burn.max_samples;
    console.log(
      `${String(r.alpha).padEnd(6)} ${String(r.window_min).padStart(3)} ` +
        `${String(r.max_samples).padStart(4)} ${String(r.spacing_s).padStart(4)}s  ` +
        `${fx(r.err_p50, 3).padStart(8)} ${fx(r.err_p90, 2).padStart(8)}  ` +
        `${(r.meas * 100).toFixed(0).padStart(4)}%  ${String(r.flips).padStart(6)}  ` +
        `${String(r.warned).padStart(6)}/${String(r.missed).padEnd(6)} ` +
        `${fx(r.lead_p50, 1).padStart(8)}  ${String(r.falseLand).padStart(9)}` +
        `${cur ? '   <- current default' : ''}`,
    );
  }

  const ok = rows.filter((r) => !Number.isNaN(r.err_p50));
  console.log(`\nBest by prediction error:`);
  for (const r of ok.slice().sort((a, b) => a.err_p50 - b.err_p50).slice(0, 6)) {
    console.log(
      `  alpha ${String(r.alpha).padEnd(5)} window_min ${String(r.window_min).padStart(2)} ` +
        `max_samples ${String(r.max_samples).padStart(3)} (gap ${r.spacing_s}s)   ` +
        `err_p50 ${fx(r.err_p50, 3)}  err_p90 ${fx(r.err_p90, 2)}  flips ${r.flips}  ` +
        `missed ${r.missed}  falseLAND ${r.falseLand}`,
    );
  }

  // ---- Step 3: why every real wall was or was not warned about.
  // No parameter in the grid moves warned/missed, which is itself the finding: the misses
  // are properties of what was observable, not of the smoothing. This names each one.
  if (DIAGNOSE) {
    const cfgA = ALPHAS[0]!;
    const cfgW = WINDOWS[0]!;
    const cfgS = SAMPLES[0]!;
    console.log('');
    console.log(
      `Per-wall diagnosis -- alpha ${cfgA}, window_min ${cfgW}, max_samples ${cfgS}`,
    );
    console.log('  age    how long the session had run when the wall hit');
    console.log('  used   reconstructed 5h level at that moment, peak the worst mode in the hour before');
    console.log('  lead   minutes of LAND-or-worse warning before it, or the reason there was none');
    console.log('');
    const diag: WallDiag[] = [];
    const sc = newScore();
    for (const s2 of sessions) {
      if (!wallEvents(s2).length) continue;
      replay(s2, best.w, best.cap, cfgA, cfgW, cfgS, sc, diag, ACCOUNT ? acctFor(best.w) : null);
    }
    const dh = 'session                    age     used  burn    mode      peak      lead';
    console.log(dh);
    console.log('-'.repeat(dh.length));
    for (const d of diag.sort((a, b) => a.session.localeCompare(b.session) || a.ageMin - b.ageMin)) {
      console.log(
        `${d.session.slice(-26).padEnd(26)} ${fx(d.ageMin, 0).padStart(4)}m  ` +
          `${(d.usedPct === null ? '-' : String(d.usedPct)).padStart(4)}%  ` +
          `${(d.burn === null ? '-' : d.burn.toFixed(2)).padStart(5)}  ` +
          `${d.mode.padEnd(9)} ${d.peak.padEnd(9)} ` +
          `${d.leadMin === null ? d.reason : fx(d.leadMin, 1) + 'm'}`,
      );
    }
    const byReason = new Map<string, number>();
    for (const d of diag) {
      const key = d.leadMin !== null ? 'warned' : d.reason.split(' -- ')[0]!.split(' — ')[0]!;
      byReason.set(key, (byReason.get(key) ?? 0) + 1);
    }
    console.log('');
    console.log(`Outcome of ${diag.length} distinct wall event(s):`);
    for (const [k, v] of [...byReason].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(v).padStart(3)}  ${k}`);
    }
  }

  if (JSON_OUT) {
    writeFileSync(
      JSON_OUT,
      JSON.stringify({ capacity: best.cap, weighting: best.w.name, rows }, null, 2),
    );
    console.log(`\nwrote ${JSON_OUT}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
