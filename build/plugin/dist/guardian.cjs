#!/usr/bin/env node
"use strict";

// src/cli.ts
var import_node_fs19 = require("node:fs");

// src/version.ts
var VERSION = "0.7.7";

// src/sensors/statusline.ts
var import_node_fs8 = require("node:fs");

// src/types.ts
var MODES = [
  "NORMAL",
  "WATCH",
  "PREPARE",
  "LAND",
  "EMERGENCY",
  "HARD_STOPPED"
];
var AXES = ["context", "five_hour", "seven_day", "spend"];

// src/core/config.ts
var import_node_fs2 = require("node:fs");

// src/core/paths.ts
var import_node_path = require("node:path");
var import_node_fs = require("node:fs");
var import_node_os = require("node:os");
function stateDir(projectDir) {
  return (0, import_node_path.join)(projectDir, ".claude", "guardian");
}
function statePath(projectDir, sessionId) {
  return (0, import_node_path.join)(stateDir(projectDir), "sessions", `${sanitize(sessionId)}.json`);
}
function configPath(projectDir) {
  return (0, import_node_path.join)(stateDir(projectDir), "config.json");
}
function agentNotesDir(projectDir) {
  return (0, import_node_path.join)(stateDir(projectDir), "agent-notes");
}
function agentNoteSlug(description) {
  return description.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "agent";
}
function agentNotesFile(projectDir, description) {
  return (0, import_node_path.join)(agentNotesDir(projectDir), `${agentNoteSlug(description)}.md`);
}
function logPath(projectDir) {
  return (0, import_node_path.join)(stateDir(projectDir), "logs", "guardian.log");
}
function userSettingsPath() {
  return (0, import_node_path.join)((0, import_node_os.homedir)(), ".claude", "settings.json");
}
function settingsChain(projectDir, userFile = userSettingsPath()) {
  return [
    userFile,
    (0, import_node_path.join)(projectDir, ".claude", "settings.json"),
    (0, import_node_path.join)(projectDir, ".claude", "settings.local.json")
  ];
}
function sanitize(s) {
  return s.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100) || "unknown";
}
function resolveStateRoot(startDir) {
  const start = real((0, import_node_path.resolve)(startDir));
  const home = real((0, import_node_path.resolve)((0, import_node_os.homedir)()));
  let dir = start;
  for (let i = 0; i < 12; i++) {
    if (samePath(dir, home)) break;
    if ((0, import_node_fs.existsSync)((0, import_node_path.join)(dir, ".claude", "guardian"))) return dir;
    if ((0, import_node_fs.existsSync)((0, import_node_path.join)(dir, ".git"))) return dir;
    const parent = (0, import_node_path.dirname)(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}
function real(p) {
  try {
    return import_node_fs.realpathSync.native(p);
  } catch {
    return p;
  }
}
function samePath(a, b) {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
function ledgerPath(projectDir, sessionId) {
  return (0, import_node_path.join)(stateDir(projectDir), "sessions", `${sanitize(sessionId)}.ledger.jsonl`);
}
function handoffDir(projectDir) {
  return (0, import_node_path.join)(stateDir(projectDir), "handoff");
}
function ensureGuardianDir(projectDir, dir) {
  const created = (0, import_node_fs.mkdirSync)(dir, { recursive: true });
  if (!created) return;
  const ignore = (0, import_node_path.join)(stateDir(projectDir), ".gitignore");
  if (!(0, import_node_fs.existsSync)(ignore)) {
    try {
      (0, import_node_fs.writeFileSync)(ignore, "*\n");
    } catch {
    }
  }
}

// src/core/config.ts
var DEFAULT_CONFIG = {
  enabled: true,
  // Minutes of remaining headroom, not percentages. See mode.ts for why.
  thresholds_minutes: { watch: 30, prepare: 12, land: 5, emergency: 1.5 },
  // Belt-and-braces: used while burn rate is still unmeasurable (early session).
  thresholds_percent_floor: { watch: 80, prepare: 90, land: 95, emergency: 97 },
  axes: { context: true, five_hour: true, seven_day: true, spend: true },
  axis_severity_cap: { context: "LAND" },
  agents: { deny_spawn_from: "LAND", inject_checkpoint_prompt_from: "PREPARE" },
  // Recorded so a handoff can say one was in flight, never blocked: refusing to start a
  // migration is sometimes right and sometimes leaves a system half-configured, and
  // Guardian cannot tell which.
  safe_boundary_commands: [
    "*migrate*",
    "*migration*",
    "*deploy*",
    "terraform *",
    "*kubectl apply*",
    "*helm upgrade*",
    "*alembic*",
    "*flyway*",
    "*dotnet ef database*"
  ],
  landing: {
    inject_from: "PREPARE",
    force_seal_turn: true,
    auto_seal_from: "LAND",
    halt_loop_at_emergency: false
  },
  statusline: {
    manage: true,
    chain_existing: true,
    chained_command: null,
    chained_from: null,
    chain_timeout_ms: 5e3,
    own_line: true
  },
  // Calibrated against 43 real transcripts by scripts/calibrate.ts: window_min 15 with a
  // 60-sample budget scored the lowest prediction error (median 0.41 against the burn that
  // actually followed, versus 0.46 at a 10-minute window) at both the idle and the busy
  // status-line cadence. A larger budget buys nothing -- the finer 5s spacing it implies
  // is measurably worse in the tail, because the extra samples are mostly rounding noise.
  burn: {
    window_min: 15,
    min_span_s: 45,
    alpha: 0.35,
    max_samples: 60,
    reset_margin_min: 1,
    min_samples: 3
  },
  render: { bar_width: 10, color: true }
};
function loadConfig(projectDir) {
  let user = {};
  try {
    user = JSON.parse((0, import_node_fs2.readFileSync)(configPath(projectDir), "utf8"));
  } catch {
    return DEFAULT_CONFIG;
  }
  const out = { ...DEFAULT_CONFIG };
  for (const [k, v] of Object.entries(user)) {
    const base = DEFAULT_CONFIG[k];
    out[k] = v && typeof v === "object" && !Array.isArray(v) && base && typeof base === "object" ? { ...base, ...v } : v;
  }
  return out;
}

// src/sensors/statusline.ts
var import_node_path7 = require("node:path");

// src/core/spawn.ts
var import_node_child_process = require("node:child_process");
var import_node_fs3 = require("node:fs");
var import_node_os2 = require("node:os");
var import_node_path2 = require("node:path");
var PAYLOAD_NAMES = [/^stdin\.\d+\.\d+\.txt$/, /^chain-stdin\.\d+\.json$/];
var RESIDUE_MAX_AGE_MS = 10 * 60 * 1e3;
var RESIDUE_SWEEP_LIMIT = 200;
function sweepPayloadResidue(dir, limit = RESIDUE_SWEEP_LIMIT) {
  const cutoff = Date.now() - RESIDUE_MAX_AGE_MS;
  let removed = 0;
  try {
    for (const name of (0, import_node_fs3.readdirSync)(dir)) {
      if (removed >= limit) break;
      if (!PAYLOAD_NAMES.some((re) => re.test(name))) continue;
      const f = (0, import_node_path2.join)(dir, name);
      try {
        if ((0, import_node_fs3.statSync)(f).mtimeMs < cutoff) {
          (0, import_node_fs3.unlinkSync)(f);
          removed++;
        }
      } catch {
      }
    }
  } catch {
  }
  return removed;
}
var sweptDirs = /* @__PURE__ */ new Set();
function spawnWithStdinFile(cmd, args, stdin, opts) {
  const base = {
    encoding: "utf8",
    cwd: opts.cwd,
    timeout: Math.max(100, opts.timeoutMs),
    windowsHide: true,
    shell: opts.shell ?? false,
    env: opts.env ?? process.env
  };
  const run = (extra) => args === null ? (0, import_node_child_process.spawnSync)(cmd, { ...base, ...extra }) : (0, import_node_child_process.spawnSync)(cmd, args, { ...base, ...extra });
  const dir = opts.payloadDir ?? (0, import_node_os2.tmpdir)();
  if (!sweptDirs.has(dir)) {
    sweptDirs.add(dir);
    sweepPayloadResidue(dir);
  }
  const p = (0, import_node_path2.join)(dir, `stdin.${process.pid}.${Date.now()}.txt`);
  let fd = null;
  let named = true;
  try {
    try {
      (0, import_node_fs3.mkdirSync)(dir, { recursive: true });
      (0, import_node_fs3.writeFileSync)(p, stdin);
      fd = (0, import_node_fs3.openSync)(p, "r");
      try {
        (0, import_node_fs3.unlinkSync)(p);
        named = false;
      } catch {
      }
      return run({ stdio: [fd, "pipe", "pipe"] });
    } catch {
      return run({ input: stdin });
    }
  } finally {
    if (fd !== null) {
      try {
        (0, import_node_fs3.closeSync)(fd);
      } catch {
      }
    }
    if (named) {
      try {
        (0, import_node_fs3.unlinkSync)(p);
      } catch {
      }
    }
  }
}

// src/core/state.ts
var import_node_fs4 = require("node:fs");
var import_node_path3 = require("node:path");
function emptyState(sessionId) {
  return {
    schema: 1,
    session_id: sessionId,
    updated_at: 0,
    mode: "NORMAL",
    reason: "no observations yet",
    binding_axis: null,
    axes: {},
    cost_usd: null,
    model: null,
    agents: { live: 0, spawn_allowed: true },
    samples: [],
    latches: {},
    hard_stop: null,
    manifest: { sealed_at: null }
  };
}
var INF = "__Infinity__";
function replacer(_k, v) {
  return v === Infinity ? INF : v === -Infinity ? `-${INF}` : v;
}
function reviver(_k, v) {
  return v === INF ? Infinity : v === `-${INF}` ? -Infinity : v;
}
function readState(projectDir, sessionId) {
  try {
    const raw = JSON.parse((0, import_node_fs4.readFileSync)(statePath(projectDir, sessionId), "utf8"), reviver);
    if (raw?.schema !== 1) return emptyState(sessionId);
    return { ...emptyState(sessionId), ...raw };
  } catch {
    return emptyState(sessionId);
  }
}
function writeState(projectDir, state) {
  const p = statePath(projectDir, state.session_id);
  const tmp = `${p}.${process.pid}.tmp`;
  ensureGuardianDir(projectDir, (0, import_node_path3.dirname)(p));
  (0, import_node_fs4.writeFileSync)(tmp, JSON.stringify(state, replacer, 2));
  try {
    (0, import_node_fs4.renameSync)(tmp, p);
  } catch (err) {
    try {
      (0, import_node_fs4.unlinkSync)(tmp);
    } catch {
    }
    throw err;
  }
}

// src/budget/burn.ts
var EPS = 0.01;
var MIN_SPACING_S = 5;
function spacingS(cfg) {
  const retentionS = cfg.burn.window_min * 60 * 2;
  const budget = Math.max(2, Math.floor(cfg.burn.max_samples));
  return Math.max(MIN_SPACING_S, Math.ceil(retentionS / budget));
}
function recordSample(prev, next, cfg) {
  const out = prev.slice();
  const anchor = out[out.length - 2];
  if (anchor && next.t - anchor.t < spacingS(cfg)) out[out.length - 1] = next;
  else out.push(next);
  const cutoff = next.t - cfg.burn.window_min * 60 * 2;
  const trimmed = out.filter((s) => s.t >= cutoff);
  return trimmed.slice(-cfg.burn.max_samples);
}
function rawBurnRate(samples, axis, cfg, now2) {
  const pts = samples.filter((s) => typeof s[axis] === "number").map((s) => ({ t: s.t, v: s[axis] })).sort((a, b) => a.t - b.t);
  if (pts.length < 2) return null;
  let start = 0;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].v < pts[i - 1].v - EPS) start = i;
  }
  const windowStart = now2 - cfg.burn.window_min * 60;
  const recent = pts.slice(start).filter((p) => p.t >= windowStart);
  if (recent.length < Math.max(2, cfg.burn.min_samples)) return null;
  const first = recent[0];
  const last = recent[recent.length - 1];
  const spanS = last.t - first.t;
  if (spanS < cfg.burn.min_span_s) return null;
  const rate2 = (last.v - first.v) / (spanS / 60);
  return rate2 > 0 ? rate2 : null;
}
function smooth(raw, prev, alpha) {
  if (raw === null) return prev;
  if (prev === null) return raw;
  return alpha * raw + (1 - alpha) * prev;
}

// src/budget/mode.ts
function severity(m) {
  return MODES.indexOf(m);
}
function maxMode(a, b) {
  return severity(a) >= severity(b) ? a : b;
}
function timeToWall(usedPct, burnPctPerMin, resetsAt, now2, marginMin = 0) {
  if (usedPct === null) return null;
  if (resetsAt != null) {
    const resetInMin = (resetsAt - now2) / 60;
    if (resetInMin <= 0) return Infinity;
    if (burnPctPerMin === null || burnPctPerMin <= 0) return null;
    const headroom = headroomMin(usedPct, burnPctPerMin);
    return headroom > resetInMin + marginMin ? Infinity : headroom;
  }
  if (burnPctPerMin === null || burnPctPerMin <= 0) return null;
  return headroomMin(usedPct, burnPctPerMin);
}
function headroomMin(usedPct, burnPctPerMin) {
  return Math.max(0, (100 - usedPct) / burnPctPerMin);
}
function modeFromMinutes(ttw, cfg) {
  if (ttw === null || !Number.isFinite(ttw)) return "NORMAL";
  const t = cfg.thresholds_minutes;
  if (ttw <= t.emergency) return "EMERGENCY";
  if (ttw <= t.land) return "LAND";
  if (ttw <= t.prepare) return "PREPARE";
  if (ttw <= t.watch) return "WATCH";
  return "NORMAL";
}
function modeFromPercent(used, cfg) {
  if (used === null) return "NORMAL";
  const p = cfg.thresholds_percent_floor;
  if (used >= p.emergency) return "EMERGENCY";
  if (used >= p.land) return "LAND";
  if (used >= p.prepare) return "PREPARE";
  if (used >= p.watch) return "WATCH";
  return "NORMAL";
}
function axisMode(axis, st, cfg) {
  if (st.time_to_wall_min === Infinity) return "NORMAL";
  const m = maxMode(modeFromMinutes(st.time_to_wall_min, cfg), modeFromPercent(st.used_pct, cfg));
  const cap = cfg.axis_severity_cap[axis];
  return cap && severity(m) > severity(cap) ? cap : m;
}
var AXIS_LABEL = {
  context: "context",
  five_hour: "5-hour",
  seven_day: "7-day",
  spend: "spend"
};
function decide(axes, cfg, now2) {
  let best = null;
  for (const [name, st2] of Object.entries(axes)) {
    if (!cfg.axes[name]) continue;
    const m = st2.mode;
    if (m === "NORMAL") continue;
    if (!best || severity(m) > severity(best.mode) || severity(m) === severity(best.mode) && ttwRank(st2) < ttwRank(best.st)) {
      best = { axis: name, st: st2, mode: m };
    }
  }
  if (!best) return { mode: "NORMAL", binding_axis: null, reason: "all axes clear" };
  const { axis, st, mode } = best;
  const label = AXIS_LABEL[axis];
  const parts = [];
  if (st.used_pct !== null) parts.push(`${st.used_pct.toFixed(0)}% used`);
  if (st.time_to_wall_min !== null && Number.isFinite(st.time_to_wall_min)) {
    parts.push(`~${fmtMin(st.time_to_wall_min)} to wall`);
  } else {
    parts.push("burn rate not yet measurable");
  }
  if (st.resets_at != null) {
    const r = (st.resets_at - now2) / 60;
    if (r > 0) parts.push(`resets in ${fmtMin(r)}`);
  }
  return { mode, binding_axis: axis, reason: `${label}: ${parts.join(", ")}` };
}
function ttwRank(st) {
  return st.time_to_wall_min === null ? Number.MAX_SAFE_INTEGER : st.time_to_wall_min;
}
function fmtElapsed(m) {
  if (!Number.isFinite(m) || m < 1) return "<1m";
  return String(fmtMin(m));
}
function fmtMin(m) {
  if (!Number.isFinite(m)) return "\u221E";
  if (m <= 0) return "now";
  if (m < 1) return `${Math.max(1, Math.round(m * 60))}s`;
  if (m < 90) return `${Math.round(m)}m`;
  return `${(m / 60).toFixed(1)}h`;
}

// src/sensors/agents.ts
var import_node_fs6 = require("node:fs");
var import_node_path5 = require("node:path");

// src/core/agents.ts
var import_node_fs5 = require("node:fs");
var import_node_path4 = require("node:path");
function agentsPath(projectDir, sessionId) {
  return (0, import_node_path4.join)(stateDir(projectDir), "sessions", `${sanitize(sessionId)}.agents.json`);
}
function emptyAgents(sessionId) {
  return { schema: 1, session_id: sessionId, updated_at: 0, agents: {} };
}
function readAgents(projectDir, sessionId) {
  try {
    const f = JSON.parse((0, import_node_fs5.readFileSync)(agentsPath(projectDir, sessionId), "utf8"));
    return f?.schema === 1 ? f : emptyAgents(sessionId);
  } catch {
    return emptyAgents(sessionId);
  }
}
function isLive(a, now2, staleAfterS = 120) {
  return now2 - a.last_seen <= staleAfterS;
}
function liveCount(f, now2, staleAfterS = 120) {
  return Object.values(f.agents).filter((a) => isLive(a, now2, staleAfterS)).length;
}

// src/sensors/agents.ts
var MAX_SAMPLES = 40;
var MAX_DURATIONS = 50;
function statsPath(projectDir) {
  return (0, import_node_path5.join)(stateDir(projectDir), "agent-stats.json");
}
function writeAtomic(projectDir, p, content) {
  ensureGuardianDir(projectDir, (0, import_node_path5.dirname)(p));
  const tmp = `${p}.${process.pid}.tmp`;
  (0, import_node_fs6.writeFileSync)(tmp, content);
  (0, import_node_fs6.renameSync)(tmp, p);
}
function writeAgents(projectDir, f) {
  writeAtomic(projectDir, agentsPath(projectDir, f.session_id), `${JSON.stringify(f, null, 2)}
`);
}
function toEpochSeconds(v) {
  if (v === void 0 || v === null) return null;
  const n = typeof v === "string" ? Date.parse(v) / 1e3 : v;
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 1e11 ? n / 1e3 : n;
}
function rate(samples) {
  if (samples.length < 2) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const spanS = last.t - first.t;
  if (spanS < 20) return null;
  const delta = last.tokens - first.tokens;
  if (delta <= 0) return null;
  return delta / (spanS / 60);
}
function updateAgents(prev, rows, now2) {
  const agents = {};
  for (const row of rows) {
    const id = row.id;
    if (!id) continue;
    const old = prev.agents[id];
    const tokens = typeof row.tokenCount === "number" ? row.tokenCount : null;
    let samples = old?.samples ?? [];
    if (tokens !== null) {
      const last = samples[samples.length - 1];
      if (last && now2 - last.t < 5) samples = [...samples.slice(0, -1), { t: now2, tokens }];
      else samples = [...samples, { t: now2, tokens }];
      samples = samples.slice(-MAX_SAMPLES);
    }
    agents[id] = {
      id,
      name: row.name ?? old?.name ?? null,
      type: row.type ?? old?.type ?? null,
      status: row.status ?? null,
      description: row.description ?? row.label ?? old?.description ?? null,
      started_at: toEpochSeconds(row.startTime) ?? old?.started_at ?? null,
      token_count: tokens ?? old?.token_count ?? null,
      context_window: typeof row.contextWindowSize === "number" ? row.contextWindowSize : old?.context_window ?? null,
      samples,
      tokens_per_min: rate(samples),
      last_seen: now2
    };
  }
  return { schema: 1, session_id: prev.session_id, updated_at: now2, agents };
}
function readStatsFile(projectDir) {
  try {
    const f = JSON.parse((0, import_node_fs6.readFileSync)(statsPath(projectDir), "utf8"));
    return f?.schema === 1 ? f : { schema: 1, types: {} };
  } catch {
    return { schema: 1, types: {} };
  }
}
function typeStats(projectDir) {
  const f = readStatsFile(projectDir);
  const out = {};
  for (const [type, { durations }] of Object.entries(f.types)) {
    if (!durations?.length) continue;
    const sorted = [...durations].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    out[type] = {
      count: sorted.length,
      median_s: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
    };
  }
  return out;
}
function recordDuration(projectDir, type, seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 6 * 3600) return;
  const f = readStatsFile(projectDir);
  const entry = f.types[type] ?? { durations: [] };
  entry.durations = [...entry.durations, Math.round(seconds)].slice(-MAX_DURATIONS);
  f.types[type] = entry;
  writeAtomic(projectDir, statsPath(projectDir), `${JSON.stringify(f)}
`);
}
function contextWallMin(a) {
  if (!a.context_window || a.token_count === null || !a.tokens_per_min) return null;
  const remaining = a.context_window - a.token_count;
  if (remaining <= 0) return 0;
  return remaining / a.tokens_per_min;
}

