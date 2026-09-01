import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { MODES, type GuardianConfig, type Mode } from '../types.ts';
import { DEFAULT_CONFIG } from '../core/config.ts';
import { spacingS } from '../budget/burn.ts';
import { configPath, ensureGuardianDir } from '../core/paths.ts';

type Plain = Record<string, unknown>;

/** Paths whose value must be one of the mode names. */
const MODE_PATHS = [/^axis_severity_cap\.[a-z_]+$/, /^agents\.(deny_spawn_from|inject_checkpoint_prompt_from)$/];

function isModePath(path: string): boolean {
  return MODE_PATHS.some((re) => re.test(path));
}

export function flatten(o: unknown, prefix = ''): Array<[string, unknown]> {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return [[prefix, o]];
  const out: Array<[string, unknown]> = [];
  for (const [k, v] of Object.entries(o as Plain)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...flatten(v, path));
    else out.push([path, v]);
  }
  return out;
}

export function getPath(o: unknown, path: string): unknown {
  let cur: unknown = o;
  for (const part of path.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Plain)[part];
  }
  return cur;
}

/** Returns a new object; never mutates the input. */
export function setPath(o: Plain, path: string, value: unknown): Plain {
  const parts = path.split('.');
  const out: Plain = { ...o };
  let cur = out;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]!;
    const next = cur[k];
    cur[k] = next && typeof next === 'object' && !Array.isArray(next) ? { ...(next as Plain) } : {};
    cur = cur[k] as Plain;
  }
  cur[parts[parts.length - 1]!] = value;
  return out;
}

export function unsetPath(o: Plain, path: string): Plain {
  const parts = path.split('.');
  const out: Plain = { ...o };
  let cur = out;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]!;
    const next = cur[k];
    if (!next || typeof next !== 'object') return out;
    cur[k] = { ...(next as Plain) };
    cur = cur[k] as Plain;
  }
  delete cur[parts[parts.length - 1]!];
  return out;
}

export type Coerced = { ok: true; value: unknown } | { ok: false; error: string };

/** Turn a command-line string into the type the default at that path implies.
 *
 *  Typing is taken from the defaults rather than a hand-written schema, so a new setting
 *  becomes configurable the moment it has a default — and can never drift out of sync. */
export function coerceValue(path: string, raw: string): Coerced {
  const current = getPath(DEFAULT_CONFIG, path);

  if (current === undefined) {
    return { ok: false, error: `unknown setting "${path}" (see \`guardian config\` for the list)` };
  }

  if (isModePath(path)) {
    const v = raw.toUpperCase();
    return MODES.includes(v as Mode)
      ? { ok: true, value: v }
      : { ok: false, error: `must be one of ${MODES.join(', ')}` };
  }

  if (typeof current === 'boolean') {
    const t = ['true', 'on', 'yes', '1', 'enabled'];
    const f = ['false', 'off', 'no', '0', 'disabled'];
    const v = raw.toLowerCase();
    if (t.includes(v)) return { ok: true, value: true };
    if (f.includes(v)) return { ok: true, value: false };
    return { ok: false, error: 'must be true or false' };
  }

  if (typeof current === 'number') {
    const n = Number(raw);
    if (!Number.isFinite(n)) return { ok: false, error: 'must be a number' };
    return { ok: true, value: n };
  }

  if (Array.isArray(current)) {
    const trimmed = raw.trim();
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (!Array.isArray(parsed)) return { ok: false, error: 'must be a JSON array' };
        return { ok: true, value: parsed };
      } catch {
        return { ok: false, error: 'looked like JSON but did not parse' };
      }
    }
    // Comma-separated is the shape people actually type.
    return { ok: true, value: trimmed ? trimmed.split(',').map((x) => x.trim()).filter(Boolean) : [] };
  }

  return { ok: true, value: raw };
}

export interface ConfigProblem {
  path: string;
  message: string;
  severity: 'error' | 'warning';
}

