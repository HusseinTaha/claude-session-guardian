# Claude Session Guardian

Sees every Claude Code exhaustion wall coming **with time-to-impact**, not just a percentage,
and lands the session before it hits.

> Status: **Phases 1–2 complete** — sensor and time-to-wall engine; observation ledger,
> handoff manifest, lossless compaction, resume with workspace verification, git checkpoints.
> Phases 3–5 (agent safety, landing protocol, `doctor`) are specified but not built.
>
> **[Full user guide with examples →](docs/GUIDE.md)**

## The problem

A long Claude Code session dies in one of four ways: the 5-hour rate limit, the 7-day rate
limit, a spend limit, or the context window filling up. Only the last one is graceful. The
others return HTTP 429 mid-task and take every in-flight thread down with them.

## Why time-to-wall, not percentage

The obvious design — warn at 80%, panic at 95% — gets the most important case backwards.

At **97% of the 5-hour window with a reset three minutes away**, the correct action is to
keep working: the window refills before you can exhaust it. A percentage threshold declares
an emergency and throws away a perfectly good session.

Guardian instead computes, per axis:

```
headroom = (100 - used%) / burn_rate        # %/min, smoothed
safe if  headroom > minutes_until_reset + margin
```

When the window outruns the burn rate, the axis is safe **at any percentage**. Otherwise
`headroom` is a real countdown in minutes, which is the number you can actually act on.

Each axis also gets its own state machine, because the walls are not comparable:

| Axis | Wall | Recovery |
|---|---|---|
| `context` | auto-compaction | lossy, automatic, seconds |
| `five_hour` | HTTP 429 | wait for the reset |
| `seven_day` | HTTP 429 | wait days |
| `spend` | hard block | billing period |

Context is deliberately capped below `EMERGENCY`: its wall is compaction, which happens
several times a day and recovers by itself. Treating it like a 429 would cry wolf.

## Architecture: sensors write, actuators read

Guardian has no daemon and polls nothing.

The `statusLine` command already receives everything needed on stdin —
`context_window.used_percentage`, `rate_limits.five_hour.{used_percentage,resets_at}`,
`rate_limits.seven_day`, `cost` — and re-runs on every session event. That is the sensor.
It recomputes burn rates and mode, writes a small `state.json`, and prints the bar.

Hooks are the actuators. They read that pre-computed state and act, so the analysis never
sits on a blocking path:

| Hook | Does |
|---|---|
| `PostToolUse` (async) | records files, commands, commits — secrets redacted |
| `TaskCreated/Completed`, `SubagentStart/Stop` | task and agent ledgers, free |
| `PreCompact` | seals a handoff before context goes lossy |
| `PostCompact` | hands the digest straight back via `additionalContext` |
| `UserPromptSubmit` | offers a previous session's handoff, once |
| `SessionEnd` | last-chance seal (no git checkpoint — 1.5s shared budget) |

## Continuity

**Compaction stops being amnesia.** Seal on the way in, re-inject the digest on the way
out. This fires several times a day regardless of rate limits, so it pays off even in
sessions that never approach a wall.

**The manifest is observed, not composed.** The design this grew from had Claude author a
reflective summary at 95% usage — exactly when there is no budget left to reflect. Here the
hooks record files, commits, tasks, tests and agents as the session runs; only intent
(`--next`, `--objective`) needs the model, and that is two lines.

**Resume is verified, not assumed.** Every file carries a SHA-256, so a resuming session can
prove the work is still there:

```
## Workspace verification
- 13 file(s) unchanged since the handoff
- CHANGED since the handoff (someone edited these outside it):
    src/auth.ts
- git HEAD is unchanged since the handoff
```

**Git checkpoints stay out of your way.** Guardian captures the working tree — uncommitted
and untracked files included — as a real commit under `refs/guardian/<session>/<stamp>`,
written through a throwaway index. `HEAD`, the index and the worktree are untouched, `git
log` never shows it, `.gitignore` is honoured, and `uninstall` deletes every ref.

## Install

```bash
npm install && npm run build
node dist/guardian.cjs install     # or: /guardian install
```

Then **restart Claude Code** — the status line command is read at startup.

