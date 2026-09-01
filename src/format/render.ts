import type { AxisState, GuardianConfig, GuardianState, Mode } from '../types.ts';
import { fmtMin } from '../budget/mode.ts';

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  amber: '\x1b[33m',
  amberBold: '\x1b[1;33m',
  red: '\x1b[31m',
  redBold: '\x1b[1;31m',
  redInv: '\x1b[1;41;97m',
};

const MODE_COLOR: Record<Mode, string> = {
  NORMAL: C.dim,
  WATCH: C.amber,
  PREPARE: C.amberBold,
  LAND: C.red,
  EMERGENCY: C.redInv,
  HARD_STOPPED: C.redInv,
};

/** Green / amber / red per axis, keyed on that axis's own mode rather than on its
 *  percentage. The mode already folds the percentage floors in, and the tool's whole
 *  claim is that 95% with a reset two minutes out is calmer than 70% burning fast —
 *  colouring the number by the number would say the opposite of what it means. */
const AXIS_COLOR: Record<Mode, string> = {
  NORMAL: C.green,
  WATCH: C.amber,
  PREPARE: C.amberBold,
  LAND: C.red,
  EMERGENCY: C.redInv,
  HARD_STOPPED: C.redInv,
};

function bar(pct: number, width: number): string {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  return '▓'.repeat(filled) + '░'.repeat(width - filled);
}

function axisSegment(
  label: string,
  st: AxisState | undefined,
  cfg: GuardianConfig,
  paint: (s: string, c: string) => string,
): string | null {
  if (!st || st.used_pct === null) return null;
  const pct = st.used_pct;
  let seg = `${bar(pct, cfg.render.bar_width)} ${pct.toFixed(0)}%`;
  // Only show a clock when there is a real one. Infinity means the window outruns the
  // burn rate, which is reassuring rather than informative, so it stays off the bar.
  if (st.time_to_wall_min !== null && Number.isFinite(st.time_to_wall_min)) {
    seg += ` ⚠ ~${fmtMin(st.time_to_wall_min)}`;
  }
  // The label stays uncoloured, so the colour marks the gauge rather than the alphabet.
  return `${label} ${paint(seg, AXIS_COLOR[st.mode])}`;
}

/** One short line. The status bar has limited width and Guardian is a passenger on it. */
/** Token counts as people say them: `128k`, `1M`, `840`.
 *
 *  A percentage answers "how full", and only that. Near a wall the other question is how
 *  much room is actually left, and 6% of a 1M window is not the same amount of work as 6%
 *  of a 200k one. */
export function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '?';
  if (n >= 1e6) {
    const m = n / 1e6;
    return `${m >= 10 || Number.isInteger(m) ? m.toFixed(0) : m.toFixed(1)}M`;
  }
  // One decimal below 10k, where rounding to the nearest thousand would turn a 1450 tok/min
  // pace into "1k/min" and a nearly-empty window into "10k".
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(Math.round(n / 100) / 10).toFixed(1)}k`;
  return `${Math.round(n)}`;
}

export function renderStatus(state: GuardianState, cfg: GuardianConfig): string {
  const color = cfg.render.color;
  const paint = (s: string, c: string) => (color ? `${c}${s}${C.reset}` : s);

  const segs: string[] = [];
  const ctx = axisSegment('ctx', state.axes.context, cfg, paint);
  if (ctx) segs.push(ctx);
  const fh = axisSegment('5h', state.axes.five_hour, cfg, paint);
  if (fh) segs.push(fh);
  // The weekly window is a wall like any other, and the one that ends a week rather than
  // an afternoon — it gets the same gauge as the 5h, not a bare percentage that only
  // appears once it is already a problem.
  const wk = axisSegment('7d', state.axes.seven_day, cfg, paint);
  if (wk) segs.push(wk);

  if (state.cost_usd != null) segs.push(`$${state.cost_usd.toFixed(2)}`);

  const body = segs.length ? segs.join('  ') : 'guardian: awaiting first API response';
  const tag = state.mode === 'NORMAL' ? '🛡' : `🛡 ${state.mode}`;
  return `${paint(tag, MODE_COLOR[state.mode])} ${body}`;
}

/** Multi-line dashboard for `/guardian status`, where width is not a constraint. */
export function renderDashboard(state: GuardianState, cfg: GuardianConfig): string {
  const paint = (s: string, c: string) => (cfg.render.color ? `${c}${s}${C.reset}` : s);
  const rows: string[] = [];
  rows.push('╔═══════════════════════════════════════════════════════════════╗');
  rows.push(`║ CLAUDE SESSION GUARDIAN${' '.repeat(39)}║`);
  rows.push('╠═══════════════════════════════════════════════════════════════╣');
  const pad = (s: string) => `║ ${s}${' '.repeat(Math.max(0, 62 - vislen(s)))}║`;
  rows.push(pad(`Mode:     ${state.mode}`));
  rows.push(pad(`Why:      ${state.reason}`));
  rows.push(pad(''));
  for (const [name, st] of Object.entries(state.axes)) {
    if (!st || st.used_pct === null) continue;
    const ttw =
      st.time_to_wall_min === null
        ? 'unknown'
        : Number.isFinite(st.time_to_wall_min)
          ? `~${fmtMin(st.time_to_wall_min)}`
          : 'refills first';
    const burn = st.burn_pct_per_min === null ? '—' : `${st.burn_pct_per_min.toFixed(2)} %/min`;
    const gauge = `${bar(st.used_pct, cfg.render.bar_width)} ${st.used_pct.toFixed(1).padStart(5)}%`;
    rows.push(
      pad(
        `${name.padEnd(10)} ${paint(gauge, AXIS_COLOR[st.mode])}  ` +
          `burn ${burn.padEnd(12)} wall ${ttw}`,
      ),
    );
  }
  rows.push(pad(''));
  const gate = state.agents.spawn_allowed ? 'allowed' : 'BLOCKED';
  rows.push(pad(`Agents:   ${state.agents.live} live, new spawns ${gate}`));
  rows.push(pad(`Samples:  ${state.samples.length}`));
  rows.push(
    pad(`Manifest: ${state.manifest.sealed_at ? new Date(state.manifest.sealed_at * 1000).toISOString() : 'not sealed'}`),
  );
  rows.push('╚═══════════════════════════════════════════════════════════════╝');
  return rows.join('\n');
}

/** Box drawing needs display width, and the bar glyphs are single-width but non-ASCII. */
function vislen(s: string): number {
  return [...s.replace(/\x1b\[[0-9;]*m/g, '')].length;
}