// src/format/render.ts
var C = {
  reset: "\x1B[0m",
  dim: "\x1B[2m",
  green: "\x1B[32m",
  amber: "\x1B[33m",
  amberBold: "\x1B[1;33m",
  red: "\x1B[31m",
  redBold: "\x1B[1;31m",
  redInv: "\x1B[1;41;97m"
};
var MODE_COLOR = {
  NORMAL: C.dim,
  WATCH: C.amber,
  PREPARE: C.amberBold,
  LAND: C.red,
  EMERGENCY: C.redInv,
  HARD_STOPPED: C.redInv
};
var AXIS_COLOR = {
  NORMAL: C.green,
  WATCH: C.amber,
  PREPARE: C.amberBold,
  LAND: C.red,
  EMERGENCY: C.redInv,
  HARD_STOPPED: C.redInv
};
function bar(pct2, width) {
  const filled = Math.max(0, Math.min(width, Math.round(pct2 / 100 * width)));
  return "\u2593".repeat(filled) + "\u2591".repeat(width - filled);
}
function axisSegment(label, st, cfg, paint) {
  if (!st || st.used_pct === null) return null;
  const pct2 = st.used_pct;
  let seg = `${bar(pct2, cfg.render.bar_width)} ${pct2.toFixed(0)}%`;
  if (st.time_to_wall_min !== null && Number.isFinite(st.time_to_wall_min)) {
    seg += ` \u26A0 ~${fmtMin(st.time_to_wall_min)}`;
  }
  return `${label} ${paint(seg, AXIS_COLOR[st.mode])}`;
}
function fmtTokens(n) {
  if (!Number.isFinite(n) || n < 0) return "?";
  if (n >= 1e6) {
    const m = n / 1e6;
    return `${m >= 10 || Number.isInteger(m) ? m.toFixed(0) : m.toFixed(1)}M`;
  }
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
  if (n >= 1e3) return `${(Math.round(n / 100) / 10).toFixed(1)}k`;
  return `${Math.round(n)}`;
}
function renderStatus(state, cfg) {
  const color = cfg.render.color;
  const paint = (s, c) => color ? `${c}${s}${C.reset}` : s;
  const segs = [];
  const ctx = axisSegment("ctx", state.axes.context, cfg, paint);
  if (ctx) segs.push(ctx);
  const fh = axisSegment("5h", state.axes.five_hour, cfg, paint);
  if (fh) segs.push(fh);
  const wk = axisSegment("7d", state.axes.seven_day, cfg, paint);
  if (wk) segs.push(wk);
  if (state.cost_usd != null) segs.push(`$${state.cost_usd.toFixed(2)}`);
  const body = segs.length ? segs.join("  ") : "guardian: awaiting first API response";
  const tag = state.mode === "NORMAL" ? "\u{1F6E1}" : `\u{1F6E1} ${state.mode}`;
  return `${paint(tag, MODE_COLOR[state.mode])} ${body}`;
}
function renderDashboard(state, cfg) {
  const paint = (s, c) => cfg.render.color ? `${c}${s}${C.reset}` : s;
  const rows = [];
  rows.push("\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557");
  rows.push(`\u2551 CLAUDE SESSION GUARDIAN${" ".repeat(39)}\u2551`);
  rows.push("\u2560\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2563");
  const pad = (s) => `\u2551 ${s}${" ".repeat(Math.max(0, 62 - vislen(s)))}\u2551`;
  rows.push(pad(`Mode:     ${state.mode}`));
  rows.push(pad(`Why:      ${state.reason}`));
  rows.push(pad(""));
  for (const [name, st] of Object.entries(state.axes)) {
    if (!st || st.used_pct === null) continue;
    const ttw = st.time_to_wall_min === null ? "unknown" : Number.isFinite(st.time_to_wall_min) ? `~${fmtMin(st.time_to_wall_min)}` : "refills first";
    const burn = st.burn_pct_per_min === null ? "\u2014" : `${st.burn_pct_per_min.toFixed(2)} %/min`;
    const gauge = `${bar(st.used_pct, cfg.render.bar_width)} ${st.used_pct.toFixed(1).padStart(5)}%`;
    rows.push(
      pad(
        `${name.padEnd(10)} ${paint(gauge, AXIS_COLOR[st.mode])}  burn ${burn.padEnd(12)} wall ${ttw}`
      )
    );
  }
  rows.push(pad(""));
  const gate = state.agents.spawn_allowed ? "allowed" : "BLOCKED";
  rows.push(pad(`Agents:   ${state.agents.live} live, new spawns ${gate}`));
  rows.push(pad(`Samples:  ${state.samples.length}`));
  rows.push(
    pad(`Manifest: ${state.manifest.sealed_at ? new Date(state.manifest.sealed_at * 1e3).toISOString() : "not sealed"}`)
  );
  rows.push("\u255A\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255D");
  return rows.join("\n");
}
function vislen(s) {
  return [...s.replace(/\x1b\[[0-9;]*m/g, "")].length;
}

// src/core/log.ts
var import_node_fs7 = require("node:fs");
var import_node_path6 = require("node:path");
function log(projectDir, level, msg) {
  try {
    const line = `${(/* @__PURE__ */ new Date()).toISOString()} ${level.toUpperCase()} ${msg}
`;
    const p = logPath(projectDir);
    ensureGuardianDir(projectDir, (0, import_node_path6.dirname)(p));
    (0, import_node_fs7.appendFileSync)(p, line);
  } catch {
  }
}

// src/sensors/statusline.ts
function resolveProjectDir(p) {
  const start = p.workspace?.project_dir || p.workspace?.current_dir || p.cwd || process.cwd();
  return resolveStateRoot(start);
}
function pct(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : void 0;
}
function sampleFrom(p, now2) {
  const rl = p.rate_limits ?? void 0;
  const s = { t: now2 };
  const ctx = pct(p.context_window?.used_percentage);
  if (ctx !== void 0) s.context = ctx;
  const fh = pct(rl?.five_hour?.used_percentage);
  if (fh !== void 0) s.five_hour = fh;
  const sd = pct(rl?.seven_day?.used_percentage);
  if (sd !== void 0) s.seven_day = sd;
  const sp = pct(rl?.spend_limit?.used_percentage);
  if (sp !== void 0) s.spend = sp;
  return s;
}
function resetsAtFor(p, axis) {
  const rl = p.rate_limits ?? void 0;
  switch (axis) {
    case "five_hour":
      return pct(rl?.five_hour?.resets_at) ?? null;
    case "seven_day":
      return pct(rl?.seven_day?.resets_at) ?? null;
    case "spend":
      return pct(rl?.spend_limit?.resets_at) ?? null;
    default:
      return null;
  }
}
function computeState(prev, payload, cfg, now2, agentsLive = 0) {
  const samples = recordSample(prev.samples, sampleFrom(payload, now2), cfg);
  const latest = samples[samples.length - 1];
  const axes = {};
  for (const axis of AXES) {
    if (!cfg.axes[axis]) continue;
    const observed = latest?.[axis];
    const used = observed ?? prev.axes[axis]?.used_pct ?? null;
    if (used === null) continue;
    const burn = smooth(
      rawBurnRate(samples, axis, cfg, now2),
      prev.axes[axis]?.burn_pct_per_min ?? null,
      cfg.burn.alpha
    );
    const resetsAt = resetsAtFor(payload, axis) ?? prev.axes[axis]?.resets_at ?? null;
    const st = {
      used_pct: used,
      burn_pct_per_min: burn,
      resets_at: resetsAt,
      time_to_wall_min: null,
      mode: "NORMAL"
    };
    st.time_to_wall_min = timeToWall(
      st.used_pct,
      st.burn_pct_per_min,
      st.resets_at,
      now2,
      cfg.burn.reset_margin_min
    );
    st.mode = axisMode(axis, st, cfg);
    axes[axis] = st;
  }
  const d = decide(axes, cfg, now2);
  const stillStopped = prev.mode === "HARD_STOPPED" && Object.values(axes).some((a) => a?.resets_at != null && a.resets_at > now2);
  const mode = stillStopped ? "HARD_STOPPED" : d.mode;
  return {
    ...prev,
    schema: 1,
    updated_at: now2,
    mode,
    reason: stillStopped ? prev.reason : d.reason,
    binding_axis: stillStopped ? prev.binding_axis : d.binding_axis,
    axes,
    samples,
    cost_usd: pct(payload.cost?.total_cost_usd) ?? prev.cost_usd,
    model: payload.model?.display_name ?? prev.model,
    agents: {
      live: agentsLive,
      spawn_allowed: severity(mode) < severity(cfg.agents.deny_spawn_from)
    }
  };
}
function expandVars(cmd, env) {
  return cmd.replace(/\$\{(\w+)(?::-([^}]*))?\}/g, (_m, name, fallback) => {
    const v = env[name];
    return v !== void 0 && v !== "" ? v : fallback ?? "";
  }).replace(/\$(\w+)/g, (m, name) => env[name] ?? m);
}
function spawnChained(cmd, stdin, projectDir, cfg, env) {
  const dir = stateDir(projectDir);
  try {
    ensureGuardianDir(projectDir, dir);
  } catch {
  }
  return spawnWithStdinFile(cmd, null, stdin, {
    timeoutMs: cfg.statusline.chain_timeout_ms,
    shell: true,
    env,
    payloadDir: dir
  });
}
function chainedCachePath(projectDir) {
  return (0, import_node_path7.join)(stateDir(projectDir), "chained-bar.txt");
}
var CHAINED_CACHE_MAX_AGE_S = 600;
function keepChained(projectDir, text2, now2) {
  try {
    const p = chainedCachePath(projectDir);
    ensureGuardianDir(projectDir, (0, import_node_path7.dirname)(p));
    const tmp = `${p}.${process.pid}.tmp`;
    (0, import_node_fs8.writeFileSync)(tmp, `${Math.floor(now2)}
${text2}`);
    (0, import_node_fs8.renameSync)(tmp, p);
  } catch {
  }
}
function lastChained(projectDir, now2) {
  try {
    const raw = (0, import_node_fs8.readFileSync)(chainedCachePath(projectDir), "utf8");
    const nl = raw.indexOf("\n");
    if (nl < 0) return null;
    const t = Number(raw.slice(0, nl));
    const text2 = raw.slice(nl + 1);
    if (!Number.isFinite(t) || !text2.trim()) return null;
    const age = Math.max(0, now2 - t);
    return age <= CHAINED_CACHE_MAX_AGE_S ? { text: text2, age_s: age } : null;
  } catch {
    return null;
  }
}
function runChained(cmd, stdin, projectDir, cfg, now2) {
  try {
    const env = { ...process.env, CLAUDE_PROJECT_DIR: projectDir };
    const r = spawnChained(expandVars(cmd, env), stdin, projectDir, cfg, env);
    const text2 = (r.stdout ?? "").trim();
    if (text2) {
      keepChained(projectDir, text2, now2);
      return { text: text2, source: "fresh" };
    }
    if (r.signal || r.error || r.status !== 0) {
      const why = r.signal ? `killed after ${cfg.statusline.chain_timeout_ms}ms` : r.error?.message ?? `exit ${r.status}`;
      const kept = lastChained(projectDir, now2);
      log(
        projectDir,
        "warn",
        `chained status line produced nothing (${why}): ${cmd}` + (kept ? ` \u2014 showing the bar from ${Math.round(kept.age_s)}s ago` : "")
      );
      if (kept) return { text: kept.text, source: "cached", age_s: kept.age_s };
      return { text: r.signal ? "\u22EF" : "", source: "none" };
    }
    return { text: "", source: "none" };
  } catch {
    return { text: "", source: "none" };
  }
}
function lateMark(age_s, color) {
  const age = age_s < 60 ? "" : `${Math.round(age_s / 60)}m`;
  const mark = `\u22EF${age}`;
  return color ? `\x1B[2m${mark}\x1B[0m` : mark;
}
function probeChained(projectDir, cfg, now2 = Date.now() / 1e3) {
  const cmd = liveChainedCommand(cfg, projectDir);
  if (!cmd) return { cmd: null, ok: true };
  const payload = JSON.stringify({ session_id: "guardian-doctor", cwd: projectDir });
  return { cmd, ok: runChained(cmd, payload, projectDir, cfg, now2).source === "fresh" };
}
function liveChainedCommand(cfg, projectDir) {
  const snapshot = cfg.statusline.chained_command;
  const from = cfg.statusline.chained_from;
  if (!from) return snapshot;
  try {
    const cmd = JSON.parse((0, import_node_fs8.readFileSync)(from, "utf8")).statusLine?.command;
    if (typeof cmd === "string" && cmd && !cmd.includes("guardian.cjs")) return cmd;
  } catch {
  }
  return snapshot;
}
function sense(raw, now2 = Date.now() / 1e3) {
  let payload = {};
  try {
    payload = JSON.parse(raw);
  } catch {
  }
  const projectDir = resolveProjectDir(payload);
  const cfg = loadConfig(projectDir);
  const toChain = liveChainedCommand(cfg, projectDir);
  const run = toChain ? runChained(toChain, raw, projectDir, cfg, now2) : { text: "", source: "none" };
  const chained = run.source === "cached" ? `${run.text} ${lateMark(run.age_s ?? 0, cfg.render.color)}` : run.text;
  if (!cfg.enabled) return chained;
  let line = "";
  try {
    const sessionId = payload.session_id || "unknown";
    const live = liveCount(readAgents(projectDir, sessionId), now2);
    const next = computeState(readState(projectDir, sessionId), payload, cfg, now2, live);
    writeState(projectDir, next);
    line = renderStatus(next, cfg);
  } catch (err) {
    log(projectDir, "error", `sense failed: ${err?.stack ?? String(err)}`);
    return chained;
  }
  if (!chained) return line;
  return cfg.statusline.own_line ? `${chained}
${line}` : `${chained}  ${line}`;
}

// src/sensors/subagents.ts
function renderAgentRow(a, stats, now2, columns) {
  const parts = [];
  parts.push(a.name ?? a.type ?? a.id.slice(0, 8));
  if (a.context_window && a.token_count !== null) {
    const pct2 = (a.token_count / a.context_window * 100).toFixed(0);
    parts.push(`ctx ${fmtTokens(a.token_count)}/${fmtTokens(a.context_window)} (${pct2}%)`);
  } else if (a.token_count !== null) {
    parts.push(`ctx ${fmtTokens(a.token_count)}`);
  }
  if (a.started_at) {
    const elapsed = (now2 - a.started_at) / 60;
    const typical = a.type ? stats[a.type] : void 0;
    parts.push(
      typical ? `${fmtElapsed(elapsed)} of \u2248${fmtMin(typical.median_s / 60)} (n=${typical.count})` : `${fmtElapsed(elapsed)} elapsed`
    );
  }
  const wall = contextWallMin(a);
  if (wall !== null && wall <= 5) parts.push(`\u26A0 ctx full ~${fmtMin(wall)}`);
  const meters = parts.slice(1);
  const head = parts[0];
  if (!a.description) return clip(parts.join(" \xB7 "), columns);
  const fixed = [head, ...meters].join(" \xB7 ").length + " \xB7 ".length;
  const room = columns > 10 ? columns - fixed : a.description.length;
  const desc = room >= 12 ? clip(a.description, room) : null;
  return clip([head, ...desc ? [desc] : [], ...meters].join(" \xB7 "), columns);
}
function clip(s, columns) {
  return columns > 10 && s.length > columns ? `${s.slice(0, columns - 1)}\u2026` : s;
}
function senseAgents(raw, now2 = Date.now() / 1e3) {
  let payload = {};
  try {
    payload = JSON.parse(raw);
  } catch {
    return "";
  }
  const projectDir = resolveStateRoot(payload.cwd || process.cwd());
  const rows = Array.isArray(payload.tasks) ? payload.tasks : [];
  if (!rows.length) return "";
  try {
    const cfg = loadConfig(projectDir);
    if (!cfg.enabled) return "";
    const sid = payload.session_id || "unknown";
    const next = updateAgents(readAgents(projectDir, sid), rows, now2);
    writeAgents(projectDir, next);
    const stats = typeStats(projectDir);
    const columns = typeof payload.columns === "number" ? payload.columns : 80;
    return Object.values(next.agents).map((a) => JSON.stringify({ id: a.id, content: renderAgentRow(a, stats, now2, columns) })).join("\n");
  } catch (err) {
    log(projectDir, "error", `sense-agents failed: ${err?.stack ?? String(err)}`);
    return "";
  }
}