`install` never clobbers an existing status line. If you already have one, it is recorded
and re-run by the sensor on every tick, with Guardian's segment appended.

```
node dist/guardian.cjs uninstall   # restores exactly what was there before
```

## Usage

```
🛡 PREPARE ctx ▓▓▓▓▓░░░░░ 45% ⚠ ~28m  5h ▓▓▓▓▓▓▓▓░░ 83% ⚠ ~12m  $5.00
```

`/guardian status` renders the full picture:

```
╔═══════════════════════════════════════════════════════════════╗
║ CLAUDE SESSION GUARDIAN                                       ║
╠═══════════════════════════════════════════════════════════════╣
║ Mode:     LAND                                                ║
║ Why:      5-hour: 95% used, ~4m to wall, resets in 3.6h       ║
║                                                               ║
║ context    ▓▓▓▓▓▓░░░░  61.0%  burn 2.00 %/min   wall ~20m     ║
║ five_hour  ▓▓▓▓▓▓▓▓▓░  94.5%  burn 1.50 %/min   wall ~4m      ║
║ seven_day  ▓▓▓▓░░░░░░  41.2%  burn —            wall unknown  ║
╚═══════════════════════════════════════════════════════════════╝
```

Read `wall` carefully — it is the whole point:

- **`~4m`** — a real deadline. Land the plane.
- **`refills first`** — that window replenishes faster than you are burning it. Safe at any
  percentage.
- **`unknown`** — no burn rate yet (too few samples, or an idle session). The percentage
  floor is what is guarding, not the clock.

## Modes

| Mode | Trigger | Meaning |
|---|---|---|
| `NORMAL` | all axes > 30 min | silent |
| `WATCH` | any axis < 30 min, or > 80% | keep an eye on it |
| `PREPARE` | any axis < 12 min | stop starting expensive work |
| `LAND` | any axis < 5 min | seal state; no new subagents *(Phase 3)* |
| `EMERGENCY` | any axis < 90 s | checkpoint and stop *(Phase 4)* |
| `HARD_STOPPED` | 429 observed | wait for the reset *(Phase 4)* |

Thresholds are minutes, configurable in `.claude/guardian/config.json`. Percentage floors
remain as a fallback for when burn rate is not yet measurable.

## Design rules

**Fail open.** A watchdog that breaks the session it watches is worse than no watchdog.
Every path exits 0 with usable output: malformed payloads, corrupt state, an unwritable
state directory, a missing config. The suite asserts this rather than assuming it.

**Stay cheap.** The sensor runs on every session event. Measured p50 **4.4 ms**, p95
**7.3 ms** of compute (≈65 ms wall clock per invocation on Windows, dominated by Node's
cold start, which Guardian cannot optimise away). No git calls, no network, no directory
walks on the hot path. Observation hooks are `async`, so a tool call never waits.

**Never store a secret.** Recorded commands pass through a redaction pass first — token
shapes, `KEY=value`, `Authorization:` headers, URL credentials. The digest is injected back
into a context window, and context windows end up in transcripts.

**Windows first.** Node-only, no shell scripts, forward slashes everywhere — backslashes in
a configured command get consumed as escapes before the script runs.

**Stay local.** State lives in `.claude/guardian/`, which gitignores itself on creation:
it holds prompts and paths and does not belong in a commit.

## Development

```bash
npm run check      # typecheck + build + 99 tests
```

`GUARDIAN_NOW=<epoch>` replays a session at its original timestamps, which is how the mode
ladder is demonstrated and reproduced.

## Layout

```
src/burn.ts     burn-rate estimation over a trailing window, reset-aware
src/mode.ts     time-to-wall + the per-axis state machines
src/sense.ts    the statusLine sensor (pure core + I/O shell)
src/state.ts    atomic, Infinity-safe state persistence
src/install.ts  status line install with chaining
src/render.ts   status bar and dashboard
src/hooks.ts    hook dispatch: observation in, continuity out
src/ledger.ts   append-only observation log
src/manifest.ts manifest build, seal, digest, verification
src/git.ts      out-of-band checkpoint refs
src/redact.ts   secret redaction for recorded commands
```
