/** Severity ladder. Order matters: index == severity. */
export const MODES = [
  'NORMAL',
  'WATCH',
  'PREPARE',
  'LAND',
  'EMERGENCY',
  'HARD_STOPPED',
] as const;
export type Mode = (typeof MODES)[number];

export const AXES = ['context', 'five_hour', 'seven_day', 'spend'] as const;
export type AxisName = (typeof AXES)[number];

/** Subset of the statusLine stdin payload Guardian relies on. Everything is optional:
 *  the docs list `rate_limits`, `current_usage`, and `used_percentage` as absent or null
 *  in ordinary situations (pre-first-response, post-/compact, non-Pro/Max accounts). */
export interface StatusLinePayload {
  session_id?: string;
  cwd?: string;
  transcript_path?: string;
  version?: string;
  model?: { id?: string; display_name?: string };
  workspace?: { current_dir?: string; project_dir?: string };
  cost?: { total_cost_usd?: number; total_duration_ms?: number };
  context_window?: {
    total_input_tokens?: number;
    total_output_tokens?: number;
    context_window_size?: number;
    used_percentage?: number | null;
    remaining_percentage?: number | null;
    current_usage?: Record<string, number> | null;
  } | null;
  exceeds_200k_tokens?: boolean;
  rate_limits?: Partial<
    Record<'five_hour' | 'seven_day' | 'spend_limit', { used_percentage?: number; resets_at?: number }>
  > | null;
}

/** One usage observation. Percentages are 0..100; `t` is epoch seconds. */
export interface Sample {
  t: number;
  context?: number;
  five_hour?: number;
  seven_day?: number;
  spend?: number;
}

export interface AxisState {
  /** Latest observed percentage, 0..100. */
  used_pct: number | null;
  /** Smoothed percentage-points consumed per minute. null when not yet measurable. */
  burn_pct_per_min: number | null;
  /** Epoch seconds at which this window refills. Absent for `context`. */
  resets_at?: number | null;
  /** Minutes until this axis is exhausted.
   *  null  => unknown (no burn rate yet)
   *  Infinity => the window refills before it can be exhausted; safe at any percentage. */
  time_to_wall_min: number | null;
  /** Mode this axis alone would demand. */
  mode: Mode;
}

export interface GuardianState {
  schema: 1;
  session_id: string;
  updated_at: number;
  mode: Mode;
  /** Human-readable justification for `mode`, naming the binding axis. */
  reason: string;
  /** Which axis drove the mode, if any. */
  binding_axis: AxisName | null;
  axes: Partial<Record<AxisName, AxisState>>;
  cost_usd: number | null;
  model: string | null;
  /** Live subagent count and whether the gate is currently letting spawns through. */
  agents: { live: number; spawn_allowed: boolean };
  /** Bounded ring of recent observations, oldest first. */
  samples: Sample[];
  /** Latches that must fire at most once per session. */
  latches: { stop_forced?: boolean; resume_offered?: boolean };
  /** Set when a 429 has been observed, with the epoch second the window reopens. */
  hard_stop: { at: number; kind: string; resets_at: number | null } | null;
  manifest: { sealed_at: number | null };
}

export interface GuardianConfig {
  enabled: boolean;
  thresholds_minutes: { watch: number; prepare: number; land: number; emergency: number };
  thresholds_percent_floor: { watch: number; prepare: number; land: number; emergency: number };
  axes: Record<AxisName, boolean>;
  /** Highest mode an axis is allowed to demand. `context` is capped because its wall is
   *  auto-compaction: lossy and automatic, but recoverable in seconds. Treating it like a
   *  429 would cry wolf several times a day. */
  axis_severity_cap: Partial<Record<AxisName, Mode>>;
  agents: {
    /** Mode at which new subagent spawns are denied outright. */
    deny_spawn_from: Mode;
    /** Mode at which a spawned subagent's prompt gains a self-checkpointing note. */
    inject_checkpoint_prompt_from: Mode;
  };
  /** Glob patterns for irreversible, long-running shell work. Recorded, never blocked. */
  safe_boundary_commands: string[];
  landing: {
    /** Mode at which Guardian starts injecting a brief into the conversation. */
    inject_from: Mode;
    /** Let the Stop hook refuse one turn-end to force a seal. Single-shot per session. */
    force_seal_turn: boolean;
    /** Halt the agentic loop at EMERGENCY once a handoff is sealed. Off by default: an
     *  unexpected halt is worse than the problem for most users. */
    halt_loop_at_emergency: boolean;
  };
  statusline: { manage: boolean; chain_existing: boolean; chained_command: string | null };
  burn: {
    window_min: number;
    min_span_s: number;
    alpha: number;
    max_samples: number;
    /** Slack required before a refilling window counts as safe. */
    reset_margin_min: number;
    /** Readings required before a rate is trusted. Two points can lie; three rarely do. */
    min_samples: number;
  };
  render: { bar_width: number; color: boolean };
}
