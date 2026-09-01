import { readFileSync } from 'node:fs';
import type { GuardianConfig } from './types.ts';
import { configPath } from './paths.ts';

export const DEFAULT_CONFIG: GuardianConfig = {
  enabled: true,
  // Minutes of remaining headroom, not percentages. See mode.ts for why.
  thresholds_minutes: { watch: 30, prepare: 12, land: 5, emergency: 1.5 },
  // Belt-and-braces: used while burn rate is still unmeasurable (early session).
  thresholds_percent_floor: { watch: 80, prepare: 90, land: 95, emergency: 97 },
  axes: { context: true, five_hour: true, seven_day: true, spend: true },
  axis_severity_cap: { context: 'LAND' },
  statusline: { manage: true, chain_existing: true, chained_command: null },
  burn: { window_min: 10, min_span_s: 45, alpha: 0.35, max_samples: 60, reset_margin_min: 1 },
  render: { bar_width: 10, color: true },
};

/** Shallow-merge one level deep; enough for this schema and predictable to reason about. */
export function loadConfig(projectDir: string): GuardianConfig {
  let user: Partial<GuardianConfig> = {};
  try {
    user = JSON.parse(readFileSync(configPath(projectDir), 'utf8')) as Partial<GuardianConfig>;
  } catch {
    return DEFAULT_CONFIG;
  }
  const out: Record<string, unknown> = { ...DEFAULT_CONFIG };
  for (const [k, v] of Object.entries(user)) {
    const base = (DEFAULT_CONFIG as unknown as Record<string, unknown>)[k];
    out[k] =
      v && typeof v === 'object' && !Array.isArray(v) && base && typeof base === 'object'
        ? { ...(base as object), ...(v as object) }
        : v;
  }
  return out as unknown as GuardianConfig;
}