// src/ui/install.ts
var import_node_fs9 = require("node:fs");
var import_node_path8 = require("node:path");
var BUNDLE = "guardian.cjs";
var MARKER = BUNDLE;
function bundlePath() {
  const running = typeof __filename === "string" ? __filename : process.argv[1] ?? "";
  const candidates = [
    // Explicit override, for development and for tests.
    process.env.GUARDIAN_BUNDLE,
    // Set whenever Guardian runs as an installed plugin.
    process.env.CLAUDE_PLUGIN_ROOT ? (0, import_node_path8.join)(process.env.CLAUDE_PLUGIN_ROOT, "dist", "guardian.cjs") : null,
    // Normal case: we *are* the bundle.
    running.endsWith(BUNDLE) ? running : null,
    // Local checkout, or any other host file: find the bundle above us.
    findUp(running ? (0, import_node_path8.dirname)(running) : process.cwd())
  ];
  const p = candidates.find((c) => !!c) ?? (0, import_node_path8.join)(process.cwd(), "dist", BUNDLE);
  return p.replace(/\\/g, "/");
}
function findUp(from, levels = 5) {
  let dir = (0, import_node_path8.resolve)(from);
  for (let i = 0; i <= levels; i++) {
    const candidate = (0, import_node_path8.join)(dir, "dist", BUNDLE);
    if ((0, import_node_fs9.existsSync)(candidate)) return candidate;
    const parent = (0, import_node_path8.dirname)(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
function guardianCommand(sub) {
  return `node "${bundlePath()}" ${sub}`;
}
function readJson(p) {
  try {
    return JSON.parse((0, import_node_fs9.readFileSync)(p, "utf8"));
  } catch {
    return {};
  }
}
function writeJson(p, obj) {
  (0, import_node_fs9.mkdirSync)((0, import_node_path8.dirname)(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  (0, import_node_fs9.writeFileSync)(tmp, `${JSON.stringify(obj, null, 2)}
`);
  (0, import_node_fs9.renameSync)(tmp, p);
}
function install(projectDir, settingsFile = userSettingsPath()) {
  const settings = readJson(settingsFile);
  const existing = settings.statusLine;
  const existingCmd = typeof existing?.command === "string" ? existing.command : null;
  const alreadyInstalled = !!existingCmd?.includes(MARKER);
  let chained = null;
  if (existingCmd && !alreadyInstalled) chained = existingCmd;
  settings.statusLine = {
    type: "command",
    command: guardianCommand("sense"),
    // Event-driven updates go quiet while the main session waits on background subagents;
    // a timer keeps the reset clock and burn rate honest during those stretches.
    refreshInterval: 10
  };
  settings.subagentStatusLine = {
    type: "command",
    command: guardianCommand("sense-agents")
  };
  writeJson(settingsFile, settings);
  const cfg = loadConfig(projectDir);
  const next = {
    ...cfg,
    statusline: {
      ...cfg.statusline,
      manage: true,
      chained_command: chained ?? cfg.statusline.chained_command
    }
  };
  writeJson(configPath(projectDir), next);
  scaffoldStateDir(projectDir);
  return { settingsFile, chained, alreadyInstalled };
}
function init(startDir, userSettings = userSettingsPath()) {
  const projectDir = resolveStateRoot(startDir);
  const chain = settingsChain(projectDir, userSettings);
  let settingsFile = chain[0];
  let existingCmd = null;
  let chainedFrom = null;
  let chainedCmd = null;
  for (const file of chain) {
    const cmd = readJson(file).statusLine?.command;
    if (typeof cmd === "string") {
      settingsFile = file;
      existingCmd = cmd;
      if (!cmd.includes(MARKER)) {
        chainedFrom = file;
        chainedCmd = cmd;
      }
    }
  }
  const alreadySensing = !!existingCmd?.includes(MARKER);
  const chained = chainedCmd;
  const target = settingsFile === chain[0] ? chain[0] : chain[2];
  scaffoldStateDir(projectDir);
  if (!alreadySensing) {
    const settings = readJson(target);
    settings.statusLine = {
      type: "command",
      command: guardianCommand("sense"),
      refreshInterval: 10
    };
    settings.subagentStatusLine = { type: "command", command: guardianCommand("sense-agents") };
    writeJson(target, settings);
  }
  const cfg = loadConfig(projectDir);
  writeJson(configPath(projectDir), {
    ...cfg,
    statusline: {
      ...cfg.statusline,
      manage: true,
      // Only overwrite when something was actually displaced: re-running init must not
      // erase a chained command recorded by an earlier run.
      chained_command: chained ?? cfg.statusline.chained_command,
      // Remember where it came from, not just what it said. Tools that manage their own
      // status line rewrite it — hive does — and a snapshot taken at init would keep
      // running last month's command while the tool's updates went nowhere.
      chained_from: chainedFrom ?? cfg.statusline.chained_from
    }
  });
  const scope = target === chain[0] ? "user" : "project-local";
  const displaced = chainedFrom ?? settingsFile;
  return { projectDir, settingsFile: target, displaced, scope, chained, alreadySensing };
}
function findGuardianSettings(projectDir, userSettings = userSettingsPath()) {
  for (const file of settingsChain(projectDir, userSettings).reverse()) {
    const cmd = readJson(file).statusLine?.command;
    if (typeof cmd === "string" && cmd.includes(MARKER)) return file;
  }
  return null;
}
function uninstall(projectDir, settingsFile = userSettingsPath()) {
  const settings = readJson(settingsFile);
  const existing = settings.statusLine;
  const cfg = loadConfig(projectDir);
  const restore = cfg.statusline.chained_command;
  const owned = !settingsChain(projectDir).slice(0, Math.max(0, settingsChain(projectDir).indexOf(settingsFile))).some((f) => readJson(f).statusLine?.command === restore);
  const sub = settings.subagentStatusLine;
  let changed = false;
  if (typeof existing?.command === "string" && existing.command.includes(MARKER)) {
    if (restore && owned) settings.statusLine = { type: "command", command: restore };
    else delete settings.statusLine;
    changed = true;
  }
  if (typeof sub?.command === "string" && sub.command.includes(MARKER)) {
    delete settings.subagentStatusLine;
    changed = true;
  }
  if (changed) writeJson(settingsFile, settings);
  writeJson(configPath(projectDir), {
    ...cfg,
    statusline: { ...cfg.statusline, manage: false, chained_command: null }
  });
  return restore;
}
function scaffoldStateDir(projectDir) {
  const dir = stateDir(projectDir);
  (0, import_node_fs9.mkdirSync)((0, import_node_path8.join)(dir, "sessions"), { recursive: true });
  (0, import_node_fs9.mkdirSync)((0, import_node_path8.join)(dir, "logs"), { recursive: true });
  const ignore = (0, import_node_path8.join)(dir, ".gitignore");
  if (!(0, import_node_fs9.existsSync)(ignore)) (0, import_node_fs9.writeFileSync)(ignore, "*\n");
  const cfgFile = configPath(projectDir);
  if (!(0, import_node_fs9.existsSync)(cfgFile)) writeJson(cfgFile, DEFAULT_CONFIG);
}

// src/actuators/dispatch.ts
var import_node_child_process3 = require("node:child_process");
var import_node_fs14 = require("node:fs");
var import_node_path13 = require("node:path");

// src/handoff/ledger.ts
var import_node_fs10 = require("node:fs");
var import_node_crypto = require("node:crypto");
var import_node_path9 = require("node:path");

// src/handoff/redact.ts
var SECRET_NAME = "[A-Za-z0-9_-]*(?:token|secret|password|passwd|pwd|apikey|api[_-]?key|auth|credential|private[_-]?key|access[_-]?key)[A-Za-z0-9_-]*";
var SECRET_HEADER = "Authorization|Proxy-Authorization|X-Api-Key|X-Auth-Token|Cookie|Set-Cookie";
var RULES = [
  // 1. Known-shape tokens. Unambiguous on sight, so they go first and match anywhere.
  [/sk-ant-[A-Za-z0-9_-]{8,}/g, "sk-ant-[REDACTED]"],
  [/sk-[A-Za-z0-9]{20,}/g, "sk-[REDACTED]"],
  [/gh[pousr]_[A-Za-z0-9]{16,}/g, "gh_[REDACTED]"],
  [/github_pat_[A-Za-z0-9_]{20,}/g, "github_pat_[REDACTED]"],
  [/xox[abposr]-[A-Za-z0-9-]{10,}/g, "xox-[REDACTED]"],
  [/AKIA[0-9A-Z]{16}/g, "AKIA[REDACTED]"],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, "[REDACTED-JWT]"],
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    "[REDACTED-PRIVATE-KEY]"
  ],
  // 2. Colon form: `Authorization: Bearer xyz`, `api_token: xyz`. The value runs to the
  //    end of the line or the enclosing quote — stopping at the first space would leave
  //    the token itself in place, which is the whole point of the rule.
  [new RegExp(`\\b(${SECRET_HEADER}|${SECRET_NAME})(\\s*:\\s*)([^\\n"']+)`, "gi"), "$1$2[REDACTED]"],
  // 3. Assignment form: `API_KEY=xyz`, `--token xyz`, `DB_PASSWORD="xyz"`. Separate from
  //    the colon form so neither mangles the other's separator.
  [
    new RegExp(`\\b(${SECRET_NAME})(\\s*=\\s*)("[^"]*"|'[^']*'|\\S+)`, "gi"),
    "$1$2[REDACTED]"
  ],
  [
    new RegExp(`(--(?:${SECRET_NAME}))(\\s+)("[^"]*"|'[^']*'|[^-\\s]\\S*)`, "gi"),
    "$1$2[REDACTED]"
  ],
  // 4. Credentials embedded in a URL.
  [/([a-z][a-z0-9+.-]*:\/\/)([^:/@\s]+):([^@\s]+)@/gi, "$1$2:[REDACTED]@"]
];
function redact(text2) {
  if (!text2) return text2;
  let out = text2;
  for (const [re, sub] of RULES) out = out.replace(re, sub);
  return out;
}
function clip2(text2, max = 400) {
  if (text2.length <= max) return text2;
  return `${text2.slice(0, max)}\u2026 (+${text2.length - max} chars)`;
}

// src/handoff/ledger.ts
function appendEvent(projectDir, sessionId, ev) {
  const p = ledgerPath(projectDir, sessionId);
  ensureGuardianDir(projectDir, (0, import_node_path9.dirname)(p));
  (0, import_node_fs10.appendFileSync)(p, `${JSON.stringify(ev)}
`);
}
function readLedger(projectDir, sessionId) {
  let raw;
  try {
    raw = (0, import_node_fs10.readFileSync)(ledgerPath(projectDir, sessionId), "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
    }
  }
  return out;
}
var HASH_LIMIT = 4 * 1024 * 1024;
function hashFile(path) {
  try {
    const st = (0, import_node_fs10.statSync)(path);
    if (!st.isFile()) return { sha256: null, bytes: null };
    if (st.size > HASH_LIMIT) return { sha256: null, bytes: st.size };
    const h = (0, import_node_crypto.createHash)("sha256").update((0, import_node_fs10.readFileSync)(path)).digest("hex");
    return { sha256: h, bytes: st.size };
  } catch {
    return { sha256: null, bytes: null };
  }
}
var TEST_RE = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|check)\b|\bnode\s+--test\b|\bpytest\b|\bgo\s+test\b|\bcargo\s+test\b|\bdotnet\s+test\b|\bmvn\s+test\b|\bjest\b|\bvitest\b|\brspec\b/;
var BUILD_RE = /\b(npm|pnpm|yarn|bun)\s+run\s+build\b|\btsc\b|\bcargo\s+build\b|\bgo\s+build\b|\bdotnet\s+build\b|\bmake\b|\bwebpack\b|\bvite\s+build\b/;
var GIT_RE = /^\s*git\s/;
function commandHead(cmd) {
  const stripped = stripHeredocs(cmd);
  const i = stripped.indexOf("<<");
  return i === -1 ? stripped : stripped.slice(0, i);
}
function stripHeredocs(cmd) {
  return cmd.replace(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*?^\2[ \t]*$/gm, "");
}
function stripQuoted(s) {
  return s.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
}
function classifyCommand(cmd) {
  const head = stripQuoted(commandHead(cmd));
  if (TEST_RE.test(head)) return "test";
  if (BUILD_RE.test(head)) return "build";
  if (GIT_RE.test(head)) return "git";
  return "other";
}
function testCommand(cmd) {
  for (const segment of commandHead(cmd).split(/;|&&|\|\||\n/)) {
    if (!TEST_RE.test(stripQuoted(segment))) continue;
    const bare = segment.split("|")[0].replace(/\d?>&?\d?\s*\S*/g, "").trim();
    if (bare) return bare;
  }
  return null;
}
function mentionsGitCommit(cmd) {
  const head = stripQuoted(commandHead(cmd));
  return /\bgit\b[^|;&\n]*\bcommit\b/.test(head) && !/--dry-run/.test(head);
}
function inferOk(output) {
  const s = output.slice(-4e3);
  if (/\bfail(ed|ures?)?\b|\berror\b|✖|not ok|Traceback|panic:/i.test(s)) {
    if (/\b0 (failures?|errors?)\b|fail 0|failures: 0/i.test(s) && !/✖|\bFAILED\b/.test(s)) {
      return true;
    }
    return false;
  }
  if (/\bpass(ed|ing)?\b|\bok\b|✔|\bsucce(ss|eded)\b|\bbuilt\b|Done in/i.test(s)) return true;
  return null;
}
function fileEvent(path, tool, t) {
  const { sha256, bytes } = hashFile(path);
  return { k: "file", t, path, sha256, bytes, tool };
}
function commandEvent(cmd, output, t) {
  return {
    k: "command",
    t,
    command: clip2(redact(cmd), 300),
    kind: classifyCommand(cmd),
    ok: inferOk(output)
  };
}

// src/handoff/manifest.ts
var import_node_fs12 = require("node:fs");
var import_node_path11 = require("node:path");

// src/handoff/git.ts
var import_node_child_process2 = require("node:child_process");
var import_node_fs11 = require("node:fs");
var import_node_os3 = require("node:os");
var import_node_path10 = require("node:path");
var GIT_TIMEOUT_MS = 3e4;
function git(cwd, args, env) {
  try {
    const r = (0, import_node_child_process2.spawnSync)("git", args, {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      env: { ...process.env, ...env }
    });
    const killed = r.error ? `${r.error.message}${r.signal ? ` (${r.signal} after ${GIT_TIMEOUT_MS}ms)` : ""}` : "";
    return {
      ok: r.status === 0,
      out: (r.stdout ?? "").trim(),
      err: [killed, r.stderr ?? ""].filter(Boolean).join("\n").trim()
    };
  } catch (e) {
    return { ok: false, out: "", err: e.message };
  }
}
function failureReason(step, err) {
  const lines = err.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const named = lines.filter((l) => /^(?:fatal|error):/.test(l));
  const first = named[0] ?? lines.find((l) => !/^(?:warning|hint):/.test(l));
  if (!first) return `${step} failed`;
  const more = named.length > 1 ? ` (+${named.length - 1} more)` : "";
  return `${step} failed: ${first.slice(0, 180)}${more}`;
}
function failed(step, res) {
  return new Error(failureReason(step, res.err));
}
function refComponent(s) {
  const cleaned = s.replace(/[^A-Za-z0-9_-]/g, "_").replace(/^[-_]+/, "").replace(/[-_]+$/, "");
  return cleaned || "unknown";
}
function isRepo(cwd) {
  return git(cwd, ["rev-parse", "--is-inside-work-tree"]).out === "true";
}
function dirtyCount(cwd) {
  const r = git(cwd, ["status", "--porcelain"]);
  return r.ok ? r.out.split("\n").filter((l) => l.trim()).length : 0;
}
function checkpoint(projectDir, sessionId, stamp) {
  const base = {
    kind: "none",
    ref: null,
    sha: null,
    branch: null,
    head: null,
    dirty_files: 0,
    detail: ""
  };
  if (!isRepo(projectDir)) {
    return { ...base, kind: "none", detail: "not a git repository" };
  }
  const branch = git(projectDir, ["rev-parse", "--abbrev-ref", "HEAD"]).out || null;
  const headRes = git(projectDir, ["rev-parse", "HEAD"]);
  const head = headRes.ok ? headRes.out : null;
  const dirty = dirtyCount(projectDir);
  const ref = `refs/guardian/${refComponent(sessionId)}/${refComponent(stamp)}`;
  let tmp = null;
  try {
    tmp = (0, import_node_fs11.mkdtempSync)((0, import_node_path10.join)((0, import_node_os3.tmpdir)(), "guardian-idx-"));
    const indexFile = (0, import_node_path10.join)(tmp, "index");
    const env = { GIT_INDEX_FILE: indexFile };
    if (head) {
      const readTree = git(projectDir, ["read-tree", "HEAD"], env);
      if (!readTree.ok) throw failed("read-tree", readTree);
    }
    const add = git(projectDir, ["add", "-A"], env);
    if (!add.ok) throw failed("add", add);
    const tree = git(projectDir, ["write-tree"], env);
    if (!tree.ok || !tree.out) throw failed("write-tree", tree);
    const msg = `guardian checkpoint ${stamp} (session ${sessionId})`;
    const args = ["commit-tree", tree.out, "-m", msg];
    if (head) args.push("-p", head);
    const commit = git(projectDir, args);
    if (!commit.ok || !commit.out) throw failed("commit-tree", commit);
    const updateRef = git(projectDir, ["update-ref", ref, commit.out]);
    if (!updateRef.ok) throw failed("update-ref", updateRef);
    return {
      kind: "ref",
      ref,
      sha: commit.out,
      branch,
      head,
      dirty_files: dirty,
      detail: `${dirty} uncommitted file(s) captured`
    };
  } catch (err) {
    const stash = git(projectDir, ["stash", "create", `guardian checkpoint ${stamp}`]);
    if (stash.ok && stash.out) {
      git(projectDir, ["update-ref", ref, stash.out]);
      return {
        kind: "stash",
        ref,
        sha: stash.out,
        branch,
        head,
        dirty_files: dirty,
        detail: `plumbing path failed (${err.message}); used stash create, which captures tracked changes only`
      };
    }
    const stashWhy = stash.ok ? "stash create found no tracked changes to capture" : failed("stash create", stash).message;
    return {
      kind: "status-only",
      ref: null,
      sha: null,
      branch,
      head,
      dirty_files: dirty,
      detail: `could not checkpoint (${err.message}; ${stashWhy}); recorded state only`
    };
  } finally {
    if (tmp) {
      try {
        (0, import_node_fs11.rmSync)(tmp, { recursive: true, force: true });
      } catch {
      }
    }
  }
}
function listCheckpoints(projectDir) {
  const r = git(projectDir, ["for-each-ref", "--format=%(refname)", "refs/guardian"]);
  return r.ok && r.out ? r.out.split("\n").filter(Boolean) : [];
}
function pruneCheckpoints(projectDir, keep) {
  const refs = listCheckpoints(projectDir).sort();
  let n = 0;
  for (const ref of refs.slice(0, Math.max(0, refs.length - keep))) {
    if (git(projectDir, ["update-ref", "-d", ref]).ok) n++;
  }
  return n;
}
function removeCheckpoints(projectDir) {
  const refs = listCheckpoints(projectDir);
  let n = 0;
  for (const ref of refs) {
    if (git(projectDir, ["update-ref", "-d", ref]).ok) n++;
  }
  return n;
}
function headMatches(projectDir, sha) {
  if (!sha || !isRepo(projectDir)) return null;
  const head = git(projectDir, ["rev-parse", "HEAD"]);
  return head.ok ? head.out === sha : null;
}

// src/handoff/manifest.ts
var BACKSLASH = /\\/g;
var toPosix = (p) => p.replace(BACKSLASH, "/");
var NOTE_EXCERPT = 1500;
function readAgentNotes(projectDir) {
  const dir = agentNotesDir(projectDir);
  let names;
  try {
    names = (0, import_node_fs12.readdirSync)(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const file = (0, import_node_path11.join)(dir, name);
    try {
      const text2 = (0, import_node_fs12.readFileSync)(file, "utf8").trim();
      if (!text2) continue;
      out.push({
        file: toPosix((0, import_node_path11.relative)(projectDir, file)),
        updated_at: Math.floor((0, import_node_fs12.statSync)(file).mtimeMs / 1e3),
        excerpt: text2.length > NOTE_EXCERPT ? `${text2.slice(0, NOTE_EXCERPT)}
\u2026` : text2
      });
    } catch {
    }
  }
  return out.sort((a, b) => b.updated_at - a.updated_at);
}
function noteEvents(events, field) {
  return events.filter(
    (e) => e.k === "note" && e.field === field
  );
}
function notes(events, field) {
  return noteEvents(events, field).map((e) => e.text);
}
function nextActionFrom(events) {
  const last = noteEvents(events, "next_action").at(-1);
  if (!last) return null;
  return { text: last.text, at: last.t, superseded: supersededSince(events, last.t) };
}
function nextActionStatus(projectDir, sessionId) {
  return nextActionFrom(readLedger(projectDir, sessionId));
}
function supersededSince(events, t) {
  let commits = 0;
  const files = /* @__PURE__ */ new Set();
  for (const e of events) {
    if (e.t <= t) continue;
    if (e.k === "commit") commits++;
    else if (e.k === "file") files.add(e.path);
  }
  return commits || files.size ? { commits, files: files.size } : null;
}
var BLANK_AGENT = {
  id: "",
  type: "unknown",
  status: "IN_FLIGHT_AT_SEAL",
  summary: null,
  redo_cost_estimate: "unknown",
  description: null,
  started_at: null,
  elapsed_min: null,
  context_pct: null,
  notes_file: null,
  notes_recorded: false
};
function redoCost(type) {
  if (!type) return "unknown";
  return /explore|search|research|review/i.test(type) ? "low" : "medium";
}
function fromRegistry(a, projectDir, now2, live, prev) {
  const notes2 = a.description ? agentNotesFile(projectDir, a.description) : null;
  let recorded = false;
  if (notes2) {
    try {
      recorded = (0, import_node_fs12.readFileSync)(notes2, "utf8").trim().length > 0;
    } catch {
      recorded = false;
    }
  }
  const type = a.type || prev?.type || "unknown";
  return {
    ...prev ?? BLANK_AGENT,
    id: a.id,
    type,
    status: prev?.status === "RETURNED" || !live ? prev?.status ?? "RETURNED" : "IN_FLIGHT_AT_SEAL",
    redo_cost_estimate: prev?.redo_cost_estimate === "unknown" || !prev ? redoCost(type) : prev.redo_cost_estimate,
    description: a.description ?? prev?.description ?? null,
    started_at: a.started_at,
    elapsed_min: a.started_at ? Math.max(0, (now2 - a.started_at) / 60) : null,
    context_pct: a.context_window && a.token_count !== null ? Math.min(100, a.token_count / a.context_window * 100) : null,
    notes_file: notes2 ? toPosix((0, import_node_path11.relative)(projectDir, notes2)) : null,
    notes_recorded: recorded
  };
}
function lostAgents(agents) {
  return [...agents.values()].filter((a) => a.status === "IN_FLIGHT_AT_SEAL" && !a.notes_recorded).length;
}
function buildManifest(projectDir, sessionId, state, reason, now2, opts = {}) {
  const events = readLedger(projectDir, sessionId);
  const stamp = new Date(now2 * 1e3).toISOString().replace(/[:.]/g, "-");
  const files = /* @__PURE__ */ new Map();
  const commits = [];
  const commands = [];
  const boundaries = /* @__PURE__ */ new Map();
  const tasksDone = /* @__PURE__ */ new Set();
  const tasksOpen = /* @__PURE__ */ new Map();
  const agents = /* @__PURE__ */ new Map();
  let tests = null;
  for (const e of events) {
    switch (e.k) {
      case "file":
        files.set(e.path, { path: e.path, sha256: e.sha256, bytes: e.bytes, last_edit: e.t });
        break;
      case "commit":
        commits.push({ sha: e.sha, subject: e.subject });
        break;
      case "command":
        commands.push({ command: e.command, kind: e.kind, ok: e.ok, t: e.t });
        if (e.kind === "test") {
          tests = { command: testCommand(e.command) ?? e.command, ok: e.ok, at: e.t };
        }
        boundaries.delete(e.command);
        break;
      case "boundary":
        boundaries.set(e.command, e.t);
        break;
      case "task":
        if (e.status === "completed") {
          tasksDone.add(e.title);
          tasksOpen.delete(e.id);
        } else {
          tasksOpen.set(e.id, e.title);
        }
        break;
      case "agent":
        if (e.status === "start") {
          agents.set(e.id, { ...BLANK_AGENT, id: e.id, type: e.type, status: "IN_FLIGHT_AT_SEAL" });
        } else {
          const prev = agents.get(e.id);
          agents.set(e.id, {
            ...prev ?? BLANK_AGENT,
            id: e.id,
            type: e.type || prev?.type || "unknown",
            status: "RETURNED",
            summary: e.summary ?? null,
            // Re-running a read-only explorer is cheap; re-running one that wrote code is
            // not, and the resuming session needs to know which it is looking at.
            redo_cost_estimate: redoCost(e.type || prev?.type || "")
          });
        }
        break;
      default:
        break;
    }
  }
  for (const a of Object.values(readAgents(projectDir, sessionId).agents)) {
    if (!a.id) continue;
    agents.set(a.id, fromRegistry(a, projectDir, now2, isLive(a, now2), agents.get(a.id)));
  }
  const next = nextActionFrom(events);
  const ax = state.axes;
  const cp = opts.git === false ? null : checkpoint(projectDir, sessionId, stamp);
  if (cp && cp.kind !== "ref" && cp.kind !== "none") {
    log(projectDir, "warn", `checkpoint degraded to ${cp.kind}: ${cp.detail}`);
  }
  return {
    schema: 1,
    sealed_at: now2,
    sealed_at_iso: new Date(now2 * 1e3).toISOString(),
    seal_reason: reason,
    consumed_at: null,
    session: { id: sessionId, cwd: projectDir, model: state.model },
    usage_at_seal: {
      mode: state.mode,
      binding_axis: state.binding_axis,
      context_pct: ax.context?.used_pct ?? null,
      five_hour_pct: ax.five_hour?.used_pct ?? null,
      five_hour_resets_at: ax.five_hour?.resets_at ?? null,
      seven_day_pct: ax.seven_day?.used_pct ?? null
    },
    objective: notes(events, "objective").at(-1) ?? null,
    observed: {
      files_touched: [...files.values()].sort((a, b) => b.last_edit - a.last_edit),
      commits,
      commands: commands.slice(-25),
      tests,
      agent_notes: readAgentNotes(projectDir),
      checkpoint: cp,
      in_flight_at_seal: [...boundaries.entries()].map(([command, started_at]) => ({
        command,
        started_at
      }))
    },
    tasks: { completed: [...tasksDone], in_progress: [...tasksOpen.values()] },
    agents: [...agents.values()],
    claude_supplied: {
      next_action: next?.text ?? null,
      next_action_at: next?.at ?? null,
      next_action_superseded: next?.superseded ?? null,
      open_decisions: notes(events, "decision"),
      gotchas: notes(events, "gotcha")
    },
    // Only steps this manifest can actually back. A fixed list promises sections that a
    // digest may not carry — "verify the file hashes below" with no hashes below, "do not
    // redo anything under completed" with no completed section — and a cold reader is left
    // deciding whether the file is truncated or the tool is lying. Both readings cost it
    // the trust the handoff runs on.
    resume_protocol: [
      files.size ? "Verify the file hashes below still match. A mismatch means the file changed outside this handoff." : "No files were recorded for this session; treat the working tree as unverified.",
      ...lostAgents(agents) ? [
        `${lostAgents(agents)} agent(s) were still running with nothing written down. Assume their work is lost and re-derive it; the "Agents" section says what each was asked to do.`
      ] : [],
      testStep(tests?.command ?? null),
      ...tasksDone.size ? ['Do NOT redo anything listed under "completed".'] : [],
      next?.superseded ? "The recorded next action is STALE \u2014 see the warning under it. Re-derive the next step from the work listed below before acting on it." : 'Resume from "next action". If it is absent, re-derive it from in-progress work before editing.'
    ]
  };
}
function testStep(command) {
  if (!command) return "Establish a build/test baseline before writing anything.";
  if (command.includes("[REDACTED]")) {
    return `Establish a build/test baseline before writing anything. The last test command was recorded as \`${command}\` \u2014 a secret was stripped, so supply it again rather than running that string as-is.`;
  }
  return `Run \`${command}\` before writing anything, to confirm the starting state.`;
}
function observedContinuation(m) {
  const out = [];
  for (const t of m.tasks.in_progress.slice(0, 3)) out.push(`task still open: ${t}`);
  for (const b of m.observed.in_flight_at_seal.slice(0, 2)) {
    out.push(`began and never seen to return: \`${b.command}\``);
  }
  for (const a of m.agents.filter((x) => x.status === "IN_FLIGHT_AT_SEAL").slice(0, 3)) {
    out.push(
      `agent ${a.type} (${a.id}) was still running` + (a.description ? `, asked to: ${a.description}` : "") + ` \u2014 redo cost ${a.redo_cost_estimate}` + (a.notes_recorded ? ", notes recorded" : ", nothing written down")
    );
  }
  const f = m.observed.files_touched;
  if (!out.length && f.length) {
    const newest = [...f].sort((a, b) => b.last_edit - a.last_edit)[0];
    out.push(`last file edited: ${newest.path}`);
  }
  if (m.observed.tests && m.observed.tests.ok === false) {
    out.push(`the recorded test run failed: \`${m.observed.tests.command}\``);
  }
  return out;
}
function ageWords(min) {
  if (min < 90) return `${Math.max(1, Math.round(min))} minutes`;
  if (min < 60 * 48) return `${(min / 60).toFixed(1)} hours`;
  return `${Math.round(min / 60 / 24)} days`;
}
function staleAge(m) {
  const at = m.claude_supplied.next_action_at;
  return at == null ? "an unknown time" : ageWords((m.sealed_at - at) / 60);
}
function describeSuperseded(s) {
  const parts = [];
  if (s.commits) parts.push(`${s.commits} commit${s.commits === 1 ? "" : "s"}`);
  if (s.files) parts.push(`${s.files} file edit${s.files === 1 ? "" : "s"}`);
  return parts.join(" and ") || "later work";
}
function carriesNothing(m) {
  const o = m.observed;
  const c = m.claude_supplied;
  return o.files_touched.length === 0 && o.commits.length === 0 && o.commands.length === 0 && o.agent_notes.length === 0 && o.in_flight_at_seal.length === 0 && m.tasks.completed.length === 0 && m.tasks.in_progress.length === 0 && m.agents.length === 0 && !m.objective && !c.next_action && c.open_decisions.length === 0 && c.gotchas.length === 0;
}
function latestPath(projectDir) {
  return (0, import_node_path11.join)(handoffDir(projectDir), "latest.json");
}
function latestDigestPath(projectDir) {
  return (0, import_node_path11.join)(handoffDir(projectDir), "latest.md");
}
function writeAtomic2(projectDir, p, content) {
  ensureGuardianDir(projectDir, (0, import_node_path11.dirname)(p));
  const tmp = `${p}.${process.pid}.tmp`;
  (0, import_node_fs12.writeFileSync)(tmp, content);
  (0, import_node_fs12.renameSync)(tmp, p);
}
function seal(projectDir, sessionId, state, reason, now2, opts = {}) {
  const m = buildManifest(projectDir, sessionId, state, reason, now2, opts);
  writeSeal(projectDir, m);
  return m;
}
function writeSeal(projectDir, m) {
  const stamp = m.sealed_at_iso.replace(/[:.]/g, "-");
  writeAtomic2(
    projectDir,
    (0, import_node_path11.join)(handoffDir(projectDir), "history", `${stamp}.json`),
    `${JSON.stringify(m)}
`
  );
  const prev = readLatest(projectDir);
  const displaced = !prev || prev.session.id === m.session.id || !carriesNothing(m) || carriesNothing(prev);
  if (displaced) {
    writeAtomic2(projectDir, latestPath(projectDir), `${JSON.stringify(m, null, 2)}
`);
    writeAtomic2(projectDir, latestDigestPath(projectDir), renderDigest(m, projectDir));
  } else {
    log(
      projectDir,
      "info",
      `seal ${stamp} (${m.seal_reason}) recorded nothing; kept latest from session ${prev.session.id} (${prev.seal_reason}, ${prev.observed.files_touched.length} file(s), ${prev.observed.commits.length} commit(s)). Archived at history/${stamp}.json.`
    );
  }
  prune(projectDir);
}
var KEEP = 20;
function prune(projectDir) {
  try {
    const dir = (0, import_node_path11.join)(handoffDir(projectDir), "history");
    const keep = readLatest(projectDir);
    const keepFile = keep ? `${keep.sealed_at_iso.replace(/[:.]/g, "-")}.json` : null;
    const stale = (0, import_node_fs12.readdirSync)(dir).filter((f) => f.endsWith(".json")).sort().slice(0, -KEEP).filter((f) => f !== keepFile);
    for (const f of stale) (0, import_node_fs12.unlinkSync)((0, import_node_path11.join)(dir, f));
  } catch {
  }
  try {
    pruneCheckpoints(projectDir, KEEP);
  } catch {
  }
}
function readManifestFile(p) {
  try {
    const m = JSON.parse((0, import_node_fs12.readFileSync)(p, "utf8"));
    if (m?.schema !== 1) return null;
    m.claude_supplied.next_action_at ??= null;
    m.claude_supplied.next_action_superseded ??= null;
    return m;
  } catch {
    return null;
  }
}
function readLatest(projectDir) {
  return readManifestFile(latestPath(projectDir));
}
function readBestHandoff(projectDir) {
  const latest = readLatest(projectDir);
  if (latest && !carriesNothing(latest)) {
    return { manifest: latest, path: latestPath(projectDir), rescued: false };
  }
  const dir = (0, import_node_path11.join)(handoffDir(projectDir), "history");
  let names = [];
  try {
    names = (0, import_node_fs12.readdirSync)(dir).filter((f) => f.endsWith(".json")).sort().reverse();
  } catch {
  }
  for (const name of names) {
    const p = (0, import_node_path11.join)(dir, name);
    const m = readManifestFile(p);
    if (!m || carriesNothing(m)) continue;
    return { manifest: m, path: p, rescued: true };
  }
  return latest ? { manifest: latest, path: latestPath(projectDir), rescued: false } : null;
}
function markConsumed(projectDir, now2) {
  const ref = readBestHandoff(projectDir);
  if (!ref) return null;
  ref.manifest.consumed_at = now2;
  writeAtomic2(projectDir, ref.path, `${JSON.stringify(ref.manifest, null, 2)}
`);
  const twin = (0, import_node_path11.join)(handoffDir(projectDir), "history", `${ref.manifest.sealed_at_iso.replace(/[:.]/g, "-")}.json`);
  if (twin !== ref.path && (0, import_node_fs12.existsSync)(twin)) {
    writeAtomic2(projectDir, twin, `${JSON.stringify(ref.manifest)}
`);
  }
  if (ref.rescued) {
    writeAtomic2(projectDir, latestPath(projectDir), `${JSON.stringify(ref.manifest, null, 2)}
`);
    writeAtomic2(projectDir, latestDigestPath(projectDir), renderDigest(ref.manifest, projectDir));
  }
  return ref.manifest;
}
function hasUnconsumed(projectDir) {
  const ref = readBestHandoff(projectDir);
  return ref && ref.manifest.consumed_at === null ? ref.manifest : null;
}
var MAX_FILES_IN_DIGEST = 25;
function renderDigest(m, projectDir) {
  const rel = (p) => {
    const r = (0, import_node_path11.relative)(projectDir, p);
    return r && !r.startsWith("..") ? toPosix(r) : toPosix(p);
  };
  const L = [];
  L.push("# Guardian handoff");
  L.push("");
  L.push(`Sealed ${m.sealed_at_iso} \u2014 ${m.seal_reason}`);
  if (m.objective) L.push(`Objective: ${m.objective}`);
  L.push("");
  if (m.claude_supplied.next_action) {
    const stale = m.claude_supplied.next_action_superseded;
    L.push(stale ? "## Next action \u2014 STALE" : "## Next action");
    L.push(m.claude_supplied.next_action);
    if (stale) {
      L.push("");
      L.push(
        `\u26A0 Written ${staleAge(m)} before this seal, and ${describeSuperseded(stale)} were recorded after it. It describes a state this session had already left. Treat it as background, re-derive the real next step from the sections below, and record the new one with \`guardian note --next "..."\`.`
      );
    }
    L.push("");
  } else {
    const observed = observedContinuation(m);
    if (observed.length) {
      L.push("## Next action \u2014 NOT STATED");
      L.push("Nobody recorded one. What Guardian observed in flight, which is not the same");
      L.push("thing and may not be what should happen next:");
      for (const o of observed) L.push(`- ${o}`);
      L.push("");
    }
  }
  if (m.tasks.completed.length) {
    L.push("## Completed \u2014 do not redo");
    for (const t of m.tasks.completed) L.push(`- ${t}`);
    L.push("");
  }
  if (m.tasks.in_progress.length) {
    L.push("## In progress");
    for (const t of m.tasks.in_progress) L.push(`- ${t}`);
    L.push("");
  }
  const f = m.observed.files_touched;
  if (f.length) {
    L.push(`## Files touched (${f.length})`);
    for (const x of f.slice(0, MAX_FILES_IN_DIGEST)) {
      L.push(`- ${rel(x.path)}${x.sha256 ? ` \`${x.sha256.slice(0, 12)}\`` : ""}`);
    }
    if (f.length > MAX_FILES_IN_DIGEST) L.push(`- \u2026and ${f.length - MAX_FILES_IN_DIGEST} more`);
    L.push("");
  }
  const cp = m.observed.checkpoint;
  if (cp && cp.kind !== "none") {
    L.push("## Repository");
    if (cp.branch) {
      L.push(`- branch \`${cp.branch}\`${cp.head ? ` at \`${cp.head.slice(0, 8)}\`` : ""}`);
    }
    if (cp.ref) L.push(`- checkpoint \`${cp.ref}\` (\`git show ${cp.sha?.slice(0, 8)}\`)`);
    if (cp.dirty_files) L.push(`- ${cp.dirty_files} uncommitted file(s) at seal time`);
    L.push("");
  }
  if (m.observed.commits.length) {
    L.push("## Commits this session");
    for (const c of m.observed.commits) L.push(`- \`${c.sha.slice(0, 8)}\` ${c.subject}`);
    L.push("");
  }
  if (m.observed.in_flight_at_seal.length) {
    L.push("## \u26A0 Possibly interrupted mid-operation");
    for (const b of m.observed.in_flight_at_seal) {
      L.push(`- \`${b.command}\` started and was never seen to finish`);
    }
    L.push("Check the state of these before assuming the workspace is consistent.");
    L.push("");
  }
  if (m.observed.tests) {
    const t = m.observed.tests;
    const verdict2 = t.ok === null ? "result unclear" : t.ok ? "passing" : "FAILING";
    L.push("## Tests");
    L.push(`\`${t.command}\` \u2014 ${verdict2}`);
    L.push("");
  }
  if (m.agents.length) {
    L.push("## Agents");
    for (const a of m.agents) {
      const flying = a.status === "IN_FLIGHT_AT_SEAL";
      L.push(
        `- ${a.id} (${a.type}) \u2014 ${flying ? "STILL RUNNING AT SEAL" : "returned"}, redo cost ${a.redo_cost_estimate}`
      );
      if (a.description) L.push(`  asked to: ${a.description}`);
      const vitals = [];
      if (a.elapsed_min !== null) vitals.push(`running ${fmtMin(a.elapsed_min)}`);
      if (a.context_pct !== null) vitals.push(`its own context ${a.context_pct.toFixed(0)}%`);
      if (vitals.length) L.push(`  ${vitals.join(", ")}`);
      if (a.summary) L.push(`  ${a.summary}`);
      if (a.notes_recorded && a.notes_file) L.push(`  notes: ${a.notes_file} (below)`);
      else if (flying) {
        L.push(
          `  \u26A0 nothing written down${a.notes_file ? ` in ${a.notes_file}` : ""} \u2014 whatever this agent had established does not survive the seal; redo cost ${a.redo_cost_estimate}`
        );
      }
    }
    L.push("");
  }
  if (m.observed.agent_notes.length) {
    L.push("## What the agents wrote down");
    L.push("");
    L.push("Their own notes, kept as they worked. Read these before re-running any agent:");
    L.push("");
    for (const n of m.observed.agent_notes) {
      L.push(`### ${n.file}`);
      L.push(n.excerpt);
      L.push("");
    }
  }
  if (m.claude_supplied.open_decisions.length) {
    L.push("## Open decisions");
    for (const d of m.claude_supplied.open_decisions) L.push(`- ${d}`);
    L.push("");
  }
  if (m.claude_supplied.gotchas.length) {
    L.push("## Gotchas");
    for (const g of m.claude_supplied.gotchas) L.push(`- ${g}`);
    L.push("");
  }
  L.push("## Resume protocol");
  for (const [i, step] of m.resume_protocol.entries()) L.push(`${i + 1}. ${step}`);
  const u = m.usage_at_seal;
  const parts = [];
  if (u.context_pct != null) parts.push(`context ${u.context_pct.toFixed(0)}%`);
  if (u.five_hour_pct != null) {
    const r = u.five_hour_resets_at ? `, resets in ${fmtMin((u.five_hour_resets_at - m.sealed_at) / 60)}` : "";
    parts.push(`5-hour ${u.five_hour_pct.toFixed(0)}%${r}`);
  }
  if (parts.length) {
    L.push("");
    L.push(`_At seal: ${u.mode} \u2014 ${parts.join(", ")}._`);
  }
  return `${L.join("\n")}
`;
}
function verify(projectDir, m) {
  const files = m.observed.files_touched.map((f) => {
    if (!(0, import_node_fs12.existsSync)(f.path)) return { path: f.path, status: "missing" };
    if (f.sha256 === null) return { path: f.path, status: "unverifiable" };
    const now2 = hashFile(f.path);
    return {
      path: f.path,
      status: now2.sha256 === f.sha256 ? "unchanged" : "changed"
    };
  });
  return { files, head_matches: headMatches(projectDir, m.observed.checkpoint?.head ?? null) };
}

// src/actuators/gate.ts
var import_node_path12 = require("node:path");
function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(
    /[*?]/g,
    (m) => m === "*" ? ".*" : "."
  );
  return new RegExp(`^${escaped}$`, "i");
}
function isSafeBoundaryCommand(command, patterns) {
  const c = command.trim();
  return patterns.some((p) => globToRegExp(p).test(c));
}
function budgetPhrase(state) {
  const axis = state.binding_axis;
  const st = axis ? state.axes[axis] : void 0;
  if (!st || st.time_to_wall_min === null || !Number.isFinite(st.time_to_wall_min)) {
    return `${state.mode} (${state.reason})`;
  }
  return `${state.mode}: about ${fmtMin(st.time_to_wall_min)} of ${axis} budget left`;
}
function checkpointNote(state, notesDir) {
  return [
    "",
    "---",
    `Budget note from Session Guardian: this session is at ${budgetPhrase(state)}.`,
    "You may be cut off mid-task. Nothing can pause you and nothing can resume you, so the",
    `only thing that survives is what you have written down. Keep \`${notesDir}\` current as`,
    "you work \u2014 not a summary at the end \u2014 and write it for someone who has to take over",
    "without ever having seen your context:",
    "- What you have established so far, with the file paths and findings that back it.",
    "- What you were doing at that moment, and the next concrete step you would have taken.",
    "- What you ruled out, so nobody spends the budget ruling it out again.",
    "Then: prefer returning a partial answer over returning nothing, and do not start work",
    "you cannot bring to a reportable state quickly."
  ].join("\n");
}
function gateSpawn(toolInput, state, cfg, projectDir, sessionId, now2) {
  const mode = state.mode;
  const denyFrom = cfg.agents.deny_spawn_from;
  const noteFrom = cfg.agents.inject_checkpoint_prompt_from;
  if (severity(mode) >= severity(denyFrom)) {
    const live = liveCount(readAgents(projectDir, sessionId), now2);
    const reason = `Session Guardian is in ${mode} \u2014 ${state.reason}. New subagents are blocked because a delegated task cannot be checkpointed or resumed once the session stops.` + (live ? ` ${live} agent(s) already running; let them return.` : "") + ` Finish or seal the current work instead (\`/guardian handoff\`), or do the task inline where its partial results stay in this session. To override, raise agents.deny_spawn_from in .claude/guardian/config.json.`;
    return { decision: "deny", reason };
  }
  if (severity(mode) >= severity(noteFrom) && toolInput) {
    const prompt = toolInput.prompt;
    if (typeof prompt !== "string") return { decision: null };
    if (prompt.includes("Budget note from Session Guardian")) return { decision: null };
    const desc = typeof toolInput.description === "string" ? toolInput.description : "agent";
    const notesFile = agentNotesFile(projectDir, desc);
    const rel = (0, import_node_path12.relative)(projectDir, notesFile).replace(/\\/g, "/") || notesFile;
    return {
      decision: null,
      updatedInput: { ...toolInput, prompt: prompt + checkpointNote(state, rel) },
      systemMessage: `\u{1F6E1} Guardian asked this agent to checkpoint as it goes (${mode}).`
    };
  }
  return { decision: null };
}
function markBoundary(toolInput, cfg, projectDir, sessionId, now2) {
  const command = typeof toolInput?.command === "string" ? toolInput.command : "";
  if (!command) return { decision: null };
  if (!isSafeBoundaryCommand(command, cfg.safe_boundary_commands)) return { decision: null };
  appendEvent(projectDir, sessionId, {
    k: "boundary",
    t: now2,
    command: clip2(redact(command), 300)
  });
  return { decision: null };
}

// src/actuators/landing.ts
var import_node_fs13 = require("node:fs");
function injectionFor(state, cfg) {
  const from = cfg.landing.inject_from;
  if (severity(state.mode) < severity(from)) return null;
  switch (state.mode) {
    case "PREPARE":
      return `[Guardian: PREPARE \u2014 ${state.reason}] Do not begin work that cannot reach a reportable state in that window. Prefer finishing what is open.`;
    case "LAND":
      return LANDING_PROTOCOL(state);
    case "EMERGENCY":
      return `[Guardian: EMERGENCY \u2014 ${state.reason}] The next request may be refused. Do one thing: record the next action with \`guardian note --next "..."\` and seal with \`/guardian handoff\`. Start nothing else.`;
    case "HARD_STOPPED":
      return hardStoppedBrief(state);
    default:
      return null;
  }
}
function LANDING_PROTOCOL(state) {
  return [
    `[Guardian: LAND \u2014 ${state.reason}]`,
    "",
    "Land the work. In this order:",
    "1. Bring the current operation to a stopping point. Do not start another.",
    "2. Record what cannot be observed from the files:",
    '   `guardian note --next "<the single most specific next step>"`',
    "   Add `--gotcha` or `--decision` for anything a fresh session would get wrong.",
    "3. Seal it: `/guardian handoff`.",
    "",
    "Guardian already has the files, commands, commits, tasks and tests. What it cannot",
    "see is intent, so the note is the part that matters. New subagents are blocked;",
    "do small remaining work inline."
  ].join("\n");
}
function hardStoppedBrief(state) {
  const resets = state.hard_stop?.resets_at ?? state.axes.five_hour?.resets_at ?? state.axes.seven_day?.resets_at ?? null;
  const when = resets ? new Date(resets * 1e3).toISOString().replace("T", " ").slice(0, 16) : null;
  const kind = state.hard_stop?.kind && state.hard_stop.kind !== "unknown" ? ` (${state.hard_stop.kind})` : "";
  return `[Guardian: HARD_STOPPED] A rate limit${kind} refused a request. ` + (when ? `The window reopens at ${when} UTC \u2014 nothing will succeed before then. ` : `The reset time was not recorded, so retry cautiously. `) + `A handoff has been sealed; run \`/guardian wait\` for a countdown, and \`/guardian resume\` once the window reopens. Do not retry in the meantime.`;
}
function forceSealInstruction(state, stale) {
  const problem = stale ? `the sealed handoff's next action is ${stale.age} old \u2014 ${stale.since} were recorded after it, so it describes work that is already done` : "no handoff has been sealed";
  return `Session Guardian is in ${state.mode} (${state.reason}) and ${problem}. Before stopping, do exactly this and nothing more: ${stale ? "replace" : "record"} the next action with \`guardian note --next "<the single most specific next step>"\`, then run \`guardian handoff --reason "${state.mode}"\`. Then stop.`;
}
var TAIL_BYTES = 256 * 1024;
function readTail(path, bytes = TAIL_BYTES) {
  let fd = null;
  try {
    const size = (0, import_node_fs13.statSync)(path).size;
    const start = Math.max(0, size - bytes);
    const length = size - start;
    if (length <= 0) return "";
    fd = (0, import_node_fs13.openSync)(path, "r");
    const buf = Buffer.alloc(length);
    (0, import_node_fs13.readSync)(fd, buf, 0, length, start);
    return buf.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== null) {
      try {
        (0, import_node_fs13.closeSync)(fd);
      } catch {
      }
    }
  }
}
function parseRateLimitTombstone(transcriptPath) {
  if (!transcriptPath) return null;
  const tail = readTail(transcriptPath);
  if (!tail.includes("quotaLimits")) return null;
  const idx = tail.lastIndexOf('"quotaLimits"');
  if (idx < 0) return null;
  const window = tail.slice(idx, idx + 600);
  const status = /"status"\s*:\s*"([a-z_]+)"/.exec(window)?.[1];
  if (status && status !== "rejected") return null;
  const kind = /"rateLimitType"\s*:\s*"([a-z_]+)"/.exec(window)?.[1] ?? "unknown";
  const resetsRaw = /"resetsAt"\s*:\s*(\d+)/.exec(window)?.[1];
  const resets = resetsRaw ? Number(resetsRaw) : null;
  return { kind, resets_at: resets && Number.isFinite(resets) ? resets : null };
}
function isRateLimitError(errorType, message) {
  const hay = `${errorType ?? ""} ${message ?? ""}`.toLowerCase();
  return hay.includes("rate_limit") || hay.includes("rate limit") || hay.includes("429") || hay.includes("quota");
}
function countdown(resetsAt, now2) {
  if (!resetsAt) return "reset time unknown";
  const min = (resetsAt - now2) / 60;
  if (min <= 0) return "the window has reopened";
  return `${fmtMin(min)} until the window reopens`;
}