/** Catch the mistakes that would otherwise fail silently: a typo'd key that does nothing,
 *  or thresholds ordered so a mode can never be reached. */
export function validateConfig(user: Plain): ConfigProblem[] {
  const problems: ConfigProblem[] = [];

  for (const [path] of flatten(user)) {
    if (!path) continue;
    if (getPath(DEFAULT_CONFIG, path) === undefined) {
      // axis_severity_cap is an open map, so an unrecognised axis there is a real typo but
      // any of the four known axes is fine even if the defaults omit it.
      const axisCap = /^axis_severity_cap\.(context|five_hour|seven_day|spend)$/.test(path);
      if (!axisCap) {
        problems.push({ path, message: 'not a Guardian setting; it will be ignored', severity: 'warning' });
      }
    }
  }

  const tm = { ...DEFAULT_CONFIG.thresholds_minutes, ...(user.thresholds_minutes as object) };
  const order: Array<keyof typeof tm> = ['watch', 'prepare', 'land', 'emergency'];
  for (const k of order) {
    if (typeof tm[k] !== 'number' || tm[k] <= 0) {
      problems.push({ path: `thresholds_minutes.${k}`, message: 'must be a positive number of minutes', severity: 'error' });
    }
  }
  for (let i = 1; i < order.length; i++) {
    const a = order[i - 1]!;
    const b = order[i]!;
    if (typeof tm[a] === 'number' && typeof tm[b] === 'number' && tm[a] < tm[b]) {
      problems.push({
        path: `thresholds_minutes.${b}`,
        message: `must be <= thresholds_minutes.${a} (${tm[a]}); otherwise ${a.toUpperCase()} can never be reached before ${b.toUpperCase()}`,
        severity: 'error',
      });
    }
  }

  const tp = { ...DEFAULT_CONFIG.thresholds_percent_floor, ...(user.thresholds_percent_floor as object) };
  for (const k of order) {
    const v = tp[k as keyof typeof tp];
    if (typeof v !== 'number' || v < 0 || v > 100) {
      problems.push({ path: `thresholds_percent_floor.${k}`, message: 'must be a percentage between 0 and 100', severity: 'error' });
    }
  }
  for (let i = 1; i < order.length; i++) {
    const a = order[i - 1]!;
    const b = order[i]!;
    const va = tp[a as keyof typeof tp];
    const vb = tp[b as keyof typeof tp];
    if (typeof va === 'number' && typeof vb === 'number' && va > vb) {
      problems.push({
        path: `thresholds_percent_floor.${b}`,
        message: `must be >= thresholds_percent_floor.${a} (${va}); percentage floors rise with severity`,
        severity: 'error',
      });
    }
  }

  for (const [path, value] of flatten(user)) {
    if (isModePath(path) && typeof value === 'string' && !MODES.includes(value as Mode)) {
      problems.push({ path, message: `must be one of ${MODES.join(', ')}`, severity: 'error' });
    }
  }

  const burn = { ...DEFAULT_CONFIG.burn, ...(user.burn as object) };
  if (burn.min_samples < 2) {
    problems.push({ path: 'burn.min_samples', message: 'must be at least 2; a rate needs two readings', severity: 'error' });
  }
  if (burn.alpha <= 0 || burn.alpha > 1) {
    problems.push({ path: 'burn.alpha', message: 'must be greater than 0 and at most 1', severity: 'error' });
  }
  if (burn.window_min <= 0) {
    problems.push({ path: 'burn.window_min', message: 'must be a positive number of minutes', severity: 'error' });
  }
  if (burn.reset_margin_min < 0) {
    problems.push({ path: 'burn.reset_margin_min', message: 'cannot be negative', severity: 'error' });
  }
  // max_samples sets how far apart retained samples sit. Too small a budget spreads them
  // so wide that the window cannot hold the readings a rate needs, and the burn estimate
  // is never measurable at all -- silently, which is the worst way to lose it.
  if (burn.window_min > 0 && burn.max_samples >= 2) {
    const gap = spacingS({ ...DEFAULT_CONFIG, burn } as GuardianConfig);
    const needed = (burn.min_samples - 1) * gap;
    if (needed > burn.window_min * 60) {
      problems.push({
        path: 'burn.max_samples',
        message:
          `too small for burn.window_min ${burn.window_min}: samples land ${gap}s apart, so ` +
          `${burn.min_samples} of them span ${Math.round(needed)}s and never fit the window — ` +
          `no burn rate would ever be measurable`,
        severity: 'error',
      });
    }
  }

  const w = (user.render as Plain | undefined)?.bar_width ?? DEFAULT_CONFIG.render.bar_width;
  if (typeof w !== 'number' || w < 1 || w > 40) {
    problems.push({ path: 'render.bar_width', message: 'must be between 1 and 40', severity: 'error' });
  }

  return problems;
}