// src/actuators/dispatch.ts
var NOTHING = { stdout: "", exit: 0 };
function ok(out) {
  return { stdout: JSON.stringify(out), exit: 0 };
}
function git2(cwd, args) {
  try {
    const r = (0, import_node_child_process3.spawnSync)("git", args, { cwd, encoding: "utf8", timeout: 5e3, windowsHide: true });
    return r.status === 0 ? (r.stdout ?? "").trim() : null;
  } catch {
    return null;
  }
}
var EDIT_TOOLS = /* @__PURE__ */ new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);
function toolOutput(inp) {
  const r = inp.tool_response ?? inp.tool_output;
  if (typeof r === "string") return r;
  if (r === void 0 || r === null) return "";
  try {
    return JSON.stringify(r);
  } catch {
    return "";
  }
}
function editedPath(input) {
  if (!input) return null;
  for (const key of ["file_path", "notebook_path", "path"]) {
    const v = input[key];
    if (typeof v === "string" && v) return v;
  }
  return null;
}
function askAgentToCheckpoint(inp, projectDir, sid, now2) {
  const cfg = loadConfig(projectDir);
  const state = readState(projectDir, sid);
  if (severity(state.mode) < severity(cfg.agents.inject_checkpoint_prompt_from)) return null;
  const id = inp.agent_id ?? inp.agent_type ?? null;
  if (!id) {
    if (!state.latches.agents_asked) {
      log(
        projectDir,
        "info",
        `no agent identity on a PostToolUse at ${state.mode}; keys: ${Object.keys(inp).join(",")}`
      );
      writeState(projectDir, { ...state, latches: { ...state.latches, agents_asked: [] } });
    }
    return null;
  }
  const asked = state.latches.agents_asked ?? [];
  if (asked.includes(id)) return null;
  writeState(projectDir, { ...state, latches: { ...state.latches, agents_asked: [...asked, id] } });
  const notes2 = agentNotesFile(projectDir, inp.agent_type ?? id);
  const rel = (0, import_node_path13.relative)(projectDir, notes2).split(import_node_path13.sep).join("/") || notes2;
  log(projectDir, "info", `asked in-flight agent ${id} to checkpoint into ${rel}`);
  return `[Guardian: ${state.mode} \u2014 ${state.reason}] You are a subagent in a session that is close to a wall, and you were started before that was true. Nothing can pause or resume you: only what you write down survives. Before your next step, write to \`${rel}\`: what you have established (with file paths), what you were doing, the next concrete step, and what you ruled out. Then prefer returning a partial answer over returning nothing.`;
}
function onPostToolUse(inp, projectDir, sid, now2) {
  const tool = inp.tool_name ?? "";
  if (EDIT_TOOLS.has(tool)) {
    const p = editedPath(inp.tool_input);
    if (p) appendEvent(projectDir, sid, fileEvent(p, tool, now2));
    return withAgentAsk(autoSeal(projectDir, sid, now2), inp, projectDir, sid, now2);
  }
  const cmd = tool === "Bash" || tool === "PowerShell" ? typeof inp.tool_input?.command === "string" ? inp.tool_input.command : "" : "";
  if (cmd) {
    const output = toolOutput(inp);
    if (!output) {
      log(projectDir, "warn", `PostToolUse carried no tool output; keys: ${Object.keys(inp).join(",")}`);
    }
    appendEvent(projectDir, sid, commandEvent(cmd, output, now2));
    if (mentionsGitCommit(cmd)) {
      const sha = git2(projectDir, ["rev-parse", "HEAD"]);
      const subject = git2(projectDir, ["log", "-1", "--format=%s"]);
      if (sha) {
        const seen = readLatest(projectDir)?.observed.commits.some((c) => c.sha === sha);
        if (!seen) {
          appendEvent(projectDir, sid, { k: "commit", t: now2, sha, subject: subject ?? "" });
        }
      }
    }
  }
  return withAgentAsk(autoSeal(projectDir, sid, now2), inp, projectDir, sid, now2);
}
function withAgentAsk(base, inp, projectDir, sid, now2) {
  const ask = askAgentToCheckpoint(inp, projectDir, sid, now2);
  if (!ask) return base;
  const out = base.stdout ? JSON.parse(base.stdout) : {};
  return ok({
    ...out,
    hookSpecificOutput: {
      ...out.hookSpecificOutput ?? {},
      hookEventName: "PostToolUse",
      additionalContext: ask
    }
  });
}
function nextActionAdvice(m) {
  const c = m.claude_supplied;
  if (!c.next_action) {
    return ' No next action is recorded yet \u2014 add one with `guardian note --next "..."`.';
  }
  const s = c.next_action_superseded;
  if (!s) return "";
  return ` The recorded next action is ${staleAge(m)} old and ${describeSuperseded(s)} came after it, so the handoff is carrying a stale intent. Replace it now: \`guardian note --next "..."\` then \`/guardian handoff\`.`;
}
function autoSeal(projectDir, sid, now2) {
  const cfg = loadConfig(projectDir);
  const state = readState(projectDir, sid);
  const armed = severity(state.mode) >= severity(cfg.landing.auto_seal_from);
  if (!armed) {
    if (state.latches.auto_sealed) {
      writeState(projectDir, { ...state, latches: { ...state.latches, auto_sealed: false } });
    }
    return NOTHING;
  }
  if (state.latches.auto_sealed) return NOTHING;
  const sealedAt = state.manifest.sealed_at;
  if (sealedAt !== null && !readLedger(projectDir, sid).some((e) => e.t > sealedAt)) {
    return NOTHING;
  }
  const latched = {
    ...state,
    latches: { ...state.latches, auto_sealed: true }
  };
  writeState(projectDir, latched);
  const m = seal(projectDir, sid, latched, `auto-seal (${state.mode})`, now2);
  writeState(projectDir, { ...latched, manifest: { sealed_at: m.sealed_at } });
  const n = m.observed.files_touched.length;
  const inFlight = m.agents.filter((a) => a.status === "IN_FLIGHT_AT_SEAL");
  const flying = inFlight.length;
  const silent = inFlight.filter((a) => !a.notes_recorded);
  log(
    projectDir,
    "info",
    `auto-sealed at ${state.mode} (${state.reason}): ${n} file(s), ${m.observed.commits.length} commit(s), ${flying} agent(s) in flight`
  );
  return ok({
    systemMessage: `\u{1F6E1} Guardian auto-sealed a handoff at ${state.mode} \u2014 ${n} file${n === 1 ? "" : "s"} tracked, manifest at ${latestPath(projectDir)}.` + (flying ? ` ${flying} agent(s) were still running; the seal records them but does not pause them.` : "") + (silent.length ? ` ${silent.length} of them has written nothing down (${silent.map((a) => a.description ?? a.type).join("; ")}) \u2014 that work does not survive. Let them return before you stop if you can.` : "") + nextActionAdvice(m)
  });
}
var SPAWN_TOOLS = /* @__PURE__ */ new Set(["Task", "Agent"]);
function onPreToolUse(inp, projectDir, sid, now2) {
  const tool = inp.tool_name ?? "";
  const cfg = loadConfig(projectDir);
  const state = readState(projectDir, sid);
  const g = SPAWN_TOOLS.has(tool) ? gateSpawn(inp.tool_input, state, cfg, projectDir, sid, now2) : tool === "Bash" || tool === "PowerShell" ? markBoundary(inp.tool_input, cfg, projectDir, sid, now2) : { decision: null };
  if (g.decision === "deny") {
    return ok({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: g.reason
      }
    });
  }
  if (g.updatedInput) {
    return ok({
      hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: g.updatedInput },
      ...g.systemMessage ? { systemMessage: g.systemMessage } : {}
    });
  }
  return NOTHING;
}
function onPreCompact(inp, projectDir, sid, now2) {
  const state = readState(projectDir, sid);
  const m = seal(projectDir, sid, state, `PreCompact (${inp.reason ?? "auto"})`, now2);
  writeState(projectDir, { ...state, manifest: { sealed_at: now2 } });
  const n = m.observed.files_touched.length;
  return ok({
    systemMessage: `\u{1F6E1} Guardian sealed a handoff before compaction (${n} file${n === 1 ? "" : "s"} tracked).`
  });
}
function onPostCompact(projectDir, now2) {
  const digest = readDigest(projectDir);
  if (!digest) return NOTHING;
  return ok({
    additionalContext: `Context was just compacted. The following handoff was sealed immediately beforehand and is authoritative for what has already been done \u2014 do not redo work listed as completed.

${digest}`,
    systemMessage: "\u{1F6E1} Guardian restored the pre-compaction handoff digest."
  });
}
function readDigest(projectDir) {
  try {
    return (0, import_node_fs14.readFileSync)(latestDigestPath(projectDir), "utf8");
  } catch {
    return null;
  }
}
function onSessionEnd(inp, projectDir, sid, now2) {
  const state = readState(projectDir, sid);
  if (state.updated_at === 0 && state.samples.length === 0) return NOTHING;
  const m = buildManifest(projectDir, sid, state, `SessionEnd (${inp.reason ?? "other"})`, now2, {
    git: false
  });
  if (carriesNothing(m)) {
    log(projectDir, "info", `SessionEnd for ${sid}: nothing observed, no handoff sealed`);
    return NOTHING;
  }
  writeSeal(projectDir, m);
  return NOTHING;
}
function onUserPromptSubmit(projectDir, sid, now2) {
  const cfg = loadConfig(projectDir);
  const state = readState(projectDir, sid);
  const parts = [];
  if (!state.latches.resume_offered) {
    const m = hasUnconsumed(projectDir);
    writeState(projectDir, {
      ...state,
      session_id: sid,
      latches: { ...state.latches, resume_offered: true }
    });
    if (m && m.session.id !== sid) parts.push(resumeOffer(m, now2));
  }
  const brief = injectionFor(state, cfg);
  if (brief) parts.push(brief + intentStatus(projectDir, sid, state, now2));
  return parts.length ? ok({ additionalContext: parts.join("\n\n") }) : NOTHING;
}
function intentStatus(projectDir, sid, state, now2) {
  if (severity(state.mode) < severity("LAND")) return "";
  const st = nextActionStatus(projectDir, sid);
  if (!st) return "\n\nGuardian has no next action recorded for this session yet.";
  if (!st.superseded) return "";
  return `

Note: a next action IS recorded, written ${ageWords((now2 - st.at) / 60)} ago \u2014 "${st.text.slice(0, 160)}${st.text.length > 160 ? "\u2026" : ""}" \u2014 and ${describeSuperseded(st.superseded)} have been recorded since. It is stale. Write the current one; do not assume the recorded note still holds.`;
}
function resumeOffer(m, now2) {
  const ageMin = (now2 - m.sealed_at) / 60;
  const age = ageMin < 60 ? `${Math.round(ageMin)} minutes ago` : ageMin < 60 * 48 ? `${(ageMin / 60).toFixed(1)} hours ago` : `${Math.round(ageMin / 60 / 24)} days ago`;
  const next = m.claude_supplied.next_action;
  const stale = next ? m.claude_supplied.next_action_superseded : null;
  return `[Guardian] An unfinished handoff from a previous session in this project was sealed ${age}: "${m.seal_reason}".` + (m.objective ? ` Objective: ${m.objective}.` : "") + (next ? ` Next action recorded: ${next}` : "") + (stale ? ` \u2014 but that note was already ${staleAge(m)} old when the session sealed, and ${describeSuperseded(stale)} came after it. Do not act on it as written.` : "") + `
If the user's request relates to that work, run \`/guardian resume\` to load the full digest and verify the workspace before editing. If it is unrelated, ignore this and do not mention it.`;
}
function onStop(projectDir, sid, now2) {
  const cfg = loadConfig(projectDir);
  if (!cfg.landing.force_seal_turn) return NOTHING;
  const state = readState(projectDir, sid);
  if (state.latches.stop_forced) return NOTHING;
  if (severity(state.mode) < severity("LAND")) return NOTHING;
  const sealed = readLatest(projectDir);
  const mine = sealed && sealed.session.id === sid ? sealed : null;
  const stale = mine?.claude_supplied.next_action ? mine.claude_supplied.next_action_superseded : null;
  if (mine?.claude_supplied.next_action && !stale) return NOTHING;
  writeState(projectDir, { ...state, latches: { ...state.latches, stop_forced: true } });
  return {
    stdout: "",
    exit: 2,
    stderr: forceSealInstruction(
      state,
      stale && mine ? { age: staleAge(mine), since: describeSuperseded(stale) } : null
    )
  };
}
function onPostToolBatch(projectDir, sid) {
  const cfg = loadConfig(projectDir);
  if (!cfg.landing.halt_loop_at_emergency) return NOTHING;
  const state = readState(projectDir, sid);
  if (state.mode !== "EMERGENCY" || state.manifest.sealed_at === null) return NOTHING;
  return {
    stdout: "",
    exit: 2,
    stderr: "Session Guardian halted the loop: the handoff is sealed and the budget is spent. Resume in a new session with `/guardian resume`."
  };
}
function onStopFailure(inp, projectDir, sid, now2) {
  if (!isRateLimitError(inp.error_type, inp.error_message)) return NOTHING;
  const tomb = parseRateLimitTombstone(inp.transcript_path);
  const state = readState(projectDir, sid);
  const kind = tomb?.kind ?? "unknown";
  const resets = tomb?.resets_at ?? state.axes.five_hour?.resets_at ?? null;
  const next = {
    ...state,
    mode: "HARD_STOPPED",
    reason: `${kind} rate limit refused a request`,
    hard_stop: { at: now2, kind, resets_at: resets }
  };
  writeState(projectDir, next);
  if (state.manifest.sealed_at === null) {
    seal(projectDir, sid, next, `HARD_STOPPED (${kind} rate limit)`, now2, { git: false });
    writeState(projectDir, { ...next, manifest: { sealed_at: now2 } });
  }
  return NOTHING;
}
function recordAgentDuration(inp, projectDir, sid, now2) {
  const id = inp.agent_id;
  const type = inp.agent_type;
  if (!id) return;
  const f = readAgents(projectDir, sid);
  const snap = f.agents[id];
  if (snap?.started_at && type) recordDuration(projectDir, type, now2 - snap.started_at);
  if (snap) {
    delete f.agents[id];
    writeAgents(projectDir, { ...f, updated_at: now2 });
  }
}
function handle(event, raw, now2 = Date.now() / 1e3) {
  let inp = {};
  try {
    inp = JSON.parse(raw);
  } catch {
    return NOTHING;
  }
  const projectDir = resolveStateRoot(inp.cwd || process.cwd());
  const sid = inp.session_id || "unknown";
  try {
    if (!loadConfig(projectDir).enabled) return NOTHING;
    switch (event) {
      case "PreToolUse":
        return onPreToolUse(inp, projectDir, sid, now2);
      case "PostToolUse":
        return onPostToolUse(inp, projectDir, sid, now2);
      case "TaskCreated":
      case "TaskCompleted":
        if (inp.task_id) {
          appendEvent(projectDir, sid, {
            k: "task",
            t: now2,
            id: inp.task_id,
            title: inp.task_title ?? inp.task_id,
            status: event === "TaskCompleted" ? "completed" : "created"
          });
        }
        return NOTHING;
      case "SubagentStart":
      case "SubagentStop":
        if (inp.agent_id) {
          if (event === "SubagentStop") recordAgentDuration(inp, projectDir, sid, now2);
          appendEvent(projectDir, sid, {
            k: "agent",
            t: now2,
            id: inp.agent_id,
            type: inp.agent_type ?? "unknown",
            status: event === "SubagentStart" ? "start" : "stop",
            ...inp.last_assistant_message ? { summary: inp.last_assistant_message.slice(0, 300) } : {}
          });
        }
        return NOTHING;
      case "PreCompact":
        return onPreCompact(inp, projectDir, sid, now2);
      case "PostCompact":
        return onPostCompact(projectDir, now2);
      case "SessionEnd":
        return onSessionEnd(inp, projectDir, sid, now2);
      case "UserPromptSubmit":
        return onUserPromptSubmit(projectDir, sid, now2);
      case "Stop":
        return onStop(projectDir, sid, now2);
      case "PostToolBatch":
        return onPostToolBatch(projectDir, sid);
      case "StopFailure":
        return onStopFailure(inp, projectDir, sid, now2);
      default:
        return NOTHING;
    }
  } catch (err) {
    log(projectDir, "error", `hook ${event} failed: ${err?.stack ?? String(err)}`);
    return NOTHING;
  }
}

// src/core/sessions.ts
var import_node_fs15 = require("node:fs");
var import_node_path14 = require("node:path");
function latestSessionIn(projectDir) {
  const SUFFIXES = [".ledger.jsonl", ".agents.json", ".json"];
  try {
    const dir = (0, import_node_path14.join)(stateDir(projectDir), "sessions");
    const seen = /* @__PURE__ */ new Map();
    for (const f of (0, import_node_fs15.readdirSync)(dir)) {
      const suffix = SUFFIXES.find((x) => f.endsWith(x));
      if (!suffix) continue;
      const sid = f.slice(0, -suffix.length);
      if (!sid) continue;
      seen.set(sid, Math.max(seen.get(sid) ?? 0, (0, import_node_fs15.statSync)((0, import_node_path14.join)(dir, f)).mtimeMs));
    }
    return [...seen.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  } catch {
    return null;
  }
}

// src/ui/mcp.ts
var import_node_fs16 = require("node:fs");
var SERVER = { name: "claude-session-guardian", version: "0.5.0" };
var FALLBACK_PROTOCOL = "2025-06-18";
var TOOLS = [
  {
    name: "guardian_status",
    description: 'Current session budget: mode, per-axis usage, burn rate, and minutes until each wall. Call this before deciding whether a large task or a subagent fan-out fits in the remaining budget. "refills first" means that window replenishes faster than it is being consumed and is safe at any percentage.',
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "guardian_checkpoint",
    description: "Seal a resumable handoff of the work so far. Pass next_action: the single most specific next step. Guardian already records files, commands, commits, tasks and tests by watching; intent is the only thing it cannot observe, so next_action is the field that matters.",
    inputSchema: {
      type: "object",
      properties: {
        next_action: { type: "string", description: "The single most specific next step." },
        objective: { type: "string", description: "One sentence on the overall goal." },
        gotcha: { type: "string", description: "Something a fresh session would get wrong." },
        reason: { type: "string", description: "Why the handoff is being sealed now." }
      },
      additionalProperties: false
    }
  },
  {
    name: "guardian_resume_context",
    description: "The digest of the last sealed handoff: objective, next action, completed work not to redo, files touched with hashes, and the git checkpoint. Call this when picking up work from a previous session.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  }
];
function text(s, isError = false) {
  return { content: [{ type: "text", text: s }], ...isError ? { isError: true } : {} };
}
function callTool(name, args, now2) {
  const projectDir = resolveStateRoot(process.cwd());
  const cfg = loadConfig(projectDir);
  const sid = latestSessionIn(projectDir);
  switch (name) {
    case "guardian_status": {
      if (!sid) return text("Guardian has no state for this project yet; the status line sensor has not run.");
      return text(renderDashboard(readState(projectDir, sid), cfg));
    }
    case "guardian_checkpoint": {
      if (!sid) return text("Guardian has no state for this project yet; nothing to seal.", true);
      const notes2 = [
        ["next_action", "next_action"],
        ["objective", "objective"],
        ["gotcha", "gotcha"]
      ];
      for (const [key, field] of notes2) {
        const v = args[key];
        if (typeof v === "string" && v.trim()) {
          appendEvent(projectDir, sid, {
            k: "note",
            t: now2,
            field,
            text: v.trim()
          });
        }
      }
      const reason = typeof args.reason === "string" && args.reason ? args.reason : "mcp checkpoint";
      const m = seal(projectDir, sid, readState(projectDir, sid), reason, now2);
      const cp = m.observed.checkpoint;
      const lines = [
        `Sealed a handoff (${reason}).`,
        `  files tracked: ${m.observed.files_touched.length}`,
        `  commits:       ${m.observed.commits.length}`,
        `  checkpoint:    ${cp?.ref ?? cp?.detail ?? "none"}`,
        m.claude_supplied.next_action ? m.claude_supplied.next_action_superseded ? `  next action:   STALE \u2014 written ${staleAge(m)} before this seal, with ${describeSuperseded(m.claude_supplied.next_action_superseded)} after it. Call again with a next_action describing what should happen now.` : `  next action:   ${m.claude_supplied.next_action}` : "  next action:   MISSING \u2014 a resuming session will have to guess. Call again with next_action."
      ];
      return text(lines.join("\n"));
    }
    case "guardian_resume_context": {
      const ref = readBestHandoff(projectDir);
      if (!ref) return text("No sealed handoff exists for this project.");
      if (ref.rescued) {
        return text(
          `(The handoff on offer recorded nothing; this is the most recent one that does, read from ${ref.path}.)

${renderDigest(ref.manifest, projectDir)}`
        );
      }
      try {
        return text((0, import_node_fs16.readFileSync)(latestDigestPath(projectDir), "utf8"));
      } catch {
        return text(`Manifest exists but its digest is missing. Raw manifest is in ${stateDir(projectDir)}.`, true);
      }
    }
    default:
      return text(`Unknown tool: ${name}`, true);
  }
}
function handleRequest(req, now2) {
  const reply = (result) => ({ jsonrpc: "2.0", id: req.id ?? null, result });
  const fail = (code, message) => ({
    jsonrpc: "2.0",
    id: req.id ?? null,
    error: { code, message }
  });
  switch (req.method) {
    case "initialize": {
      const asked = req.params?.protocolVersion;
      return reply({
        protocolVersion: typeof asked === "string" ? asked : FALLBACK_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: SERVER
      });
    }
    case "notifications/initialized":
    case "initialized":
      return null;
    // a notification takes no reply
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      const name = req.params?.name;
      if (typeof name !== "string") return fail(-32602, "params.name must be a string");
      const args = req.params?.arguments ?? {};
      try {
        return reply(callTool(name, args, now2));
      } catch (err) {
        return reply(text(`Guardian failed: ${err.message}`, true));
      }
    }
    case "ping":
      return reply({});
    default:
      if (req.method?.startsWith("notifications/")) return null;
      return fail(-32601, `Method not found: ${req.method}`);
  }
}
function serve(now2 = () => Date.now() / 1e3) {
  const projectDir = resolveStateRoot(process.cwd());
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const req = JSON.parse(line);
        const res = handleRequest(req, now2());
        if (res) process.stdout.write(`${JSON.stringify(res)}
`);
      } catch (err) {
        log(projectDir, "error", `mcp line failed: ${err.message}`);
      }
    }
  });
  process.stdin.on("end", () => process.exit(0));
}