export function readUserConfig(projectDir: string): Plain {
  try {
    const parsed = JSON.parse(readFileSync(configPath(projectDir), 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Plain) : {};
  } catch {
    return {};
  }
}

export function writeUserConfig(projectDir: string, cfg: Plain): void {
  const p = configPath(projectDir);
  ensureGuardianDir(projectDir, dirname(p));
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`);
  renameSync(tmp, p);
}

export function deleteUserConfig(projectDir: string): boolean {
  const p = configPath(projectDir);
  if (!existsSync(p)) return false;
  unlinkSync(p);
  return true;
}

/** Short descriptions, shown beside each setting. Kept here rather than in the type so the
 *  listing can explain itself without the user opening the guide. */
export const HELP: Record<string, string> = {
  enabled: 'master switch; false makes Guardian silent without uninstalling it',
  'thresholds_minutes.watch': 'minutes-to-wall at which the bar turns amber',
  'thresholds_minutes.prepare': 'minutes-to-wall at which to stop starting new work',
  'thresholds_minutes.land': 'minutes-to-wall at which spawns are denied and a handoff seals',
  'thresholds_minutes.emergency': 'minutes-to-wall treated as the wall being here',
  'thresholds_percent_floor.watch': 'percentage backstop while burn rate is unmeasurable',
  'thresholds_percent_floor.prepare': 'percentage backstop while burn rate is unmeasurable',
  'thresholds_percent_floor.land': 'percentage backstop while burn rate is unmeasurable',
  'thresholds_percent_floor.emergency': 'percentage backstop while burn rate is unmeasurable',
  'axes.context': 'track the context window',
  'axes.five_hour': 'track the 5-hour rate limit',
  'axes.seven_day': 'track the 7-day rate limit',
  'axes.spend': 'track the spend limit',
  'axis_severity_cap.context': 'highest mode the context axis may demand (its wall is compaction)',
  'agents.deny_spawn_from': 'mode at which new subagents are refused; HARD_STOPPED disables the gate',
  'agents.inject_checkpoint_prompt_from': 'mode at which spawned agents are told to checkpoint',
  safe_boundary_commands: 'irreversible commands to record as possibly-interrupted; never blocked',
  'burn.window_min': 'trailing window for the burn-rate estimate',
  'burn.min_span_s': 'minimum sample span before a rate is computed',
  'burn.alpha': 'smoothing; higher reacts faster and is twitchier',
  'burn.max_samples': 'bound on retained samples',
  'burn.reset_margin_min': 'slack required before a refilling window counts as safe',
  'burn.min_samples': 'readings required before a rate is believed',
  'statusline.manage': 'whether Guardian owns the status line',
  'statusline.chain_existing': 'run the status line Guardian displaced, and append to it',
  'statusline.chained_command': 'the displaced status line command (set by install)',
  'render.bar_width': 'width of the progress bars, in characters',
  'render.color': 'ANSI colour in the status line',
};