// src/ui/doctor.ts
var import_node_fs18 = require("node:fs");
var import_node_child_process4 = require("node:child_process");
var import_node_os4 = require("node:os");
var import_node_path16 = require("node:path");

// src/ui/configCmd.ts
var import_node_fs17 = require("node:fs");
var import_node_path15 = require("node:path");
var MODE_PATHS = [
  /^axis_severity_cap\.[a-z_]+$/,
  /^agents\.(deny_spawn_from|inject_checkpoint_prompt_from)$/,
  /^landing\.(inject_from|auto_seal_from)$/
];
function isModePath(path) {
  return MODE_PATHS.some((re) => re.test(path));
}
function flatten(o, prefix = "") {
  if (!o || typeof o !== "object" || Array.isArray(o)) return [[prefix, o]];
  const out = [];
  for (const [k, v] of Object.entries(o)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) out.push(...flatten(v, path));
    else out.push([path, v]);
  }
  return out;
}
function getPath(o, path) {
  let cur = o;
  for (const part of path.split(".")) {
    if (!cur || typeof cur !== "object") return void 0;
    cur = cur[part];
  }
  return cur;
}
function setPath(o, path, value) {
  const parts = path.split(".");
  const out = { ...o };
  let cur = out;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    const next = cur[k];
    cur[k] = next && typeof next === "object" && !Array.isArray(next) ? { ...next } : {};
    cur = cur[k];
  }
  cur[parts[parts.length - 1]] = value;
  return out;
}
function unsetPath(o, path) {
  const parts = path.split(".");
  const out = { ...o };
  let cur = out;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    const next = cur[k];
    if (!next || typeof next !== "object") return out;
    cur[k] = { ...next };
    cur = cur[k];
  }
  delete cur[parts[parts.length - 1]];
  return out;
}
function coerceValue(path, raw) {
  const current = getPath(DEFAULT_CONFIG, path);
  if (current === void 0) {
    return { ok: false, error: `unknown setting "${path}" (see \`guardian config\` for the list)` };
  }
  if (isModePath(path)) {
    const v = raw.toUpperCase();
    return MODES.includes(v) ? { ok: true, value: v } : { ok: false, error: `must be one of ${MODES.join(", ")}` };
  }
  if (typeof current === "boolean") {
    const t = ["true", "on", "yes", "1", "enabled"];
    const f = ["false", "off", "no", "0", "disabled"];
    const v = raw.toLowerCase();
    if (t.includes(v)) return { ok: true, value: true };
    if (f.includes(v)) return { ok: true, value: false };
    return { ok: false, error: "must be true or false" };
  }
  if (typeof current === "number") {
    const n = Number(raw);
    if (!Number.isFinite(n)) return { ok: false, error: "must be a number" };
    return { ok: true, value: n };
  }
  if (Array.isArray(current)) {
    const trimmed = raw.trim();
    if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (!Array.isArray(parsed)) return { ok: false, error: "must be a JSON array" };
        return { ok: true, value: parsed };
      } catch {
        return { ok: false, error: "looked like JSON but did not parse" };
      }
    }
    return { ok: true, value: trimmed ? trimmed.split(",").map((x) => x.trim()).filter(Boolean) : [] };
  }
  return { ok: true, value: raw };
}
function validateConfig(user) {
  const problems = [];
  for (const [path] of flatten(user)) {
    if (!path) continue;
    if (getPath(DEFAULT_CONFIG, path) === void 0) {
      const axisCap = /^axis_severity_cap\.(context|five_hour|seven_day|spend)$/.test(path);
      if (!axisCap) {
        problems.push({ path, message: "not a Guardian setting; it will be ignored", severity: "warning" });
      }
    }
  }
  const tm = { ...DEFAULT_CONFIG.thresholds_minutes, ...user.thresholds_minutes };
  const order = ["watch", "prepare", "land", "emergency"];
  for (const k of order) {
    if (typeof tm[k] !== "number" || tm[k] <= 0) {
      problems.push({ path: `thresholds_minutes.${k}`, message: "must be a positive number of minutes", severity: "error" });
    }
  }
  for (let i = 1; i < order.length; i++) {
    const a = order[i - 1];
    const b = order[i];
    if (typeof tm[a] === "number" && typeof tm[b] === "number" && tm[a] < tm[b]) {
      problems.push({
        path: `thresholds_minutes.${b}`,
        message: `must be <= thresholds_minutes.${a} (${tm[a]}); otherwise ${a.toUpperCase()} can never be reached before ${b.toUpperCase()}`,
        severity: "error"
      });
    }
  }
  const tp = { ...DEFAULT_CONFIG.thresholds_percent_floor, ...user.thresholds_percent_floor };
  for (const k of order) {
    const v = tp[k];
    if (typeof v !== "number" || v < 0 || v > 100) {
      problems.push({ path: `thresholds_percent_floor.${k}`, message: "must be a percentage between 0 and 100", severity: "error" });
    }
  }
  for (let i = 1; i < order.length; i++) {
    const a = order[i - 1];
    const b = order[i];
    const va = tp[a];
    const vb = tp[b];
    if (typeof va === "number" && typeof vb === "number" && va > vb) {
      problems.push({
        path: `thresholds_percent_floor.${b}`,
        message: `must be >= thresholds_percent_floor.${a} (${va}); percentage floors rise with severity`,
        severity: "error"
      });
    }
  }
  for (const [path, value] of flatten(user)) {
    if (isModePath(path) && typeof value === "string" && !MODES.includes(value)) {
      problems.push({ path, message: `must be one of ${MODES.join(", ")}`, severity: "error" });
    }
  }
  const burn = { ...DEFAULT_CONFIG.burn, ...user.burn };
  if (burn.min_samples < 2) {
    problems.push({ path: "burn.min_samples", message: "must be at least 2; a rate needs two readings", severity: "error" });
  }
  if (burn.alpha <= 0 || burn.alpha > 1) {
    problems.push({ path: "burn.alpha", message: "must be greater than 0 and at most 1", severity: "error" });
  }
  if (burn.window_min <= 0) {
    problems.push({ path: "burn.window_min", message: "must be a positive number of minutes", severity: "error" });
  }
  if (burn.reset_margin_min < 0) {
    problems.push({ path: "burn.reset_margin_min", message: "cannot be negative", severity: "error" });
  }
  if (burn.window_min > 0 && burn.max_samples >= 2) {
    const gap = spacingS({ ...DEFAULT_CONFIG, burn });
    const needed = (burn.min_samples - 1) * gap;
    if (needed > burn.window_min * 60) {
      problems.push({
        path: "burn.max_samples",
        message: `too small for burn.window_min ${burn.window_min}: samples land ${gap}s apart, so ${burn.min_samples} of them span ${Math.round(needed)}s and never fit the window \u2014 no burn rate would ever be measurable`,
        severity: "error"
      });
    }
  }
  const w = user.render?.bar_width ?? DEFAULT_CONFIG.render.bar_width;
  if (typeof w !== "number" || w < 1 || w > 40) {
    problems.push({ path: "render.bar_width", message: "must be between 1 and 40", severity: "error" });
  }
  return problems;
}
function readUserConfig(projectDir) {
  try {
    const parsed = JSON.parse((0, import_node_fs17.readFileSync)(configPath(projectDir), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
function writeUserConfig(projectDir, cfg) {
  const p = configPath(projectDir);
  ensureGuardianDir(projectDir, (0, import_node_path15.dirname)(p));
  const tmp = `${p}.${process.pid}.tmp`;
  (0, import_node_fs17.writeFileSync)(tmp, `${JSON.stringify(cfg, null, 2)}
`);
  (0, import_node_fs17.renameSync)(tmp, p);
}
function deleteUserConfig(projectDir) {
  const p = configPath(projectDir);
  if (!(0, import_node_fs17.existsSync)(p)) return false;
  (0, import_node_fs17.unlinkSync)(p);
  return true;
}
var HELP = {
  enabled: "master switch; false makes Guardian silent without uninstalling it",
  "thresholds_minutes.watch": "minutes-to-wall at which the bar turns amber",
  "thresholds_minutes.prepare": "minutes-to-wall at which to stop starting new work",
  "thresholds_minutes.land": "minutes-to-wall at which spawns are denied and a handoff seals",
  "thresholds_minutes.emergency": "minutes-to-wall treated as the wall being here",
  "thresholds_percent_floor.watch": "percentage backstop while burn rate is unmeasurable",
  "thresholds_percent_floor.prepare": "percentage backstop while burn rate is unmeasurable",
  "thresholds_percent_floor.land": "percentage backstop while burn rate is unmeasurable",
  "thresholds_percent_floor.emergency": "percentage backstop while burn rate is unmeasurable",
  "axes.context": "track the context window",
  "axes.five_hour": "track the 5-hour rate limit",
  "axes.seven_day": "track the 7-day rate limit",
  "axes.spend": "track the spend limit",
  "axis_severity_cap.context": "highest mode the context axis may demand (its wall is compaction)",
  "agents.deny_spawn_from": "mode at which new subagents are refused; HARD_STOPPED disables the gate",
  "agents.inject_checkpoint_prompt_from": "mode at which spawned agents are told to checkpoint",
  safe_boundary_commands: "irreversible commands to record as possibly-interrupted; never blocked",
  "landing.inject_from": "mode at which Guardian starts injecting a brief into the conversation",
  "landing.force_seal_turn": "let the Stop hook refuse one turn-end to force a seal",
  "landing.auto_seal_from": "mode at which Guardian seals by itself, without waiting for the model; HARD_STOPPED disables it",
  "landing.halt_loop_at_emergency": "halt the agentic loop at EMERGENCY once a handoff is sealed",
  "statusline.chained_from": "settings file the chained command is re-read from each tick",
  "statusline.chain_timeout_ms": "how long the chained status line may take before it is dropped",
  "statusline.own_line": "put Guardian's segment on its own line under the one it chained",
  "burn.window_min": "trailing window for the burn-rate estimate",
  "burn.min_span_s": "minimum sample span before a rate is computed",
  "burn.alpha": "smoothing; higher reacts faster and is twitchier",
  "burn.max_samples": "bound on retained samples",
  "burn.reset_margin_min": "slack required before a refilling window counts as safe",
  "burn.min_samples": "readings required before a rate is believed",
  "statusline.manage": "whether Guardian owns the status line",
  "statusline.chain_existing": "run the status line Guardian displaced, and append to it",
  "statusline.chained_command": "the displaced status line command (set by install)",
  "render.bar_width": "width of the progress bars, in characters",
  "render.color": "ANSI colour in the status line"
};

// src/ui/doctor.ts
var MARK = { pass: "ok  ", warn: "warn", fail: "FAIL", skip: "--  " };
function audit(projectDir, state, now2, settingsFile = userSettingsPath()) {
  const checks = [];
  const cfg = loadConfig(projectDir);
  let statusLineCmd = null;
  let subagentCmd = null;
  let deciding = settingsFile;
  for (const file of settingsChain(projectDir, settingsFile)) {
    let settings;
    try {
      settings = JSON.parse((0, import_node_fs18.readFileSync)(file, "utf8"));
    } catch {
      continue;
    }
    if (typeof settings.statusLine?.command === "string") {
      statusLineCmd = settings.statusLine.command;
      deciding = file;
    }
    if (typeof settings.subagentStatusLine?.command === "string") {
      subagentCmd = settings.subagentStatusLine.command;
    }
  }
  const senses = !!statusLineCmd?.includes("guardian.cjs");
  checks.push(
    senses ? { name: "status line", status: "pass", detail: "points at Guardian" } : {
      name: "status line",
      status: "fail",
      detail: statusLineCmd ? `${deciding} points elsewhere: ${statusLineCmd}` : "not configured",
      // `init` rather than `install`: whatever is winning here has to be taken over
      // where it is, and it may not be the user's settings file.
      fix: "run `guardian init`, then restart Claude Code"
    }
  );
  checks.push(
    subagentCmd?.includes("guardian.cjs") ? { name: "agent rows", status: "pass", detail: "per-agent sensing is wired" } : {
      name: "agent rows",
      status: "warn",
      detail: "subagentStatusLine not set; per-agent context and pace are unavailable",
      fix: "run `guardian init`"
    }
  );
  if (cfg.statusline.manage && cfg.statusline.chain_existing) {
    const probe = probeChained(projectDir, cfg);
    const failures = recentChainFailures(projectDir, now2);
    if (probe.cmd) {
      checks.push(
        probe.ok && failures === 0 ? { name: "chained bar", status: "pass", detail: "the status line Guardian chained still runs" } : probe.ok ? {
          name: "chained bar",
          status: "warn",
          detail: `runs here, but was dropped ${failures} time(s) in the last 6h of real ticks`,
          fix: "the last bar it produced is shown instead, marked `\u22EF`; `guardian log` has each drop, and `statusline.chain_timeout_ms` is the cap it exceeded"
        } : {
          name: "chained bar",
          status: "warn",
          detail: `produced nothing when run: ${probe.cmd}`,
          fix: "see `guardian log`; the segment is silently missing from every tick"
        }
      );
      if (!cfg.statusline.chained_from) {
        checks.push({
          name: "chain source",
          status: "warn",
          detail: "chained_command is a snapshot and chained_from is unset, so later edits to that command never reach Guardian",
          fix: "run `guardian init` to re-read it live"
        });
      }
    }
  }
  checks.push(
    cfg.enabled ? { name: "enabled", status: "pass", detail: "Guardian is active for this project" } : {
      name: "enabled",
      status: "fail",
      detail: "disabled by config; Guardian is silent",
      fix: "run `guardian on`"
    }
  );
  const problems = validateConfig(readUserConfig(projectDir));
  const errs = problems.filter((p) => p.severity === "error");
  checks.push(
    errs.length ? {
      name: "config",
      status: "fail",
      detail: errs.map((p) => `${p.path}: ${p.message}`).join("; "),
      fix: "run `guardian config check`"
    } : problems.length ? {
      name: "config",
      status: "warn",
      detail: problems.map((p) => `${p.path}: ${p.message}`).join("; ")
    } : { name: "config", status: "pass", detail: "valid" }
  );
  if (!state) {
    checks.push({
      name: "sensor",
      status: "fail",
      detail: "no session state; the status line has never run here",
      fix: "restart Claude Code after installing"
    });
  } else {
    const age = (now2 - state.updated_at) / 60;
    checks.push(
      state.samples.length === 0 ? {
        name: "sensor",
        status: "warn",
        detail: "state exists but holds no samples yet"
      } : {
        name: "sensor",
        status: age > 60 ? "warn" : "pass",
        detail: `${state.samples.length} sample(s), last updated ${age < 1 ? "just now" : `${Math.round(age)}m ago`}`
      }
    );
    const hasRateLimits = state.axes.five_hour || state.axes.seven_day;
    checks.push(
      hasRateLimits ? { name: "rate limits", status: "pass", detail: "account usage is being reported" } : {
        name: "rate limits",
        status: "warn",
        detail: "no rate_limits in the payload; only the context window is tracked",
        fix: "this is expected outside Claude.ai Pro and Max plans"
      }
    );
    const measurable = Object.values(state.axes).some((a) => a?.burn_pct_per_min !== null);
    checks.push({
      name: "burn rate",
      status: measurable ? "pass" : "warn",
      detail: measurable ? "measurable, so time-to-wall is real" : "not yet measurable; percentage floors are guarding instead"
    });
  }
  const ref = readBestHandoff(projectDir);
  const m = ref?.manifest ?? null;
  if (ref?.rescued) {
    checks.push({
      name: "handoff on offer",
      status: "warn",
      detail: `latest records nothing; audited the newest real handoff instead (${ref.path})`,
      fix: "run `/guardian resume` to promote it back, or `guardian handoff` to seal now"
    });
  }
  if (!m) {
    checks.push({
      name: "handoff",
      status: "fail",
      detail: "no manifest has ever been sealed in this project",
      fix: "run `guardian handoff` \u2014 until then a lost session loses its work"
    });
    return checks;
  }
  const sealedAgo = (now2 - m.sealed_at) / 60;
  const ago = sealedAgo < 1 ? "just now" : `${Math.round(sealedAgo)}m ago`;
  const since = Math.max(0, (newestActivity(projectDir) - m.sealed_at) / 60);
  checks.push({
    name: "handoff",
    status: since > 0 ? "warn" : "pass",
    detail: since > 0 ? `sealed ${ago} \u2014 ${m.seal_reason}; work recorded ${Math.round(since)}m later, so everything below is that stale` : `sealed ${ago} \u2014 ${m.seal_reason}`,
    ...since > 0 ? { fix: "run `guardian handoff` to seal the current state" } : {}
  });
  checks.push(...auditManifest(projectDir, m));
  return checks;
}
function newestActivity(projectDir) {
  let newest = 0;
  try {
    const dir = (0, import_node_path16.join)(stateDir(projectDir), "sessions");
    for (const f of (0, import_node_fs18.readdirSync)(dir)) {
      if (!f.endsWith(".ledger.jsonl")) continue;
      const lines = readTail((0, import_node_path16.join)(dir, f), 64 * 1024).split(String.fromCharCode(10));
      for (let i = lines.length - 1; i >= 0; i--) {
        const l = lines[i].trim();
        if (!l.startsWith("{")) continue;
        try {
          const t = JSON.parse(l).t;
          if (typeof t === "number" && Number.isFinite(t)) newest = Math.max(newest, t);
        } catch {
          continue;
        }
        break;
      }
    }
  } catch {
  }
  return newest;
}
function recentChainFailures(projectDir, now2) {
  try {
    const lines = (0, import_node_fs18.readFileSync)(logPath(projectDir), "utf8").split("\n").slice(-400);
    let n = 0;
    for (const l of lines) {
      if (!l.includes("chained status line produced nothing")) continue;
      const t = Date.parse(l.slice(0, 24));
      if (Number.isFinite(t) && (now2 - t / 1e3) / 3600 < 6) n++;
    }
    return n;
  } catch {
    return 0;
  }
}
function auditManifest(projectDir, m) {
  const checks = [];
  const fromLedger = m.claude_supplied.next_action && m.claude_supplied.next_action_at === null ? nextActionStatus(projectDir, m.session.id)?.superseded ?? null : null;
  const sup = m.claude_supplied.next_action_superseded ?? fromLedger;
  checks.push(
    m.claude_supplied.next_action && sup ? {
      name: "next action",
      status: "fail",
      detail: `stale \u2014 ${m.claude_supplied.next_action_at === null ? "written before" : `written ${staleAge(m)} before the seal, with`} ${describeSuperseded(sup)} recorded after it: "${m.claude_supplied.next_action}"`,
      fix: 'guardian note --next "<what should happen now>" && guardian handoff'
    } : m.claude_supplied.next_action ? { name: "next action", status: "pass", detail: `"${m.claude_supplied.next_action}"` } : {
      name: "next action",
      status: "fail",
      detail: "absent \u2014 the resuming session has to guess where to start",
      fix: 'guardian note --next "<the single most specific next step>"'
    }
  );
  checks.push(
    m.objective ? { name: "objective", status: "pass", detail: m.objective } : {
      name: "objective",
      status: "warn",
      detail: "absent; the resuming session knows the steps but not the goal",
      fix: 'guardian note --objective "..."'
    }
  );
  const files = m.observed.files_touched;
  const hashed = files.filter((f) => f.sha256).length;
  checks.push(
    files.length === 0 ? { name: "files", status: "warn", detail: "no file edits recorded this session" } : {
      name: "files",
      status: hashed === files.length ? "pass" : "warn",
      detail: `${files.length} tracked, ${hashed} verifiable by hash`
    }
  );
  if (files.length) {
    const v = verify(projectDir, m);
    const changed = v.files.filter((f) => f.status === "changed").length;
    const missing = v.files.filter((f) => f.status === "missing").length;
    checks.push(
      changed || missing ? {
        name: "workspace",
        status: "warn",
        detail: `${changed} file(s) changed and ${missing} missing since the seal`,
        fix: "expected if work continued; reconcile on resume"
      } : { name: "workspace", status: "pass", detail: "matches the sealed manifest" }
    );
  }
  checks.push(
    m.observed.tests ? {
      name: "test baseline",
      status: m.observed.tests.ok === false ? "warn" : "pass",
      detail: `\`${m.observed.tests.command}\` \u2014 ${m.observed.tests.ok === null ? "result unclear" : m.observed.tests.ok ? "passing" : "FAILING at seal time"}`
    } : {
      name: "test baseline",
      status: "warn",
      detail: "no test command recorded; the resuming session cannot confirm the starting state"
    }
  );
  const cp = m.observed.checkpoint;
  if (!isRepo(projectDir)) {
    checks.push({
      name: "checkpoint",
      status: "skip",
      detail: "not a git repository; only hashes and a file list are recoverable"
    });
  } else if (cp?.kind === "ref" || cp?.kind === "stash") {
    const live = listCheckpoints(projectDir).includes(cp.ref ?? "");
    checks.push(
      live ? { name: "checkpoint", status: "pass", detail: `${cp.ref} (\`git show ${cp.sha?.slice(0, 8)}\`)` } : {
        name: "checkpoint",
        status: "fail",
        detail: `${cp.ref} is recorded but no longer exists`,
        fix: "the ref was deleted; uncommitted work at seal time is not recoverable"
      }
    );
  } else {
    checks.push({
      name: "checkpoint",
      status: "warn",
      detail: cp?.detail ?? "no checkpoint recorded"
    });
  }
  if (m.observed.in_flight_at_seal.length) {
    checks.push({
      name: "in flight",
      status: "warn",
      detail: `${m.observed.in_flight_at_seal.length} irreversible operation(s) started and never seen to return`,
      fix: "verify their state before trusting the workspace"
    });
  }
  const stranded = m.agents.filter((a) => a.status === "IN_FLIGHT_AT_SEAL");
  if (stranded.length) {
    checks.push({
      name: "agents",
      status: "warn",
      detail: `${stranded.length} subagent(s) were still running at seal time; their work is lost`,
      fix: "they are recorded but not resumable \u2014 re-run if needed"
    });
  }
  let digest = null;
  try {
    digest = (0, import_node_fs18.readFileSync)(latestDigestPath(projectDir), "utf8");
  } catch {
    digest = null;
  }
  checks.push(
    digest === null ? { name: "digest", status: "fail", detail: "latest.md is missing", fix: "re-seal with `guardian handoff`" } : digest.includes(m.sealed_at_iso) ? { name: "digest", status: "pass", detail: "the injectable summary exists" } : {
      name: "digest",
      status: "fail",
      detail: "latest.md is the digest of a different seal than the manifest audited here",
      fix: "run `/guardian resume` to promote the real handoff, or re-seal"
    }
  );
  return checks;
}
function renderChecks(checks) {
  const L = [];
  for (const c of checks) {
    L.push(`  [${MARK[c.status]}] ${c.name.padEnd(14)} ${c.detail}`);
    if (c.fix) L.push(`${" ".repeat(23)}\u2192 ${c.fix}`);
  }
  return L.join("\n");
}
function verdict(checks) {
  const fails = checks.filter((c) => c.status === "fail");
  const warns = checks.filter((c) => c.status === "warn");
  if (fails.length) {
    return {
      resumable: false,
      text: `NOT RESUMABLE \u2014 ${fails.length} problem(s) would stop a fresh session from continuing this work. Fix the FAIL lines above.`
    };
  }
  if (warns.length) {
    return {
      resumable: true,
      text: `RESUMABLE with gaps \u2014 ${warns.length} thing(s) a fresh session would have to rediscover.`
    };
  }
  return { resumable: true, text: "RESUMABLE \u2014 a fresh session has everything it needs." };
}
var COLD_MARKER = "HANDOFF-READ";
var COLD_PROMPT = [
  `Begin your reply with the token ${COLD_MARKER}.`,
  "Read .claude/guardian/handoff/latest.md and nothing else. Do not explore the codebase.",
  "Answer in at most 120 words:",
  "1. What is the single next action?",
  "2. Which file paths would you touch first?",
  "3. What can you NOT determine from the handoff alone?"
].join(" ");
function realNative(p) {
  try {
    return import_node_fs18.realpathSync.native(p);
  } catch {
    return p;
  }
}
function coldResume(projectDir, m, opts = {}) {
  const ref = m.observed.checkpoint?.ref;
  if (!isRepo(projectDir)) {
    return { ok: false, detail: "not a git repository, so there is no checkpoint to resume from" };
  }
  if (!ref || !listCheckpoints(projectDir).includes(ref)) {
    return { ok: false, detail: "the manifest has no live checkpoint ref to build a worktree from" };
  }
  const wt = realNative((0, import_node_fs18.mkdtempSync)((0, import_node_path16.join)((0, import_node_os4.tmpdir)(), "guardian-cold-")));
  const dir = (0, import_node_path16.join)(wt, "tree");
  try {
    const add = (0, import_node_child_process4.spawnSync)("git", ["worktree", "add", "--detach", dir, ref], {
      cwd: projectDir,
      encoding: "utf8",
      timeout: 6e4,
      windowsHide: true
    });
    if (add.status !== 0) {
      return { ok: false, detail: `git worktree add failed: ${(add.stderr ?? "").trim()}` };
    }
    const digestDest = (0, import_node_path16.join)(dir, ".claude", "guardian", "handoff", "latest.md");
    (0, import_node_fs18.mkdirSync)((0, import_node_path16.dirname)(digestDest), { recursive: true });
    (0, import_node_fs18.writeFileSync)(digestDest, (0, import_node_fs18.readFileSync)(latestDigestPath(projectDir), "utf8"));
    const run = spawnWithStdinFile("claude", ["-p", "--allowedTools", "Read"], COLD_PROMPT, {
      cwd: dir,
      timeoutMs: opts.timeoutMs ?? 24e4,
      shell: process.platform === "win32",
      payloadDir: wt
    });
    if (run.error || run.status !== 0) {
      return {
        ok: false,
        detail: `claude -p did not complete: ${run.error?.message ?? ((run.stderr ?? "").trim() || `exit ${run.status}`)}`,
        worktree: dir
      };
    }
    const answer = (run.stdout ?? "").trim();
    if (!answer.includes(COLD_MARKER)) {
      return {
        ok: false,
        detail: "the prompt never reached the cold session \u2014 it replied without the marker, so its answer says nothing about the handoff",
        answer,
        worktree: dir
      };
    }
    return {
      ok: true,
      detail: "a cold session read the handoff and answered",
      answer,
      namedAFile: namedARecordedFile(answer, m, projectDir),
      echoedNextAction: echoedNextAction(answer, m),
      worktree: dir
    };
  } finally {
    if (!opts.keep) {
      (0, import_node_child_process4.spawnSync)("git", ["worktree", "remove", "--force", dir], {
        cwd: projectDir,
        timeout: 3e4,
        windowsHide: true
      });
      try {
        (0, import_node_fs18.rmSync)(wt, { recursive: true, force: true });
      } catch {
      }
    }
  }
}
function namedARecordedFile(answer, m, projectDir) {
  const hay = answer.toLowerCase();
  return m.observed.files_touched.some((f) => {
    const rel = (0, import_node_path16.relative)(projectDir, f.path).replace(/\\/g, "/").toLowerCase();
    const base = rel.split("/").pop() ?? "";
    return base.length > 3 && hay.includes(base);
  });
}
function echoedNextAction(answer, m) {
  const next = m.claude_supplied.next_action;
  if (!next) return false;
  const words = next.toLowerCase().split(/[^a-z0-9_]+/).filter((w) => w.length > 4);
  if (!words.length) return false;
  const hay = answer.toLowerCase();
  const hits = words.filter((w) => hay.includes(w)).length;
  return hits / words.length >= 0.4;
}
function logTail(projectDir, lines = 40) {
  try {
    const raw = (0, import_node_fs18.readFileSync)((0, import_node_path16.join)(stateDir(projectDir), "logs", "guardian.log"), "utf8");
    const all = raw.split("\n").filter(Boolean);
    return all.slice(-lines).join("\n") || "(log is empty)";
  } catch {
    return "(no log; nothing has failed, since every hook fails open silently)";
  }
}

// src/cli.ts
var STDIN_COMMANDS = /* @__PURE__ */ new Set(["sense", "sense-agents", "hook"]);
var STDIN_TIMEOUT_MS = Number(process.env.GUARDIAN_STDIN_TIMEOUT_MS) || 2e3;
var capturedStdin = "";
function readStdin() {
  return capturedStdin;
}
function captureStdin(timeoutMs) {
  if (process.stdin.isTTY) return Promise.resolve("");
  return new Promise((resolve3) => {
    let buf = "";
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        process.stdin.pause();
        process.stdin.unref();
      } catch {
      }
      resolve3(buf);
    };
    const timer = setTimeout(done, timeoutMs);
    try {
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (d) => {
        buf += d;
      });
      process.stdin.on("end", done);
      process.stdin.on("error", done);
      process.stdin.resume();
    } catch {
      done();
    }
  });
}
function now() {
  const override = Number(process.env.GUARDIAN_NOW);
  return Number.isFinite(override) && override > 0 ? override : Date.now() / 1e3;
}
function flag(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] ?? null : null;
}
var USAGE = `guardian <command>

Sensor and status
  sense                    statusLine sensor: reads the payload on stdin, updates
                           state, prints the status segment
  sense-agents             subagentStatusLine sensor: per-agent context and pace
  status                   render the dashboard for this project's latest session

Handoff
  handoff [--reason R]     seal a handoff manifest now
           [--no-git]
  resume                   print the sealed handoff plus workspace verification,
                           and mark it consumed
  wait                     countdown to a rate-limit window reopening
  verify                   check the sealed manifest against the workspace
  note --objective|--next|--decision|--gotcha <text>
                           record what cannot be observed, for the next session

Configuration
  config                   list every setting, its value, and whether it is overridden
  config get <setting>     print one value
  config set <setting> <value> [...]
                           change one or more settings, validated before writing
  config unset <setting>   return a setting to its default
  config reset             remove all overrides
  config check             validate the current config file
  config path              print the config file path
  on | off                 enable or disable Guardian for this project

Diagnostics
  doctor [--cold] [--seal] print a self-check: could a fresh session resume this work?
         [--keep] [--strict]  --cold additionally cold-resumes it with claude -p
  log [--lines N]          tail Guardian log (empty unless something failed)

Setup
  init                     set up Guardian for the project you are in, whichever
                           settings file actually decides its status line
  install [--settings P]   point statusLine at Guardian, preserving any existing one
  uninstall [--settings P] restore the previous statusLine and delete checkpoint refs
  where                    print the command install would configure
  checkpoints              list Guardian's git checkpoint refs

Internal
  hook <EventName>         hook dispatch; reads the event payload on stdin
  mcp                      run the optional MCP server on stdio (3 tools)
  agents                   show live subagents and historical durations by type
`;
var NOTE_FLAGS = [
  ["--objective", "objective"],
  ["--next", "next_action"],
  ["--decision", "decision"],
  ["--gotcha", "gotcha"]
];
function cmdResume(projectDir, out) {
  const ref = readBestHandoff(projectDir);
  if (!ref) {
    out("No sealed handoff found for this project.\n");
    return 0;
  }
  const m = ref.manifest;
  if (ref.rescued) {
    out(`> The handoff on offer recorded nothing. This is the most recent one that does,
`);
    out(`> read from ${ref.path}. It is now the one on offer.

`);
  }
  let digest;
  if (ref.rescued) {
    digest = renderDigest(m, projectDir);
  } else {
    try {
      digest = (0, import_node_fs19.readFileSync)(latestDigestPath(projectDir), "utf8");
    } catch {
      digest = `(digest missing; manifest is at ${latestPath(projectDir)})`;
    }
  }
  out(`${digest}
`);
  const v = verify(projectDir, m);
  const by = (s) => v.files.filter((f) => f.status === s);
  const unchanged = by("unchanged").length;
  const changed = by("changed");
  const missing = by("missing");
  const unverifiable = by("unverifiable").length;
  out("## Workspace verification\n");
  if (unchanged) out(`- ${unchanged} file(s) unchanged since the handoff
`);
  if (unverifiable) out(`- ${unverifiable} file(s) too large to hash; not verified
`);
  if (changed.length) {
    out(`- CHANGED since the handoff (someone edited these outside it):
`);
    for (const f of changed.slice(0, 15)) out(`    ${f.path}
`);
    if (changed.length > 15) out(`    \u2026and ${changed.length - 15} more
`);
  }
  if (missing.length) {
    out(`- MISSING now:
`);
    for (const f of missing.slice(0, 15)) out(`    ${f.path}
`);
  }
  if (v.head_matches === true) out("- git HEAD is unchanged since the handoff\n");
  if (v.head_matches === false) out("- git HEAD has MOVED since the handoff\n");
  const stale = m.claude_supplied.next_action_superseded;
  if (!changed.length && !missing.length && v.head_matches !== false) {
    out(
      stale ? '\nThe workspace matches the handoff, but its "next action" is stale: re-derive the\nnext step from the sections above before acting.\n' : '\nThe workspace matches the handoff. Resume directly from "next action".\n'
    );
  } else {
    out('\nThe workspace has drifted from the handoff. Reconcile the differences above\nbefore acting on "next action".\n');
  }
  markConsumed(projectDir, now());
  return 0;
}
function cmdConfig(projectDir, argv, out) {
  const sub = argv[1] ?? "show";
  const file = configPath(projectDir);
  const report = (user) => {
    const problems = validateConfig(user);
    for (const p of problems) {
      out(`${p.severity === "error" ? "error" : "warning"}: ${p.path} \u2014 ${p.message}
`);
    }
    return problems.some((p) => p.severity === "error") ? 1 : 0;
  };
  switch (sub) {
    case "show": {
      const user = readUserConfig(projectDir);
      const effective = loadConfig(projectDir);
      out(`Guardian settings for ${projectDir}
`);
      out(`  file: ${file}${(0, import_node_fs19.existsSync)(file) ? "" : " (none yet; showing defaults)"}

`);
      let section = "";
      for (const [path, value] of flatten(effective)) {
        const top = path.split(".")[0];
        if (top !== section) {
          out(`
`);
          section = top;
        }
        const overridden = getPath(user, path) !== void 0;
        const shown = JSON.stringify(value);
        const help = HELP[path] ?? "";
        out(
          `  ${path.padEnd(38)} ${shown.padEnd(14)} ${overridden ? "set  " : "     "} ${help}
`
        );
      }
      out(`
Change one with:  /guardian config set <setting> <value>
`);
      return report(user);
    }
    case "get": {
      const path = argv[2];
      if (!path) {
        out("Usage: /guardian config get <setting>\n");
        return 1;
      }
      const v = getPath(loadConfig(projectDir), path);
      if (v === void 0) {
        out(`Unknown setting "${path}". Run /guardian config to list them.
`);
        return 1;
      }
      out(`${JSON.stringify(v)}
`);
      return 0;
    }
    case "set": {
      const pairs = argv.slice(2);
      if (!pairs.length || pairs.length % 2 !== 0) {
        out("Usage: /guardian config set <setting> <value> [<setting> <value> ...]\n");
        return 1;
      }
      let user = readUserConfig(projectDir);
      const applied = [];
      for (let i = 0; i < pairs.length; i += 2) {
        const path = pairs[i];
        const raw = pairs[i + 1];
        const c = coerceValue(path, raw);
        if (!c.ok) {
          out(`error: ${path} \u2014 ${c.error}
`);
          return 1;
        }
        user = setPath(user, path, c.value);
        applied.push(`${path} = ${JSON.stringify(c.value)}`);
      }
      const problems = validateConfig(user);
      const errors = problems.filter((p) => p.severity === "error");
      if (errors.length) {
        for (const p of errors) out(`error: ${p.path} \u2014 ${p.message}
`);
        out("\nNothing was written.\n");
        return 1;
      }
      writeUserConfig(projectDir, user);
      for (const a of applied) out(`set ${a}
`);
      for (const p of problems) out(`warning: ${p.path} \u2014 ${p.message}
`);
      out(`
${file}
`);
      if (applied.some((a) => a.startsWith("statusline.") || a.startsWith("render."))) {
        out("Status line changes appear on the next tick.\n");
      }
      return 0;
    }
    case "unset": {
      const path = argv[2];
      if (!path) {
        out("Usage: /guardian config unset <setting>\n");
        return 1;
      }
      const user = readUserConfig(projectDir);
      if (getPath(user, path) === void 0) {
        out(`"${path}" is not overridden; it is already at its default.
`);
        return 0;
      }
      writeUserConfig(projectDir, unsetPath(user, path));
      out(`unset ${path} \u2014 back to default ${JSON.stringify(getPath(DEFAULT_CONFIG, path))}
`);
      return 0;
    }
    case "reset": {
      out(
        deleteUserConfig(projectDir) ? `Removed ${file}. Every setting is back to its default.
` : "No overrides to remove; everything is already at its defaults.\n"
      );
      return 0;
    }
    case "check":
      return report(readUserConfig(projectDir));
    case "path":
      out(`${file}
`);
      return 0;
    default:
      out(`Unknown config subcommand "${sub}".
`);
      out("Try: show, get, set, unset, reset, check, path\n");
      return 1;
  }
}
function cmdDoctor(projectDir, argv, out) {
  const cold = argv.includes("--cold");
  const keep = argv.includes("--keep");
  const strict = argv.includes("--strict");
  if (argv.includes("--seal")) {
    const sid2 = latestSessionIn(projectDir);
    if (sid2) {
      seal(projectDir, sid2, readState(projectDir, sid2), "doctor --seal", now());
      out("Sealed a fresh handoff first.\n\n");
    }
  }
  const sid = latestSessionIn(projectDir);
  const state = sid ? readState(projectDir, sid) : null;
  const checks = audit(projectDir, state, now());
  out("Guardian self-check\n");
  out(`  project: ${projectDir}

`);
  out(`${renderChecks(checks)}

`);
  const v = verdict(checks);
  out(`${v.text}
`);
  if (!cold) {
    out("\nThat was the static audit, which costs nothing. To test the handoff for real \u2014\n");
    out("cold-resume it in a scratch worktree with a fresh model that has never seen this\n");
    out("session \u2014 run `/guardian doctor --cold`. That spends real budget.\n");
    return strict && !v.resumable ? 1 : 0;
  }
  const m = readBestHandoff(projectDir)?.manifest ?? null;
  if (!m) {
    out("\nNo manifest to cold-resume.\n");
    return 1;
  }
  out("\nCold resume: building a scratch worktree at the checkpoint and asking a fresh\n");
  out("session what it would do, with only the handoff to go on...\n\n");
  const r = coldResume(projectDir, m, { keep });
  if (!r.ok) {
    out(`  [FAIL] cold resume: ${r.detail}
`);
    return 1;
  }
  out(`  [ok  ] cold resume    ${r.detail}
`);
  out(
    `  [${r.echoedNextAction ? "ok  " : "warn"}] next action    ${r.echoedNextAction ? "the cold session restated the recorded next action" : "the cold session did not clearly restate the recorded next action"}
`
  );
  const hasFiles = m.observed.files_touched.length > 0;
  out(
    hasFiles ? `  [${r.namedAFile ? "ok  " : "warn"}] files          ${r.namedAFile ? "it named at least one file the manifest records" : "it named none of the files the manifest records"}
` : "  [--  ] files          the manifest records none, so there was nothing to name\n"
  );
  if (keep && r.worktree) out(`
  worktree kept at ${r.worktree}
`);
  out("\n--- what the cold session said ---\n");
  out(`${r.answer}
`);
  out("--- end ---\n\n");
  out("Those two checks are keyword overlap, not comprehension. Read the answer: if a\n");
  out("model with no memory of this work could not say what to do next, neither could you\n");
  out("tomorrow, and the manifest needs a better `note --next`.\n");
  const failed2 = !r.echoedNextAction || hasFiles && !r.namedAFile || !v.resumable;
  return strict && failed2 ? 1 : 0;
}
function main(argv) {
  const cmd = argv[0] ?? "status";
  const out = (s) => process.stdout.write(s);
  const projectDir = resolveStateRoot(process.cwd());
  const settingsFile = flag(argv, "--settings") ?? userSettingsPath();
  switch (cmd) {
    case "sense":
      out(sense(readStdin(), now()));
      return 0;
    case "sense-agents":
      out(senseAgents(readStdin(), now()));
      return 0;
    case "hook": {
      const event = argv[1] ?? "";
      const r = handle(event, readStdin(), now());
      if (r.stdout) out(r.stdout);
      if (r.stderr) process.stderr.write(r.stderr);
      return r.exit;
    }
    case "status": {
      const sid = latestSessionIn(projectDir);
      if (!sid) {
        out("Guardian has no state for this project yet.\n");
        return 0;
      }
      out(`${renderDashboard(readState(projectDir, sid), loadConfig(projectDir))}
`);
      out(`
state: ${statePath(projectDir, sid)}
`);
      return 0;
    }
    case "handoff": {
      const sid = latestSessionIn(projectDir);
      if (!sid) {
        out("Guardian has no state for this project yet; nothing to seal.\n");
        return 0;
      }
      const reason = flag(argv, "--reason") ?? "manual";
      const state = readState(projectDir, sid);
      const m = seal(projectDir, sid, state, reason, now(), {
        git: !argv.includes("--no-git")
      });
      writeState(projectDir, { ...state, manifest: { sealed_at: m.sealed_at } });
      const cp = m.observed.checkpoint;
      out(`Sealed handoff (${reason}).
`);
      const onOffer = readLatest(projectDir);
      if (!onOffer || onOffer.sealed_at !== m.sealed_at || onOffer.session.id !== m.session.id) {
        out("  NOT on offer:  this session recorded nothing, so `latest` still holds the\n");
        out(`                 handoff from session ${onOffer?.session.id ?? "unknown"} `);
        out(`(${onOffer?.observed.files_touched.length ?? 0} file(s)). This seal is
`);
        out("                 archived under handoff/history.\n");
      }
      out(`  files tracked: ${m.observed.files_touched.length}
`);
      out(`  commits:       ${m.observed.commits.length}
`);
      out(`  checkpoint:    ${cp ? `${cp.kind}${cp.ref ? ` ${cp.ref}` : ""} \u2014 ${cp.detail}` : "skipped"}
`);
      out(`  manifest:      ${latestPath(projectDir)}
`);
      const flying = m.agents.filter((a) => a.status === "IN_FLIGHT_AT_SEAL");
      if (flying.length) {
        out(`
  ${flying.length} agent(s) were still running and are NOT paused by this seal:
`);
        for (const a of flying) out(`    ${a.type} (${a.id}) \u2014 redo cost ${a.redo_cost_estimate}
`);
        out("  They keep going. The manifest records them so the next session knows what\n");
        out("  may need redoing; let them finish if you can.\n");
      }
      const sup = m.claude_supplied.next_action_superseded;
      if (!m.claude_supplied.next_action) {
        out("\nNo next action recorded. Add one so the next session does not have to guess:\n");
        out('  guardian note --next "<the single most specific next step>"\n');
      } else if (sup) {
        out(`
The next action in this handoff is ${staleAge(m)} old, and `);
        out(`${describeSuperseded(sup)} were recorded after it. It describes work that
`);
        out("has since happened. Replace it and seal again:\n");
        out('  guardian note --next "<the single most specific next step>"\n');
        out(`  guardian handoff --reason "${reason}"
`);
      }
      const silent = m.agents.filter((a) => a.status === "IN_FLIGHT_AT_SEAL" && !a.notes_recorded);
      if (silent.length) {
        out(`
${silent.length} running agent(s) have written nothing down, so their work is
`);
        out("not in this handoff. Let them return before you stop if you can:\n");
        for (const a of silent) out(`    ${a.type} (${a.id}) \u2014 ${a.description ?? "no description"}
`);
      }
      return 0;
    }
    case "mcp":
      serve(now);
      return 0;
    case "doctor":
      return cmdDoctor(projectDir, argv, out);
    case "log": {
      const n = Number(flag(argv, "--lines") ?? 40);
      out(`${logTail(projectDir, Number.isFinite(n) ? n : 40)}
`);
      return 0;
    }
    case "config":
      return cmdConfig(projectDir, argv, out);
    // The two switches worth having as one word each.
    case "on":
    case "off": {
      const enabled = cmd === "on";
      writeUserConfig(projectDir, setPath(readUserConfig(projectDir), "enabled", enabled));
      out(`Guardian ${enabled ? "enabled" : "disabled"} for this project.
`);
      if (!enabled) out("The status line stays installed but says nothing.\n");
      return 0;
    }
    case "wait": {
      const sid = latestSessionIn(projectDir);
      const st = sid ? readState(projectDir, sid) : null;
      const hs = st?.hard_stop ?? null;
      if (!hs) {
        out("No rate-limit stop recorded for this project.\n");
        return 0;
      }
      const t = now();
      out(`Rate limit: ${hs.kind}
`);
      out(`Refused at: ${new Date(hs.at * 1e3).toISOString()}
`);
      if (hs.resets_at) {
        out(`Reopens at: ${new Date(hs.resets_at * 1e3).toISOString()}
`);
        out(`Status:     ${countdown(hs.resets_at, t)}
`);
      } else {
        out("Reopens at: unknown (the transcript did not record it)\n");
      }
      out("\nThe work is sealed. Run /guardian resume once the window reopens.\n");
      return 0;
    }
    case "resume":
      return cmdResume(projectDir, out);
    case "verify": {
      const ref = readBestHandoff(projectDir);
      if (!ref) {
        out("No sealed handoff to verify.\n");
        return 0;
      }
      const m = ref.manifest;
      if (ref.rescued) out(`(latest records nothing; verifying ${ref.path} instead)

`);
      const v = verify(projectDir, m);
      for (const f of v.files) out(`${f.status.padEnd(13)} ${f.path}
`);
      out(`
git HEAD: ${v.head_matches === null ? "not comparable" : v.head_matches ? "unchanged" : "moved"}
`);
      return 0;
    }
    case "note": {
      const sid = latestSessionIn(projectDir) ?? "manual";
      let wrote = 0;
      for (const [f, field] of NOTE_FLAGS) {
        const text2 = flag(argv, f);
        if (text2) {
          appendEvent(projectDir, sid, { k: "note", t: now(), field, text: text2 });
          out(`recorded ${field}
`);
          wrote++;
        }
      }
      if (!wrote) {
        out("Nothing recorded. Pass one of --objective, --next, --decision, --gotcha.\n");
        return 1;
      }
      return 0;
    }
    case "install": {
      const r = install(projectDir, settingsFile);
      out(`Guardian installed.
  settings: ${r.settingsFile}
  command:  ${guardianCommand("sense")}
`);
      out(
        r.alreadyInstalled ? "  (was already installed; refreshed)\n" : r.chained ? `  chained your existing status line: ${r.chained}
` : "  no existing status line to chain\n"
      );
      out("\nRestart Claude Code \u2014 the status line command is read at startup.\n");
      return 0;
    }
    case "init": {
      const r = init(projectDir);
      const where = r.scope === "user" ? "your user settings \u2014 this covers every project that has none of its own" : `this project only, overriding ${r.displaced}
            (settings.local.json is personal, so no absolute path reaches the repo)`;
      out(`Guardian initialised for ${r.projectDir}
`);
      out(`  settings: ${r.settingsFile}
            ${where}
`);
      out(`  state:    ${stateDir(r.projectDir)} (ignores itself; nothing to add to .gitignore)
`);
      if (r.alreadySensing) {
        out("  status line already points at Guardian; state directory verified.\n");
      } else if (r.chained) {
        out(`  kept the status line that was there, and runs it first:
    ${r.chained}
`);
      } else {
        out("  no existing status line to keep.\n");
      }
      out("\nRestart Claude Code \u2014 the status line command is read at startup.\n");
      return 0;
    }
    case "uninstall": {
      const file = flag(argv, "--settings") ?? findGuardianSettings(projectDir) ?? settingsFile;
      const restored = uninstall(projectDir, file);
      const refs = removeCheckpoints(projectDir);
      const wroteBack = (0, import_node_fs19.existsSync)(file) && (0, import_node_fs19.readFileSync)(file, "utf8").includes('"statusLine"');
      out("Guardian uninstalled.\n");
      out(
        restored ? wroteBack ? `  restored: ${restored}
` : `  override removed from ${file}
  back in charge: ${restored}
` : "  statusLine removed\n"
      );
      out(`  checkpoint refs deleted: ${refs}
`);
      out(`  state left in place at ${stateDir(projectDir)} (delete it to remove all traces)
`);
      const remaining = findGuardianSettings(projectDir);
      if (remaining) {
        out(`
Still wired at ${remaining}.
`);
        out(`  guardian uninstall --settings "${remaining}"
`);
        out("  That layer has no recorded status line to restore, so it will be removed.\n");
      }
      return 0;
    }
    case "checkpoints": {
      const refs = listCheckpoints(projectDir);
      if (!refs.length) out("No Guardian checkpoints in this repository.\n");
      for (const r of refs) out(`${r}
`);
      return 0;
    }
    case "agents": {
      const sid = latestSessionIn(projectDir);
      const f = sid ? readAgents(projectDir, sid) : null;
      const live = f ? Object.values(f.agents) : [];
      if (!live.length) out("No live subagents recorded.\n");
      else {
        const stats0 = typeStats(projectDir);
        const rows = live.map((a) => {
          const typical = a.type ? stats0[a.type] : void 0;
          return [
            a.name ?? a.type ?? a.id,
            a.context_window && a.token_count !== null ? `${fmtTokens(a.token_count)}/${fmtTokens(a.context_window)}` : a.token_count !== null ? fmtTokens(a.token_count) : "\u2014",
            a.context_window && a.token_count !== null ? `${(a.token_count / a.context_window * 100).toFixed(0)}%` : "\u2014",
            a.tokens_per_min ? `${fmtTokens(a.tokens_per_min)}/min` : "\u2014",
            a.started_at ? fmtElapsed((now() - a.started_at) / 60) : "\u2014",
            typical ? `\u2248${fmtMin(typical.median_s / 60)}` : "\u2014"
          ];
        });
        const header = ["AGENT", "CONTEXT", "FULL", "PACE", "ELAPSED", "TYPICAL"];
        const right = [false, true, true, true, true, true];
        const w = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
        const line = (cells) => cells.map((c, i) => right[i] ? c.padStart(w[i]) : c.padEnd(w[i])).join("  ").trimEnd();
        out(`${line(header)}
`);
        for (const r of rows) out(`${line(r)}
`);
      }
      const stats = typeStats(projectDir);
      const entries = Object.entries(stats);
      if (entries.length) {
        out("\nHistorical duration by agent type:\n");
        const tw = Math.max(...entries.map(([t]) => t.length));
        for (const [type, st] of entries) {
          out(`  ${type.padEnd(tw)}  median ${String(fmtMin(st.median_s / 60)).padStart(6)}  (n=${st.count})
`);
        }
      } else {
        out("\nNo completed agents recorded yet, so no duration history.\n");
      }
      return 0;
    }
    case "where":
      out(`${guardianCommand("sense")}
`);
      return 0;
    case "version":
      out(`${VERSION}
`);
      return 0;
    default:
      out(USAGE);
      return cmd === "help" ? 0 : 1;
  }
}
var wanted = STDIN_COMMANDS.has(process.argv[2] ?? "") ? captureStdin(STDIN_TIMEOUT_MS) : Promise.resolve("");
void wanted.then((payload) => {
  capturedStdin = payload;
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch {
    process.exitCode = 0;
  }
}).catch(() => {
  process.exitCode = 0;
});
