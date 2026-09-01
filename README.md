# Claude Session Guardian

Sees every Claude Code exhaustion wall coming **with time-to-impact**, not just a percentage,
and lands the session before it hits.

> Status: **complete** — all five phases. Sensor and time-to-wall engine; observation
> ledger, handoff manifest, lossless compaction, verified resume, git checkpoints; per-agent
> sensing, the spawn gate, self-checkpointing subagents; tiered injection, the Stop brake,
> 429 recovery; a validated config CLI, the `doctor` self-check with a cold-resume harness,
> and an optional three-tool MCP server. 189 tests.
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
| `PreToolUse` (sync) | denies subagent spawns near a wall; annotates them just before |
| `PostToolUse` (async) | records files, commands, commits — secrets redacted |
| `TaskCreated/Completed`, `SubagentStart/Stop` | task and agent ledgers, free |
| `PreCompact` | seals a handoff before context goes lossy |
| `PostCompact` | hands the digest straight back via `additionalContext` |
| `UserPromptSubmit` | offers a previous session's handoff once; injects the mode brief |
| `Stop` | refuses one turn-end at LAND+ with nothing sealed — single-shot |
| `StopFailure` | reads the 429 tombstone, seals, switches to HARD_STOPPED |
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

## Agent safety

A subagent's state **is** its context — nothing can pause it, and nothing can resume it. So
Guardian works on the only three levers that exist.

**It measures.** `subagentStatusLine` supplies per-agent token counts, which become a live
context-fill percentage and a token rate. Alongside them sits the median duration of past
runs of that agent type in this project, labelled `≈` with its sample size — a measurement
of history, never dressed up as a prediction about the run in front of you.

```
Explore · ctx 18% · 2m of ≈5m (n=5)
Build endpoint · ctx 91% · 2m of ≈18m (n=3) · ⚠ ctx full ~1m
```

**It annotates.** At `PREPARE`, `PreToolUse` returns `updatedInput` and rewrites the agent's
own prompt: write findings to disk as you go, prefer a partial answer to nothing. An agent
cut off at minute four then leaves usable work behind. This is the honest substitute for
pausing one.

**It refuses.** At `LAND`, new spawns get `permissionDecision: "deny"` — deterministic, not
a suggestion Claude can talk itself out of. The reason always names the config key that
lifts it, because a block you cannot get past is a trap.

Nothing else is ever blocked, at any mode. Irreversible shell work — migrations, deploys,
`terraform apply` — is deliberately *recorded* rather than stopped: refusing to start a
migration is sometimes right and sometimes leaves a system half-configured, and Guardian
cannot tell which. If one starts and is never seen to return, the handoff leads with it.

## Landing

Injection cost scales with mode, because Guardian must not spend the budget it protects.
Nothing below `PREPARE`; one line at `PREPARE`; the landing protocol at `LAND`; two commands
at `EMERGENCY`. The deeper checklist is a skill that loads only when needed.

If the session tries to end at `LAND` or above with nothing sealed, the `Stop` hook refuses
the turn-end **once** and asks for a next action and a handoff. A `Stop` hook that can fire
twice is a loop and worse than no hook, so the latch is persisted before the refusal is
returned, and the suite hammers it ten times to prove it.

When a 429 lands anyway, `StopFailure` reads the `quotaLimits` record the transcript leaves
behind — the only place the exact reset timestamp survives — seals a handoff, and switches
to `HARD_STOPPED` with a countdown:

```
$ /guardian wait
Rate limit: five_hour
Reopens at: 2026-09-01T12:30:00.000Z
Status:     80m until the window reopens
```

## Configuration

Everything is set from the command, validated before it is written:

```
/guardian config                                  list every setting and what it does
/guardian config set thresholds_minutes.land 8
/guardian config set agents.deny_spawn_from EMERGENCY
/guardian config reset
/guardian off
```

```
$ /guardian config set thresholds_minutes.land 40
error: thresholds_minutes.land — must be <= thresholds_minutes.prepare (12); otherwise
PREPARE can never be reached before LAND

Nothing was written.
```

Types come from the defaults rather than a separate schema, so a new option is configurable
the moment it has a default and the two cannot drift apart. Unknown keys are reported rather
than ignored — a typo in `config.json` is otherwise silent, which is the whole reason to
prefer the CLI over the file.

## Does it actually work?

```
/guardian doctor
```

Free and instant. One question: if this session died right now, could a fresh one continue?

```
  [ok  ] sensor         21 sample(s), last updated just now
  [ok  ] handoff        sealed 2m ago — PreCompact (auto)
  [FAIL] next action    absent — the resuming session has to guess where to start
                       → claude-guardian note --next "<the single most specific next step>"
  [ok  ] files          14 tracked, 14 verifiable by hash
  [ok  ] checkpoint     refs/guardian/s1/… (`git show 2c9d9f7a`)

NOT RESUMABLE — 1 problem(s) would stop a fresh session from continuing this work.
```

Every `FAIL` carries the command that fixes it. A missing next action is a failure, not a
warning: it is the one field nothing else substitutes for.

`--cold` goes further and tests the parachute. It builds a scratch worktree at the
checkpoint, drops in only the digest, and runs a fresh `claude -p` that has never seen the
session — then prints what it concluded. The two mechanical checks are keyword overlap, not
comprehension; the value is reading what a cold reader actually understood. If a model with
no memory of the work cannot say what to do next, neither could you tomorrow.

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
npm run check      # typecheck + layer check + build + 189 tests
npm run layers     # assert imports only point downward
```

`GUARDIAN_NOW=<epoch>` replays a session at its original timestamps, which is how the mode
ladder is demonstrated and reproduced.

## Layout

The folders are the architecture. Imports only ever point downward, and
`npm run layers` fails the build if that stops being true.

```
src/
├── types.ts              shared types; everything imports this
├── cli.ts                entry point, wires the layers together
│
├── core/                 foundations
│   ├── paths.ts          state-root resolution, self-ignoring state dir
│   ├── config.ts         defaults and merge
│   ├── state.ts          atomic, Infinity-safe persistence
│   ├── sessions.ts       "which session is this?"
│   └── log.ts            best-effort logging that never throws
│
├── budget/               the time-to-wall engine
│   ├── burn.ts           reset-aware rate estimation over a trailing window
│   └── mode.ts           per-axis state machines and the mode ladder
│
├── format/               presentation of budget numbers
│   └── render.ts         status bar and dashboard
│
├── handoff/              the durable record
│   ├── ledger.ts         append-only observation log
│   ├── manifest.ts       build, seal, digest, verify
│   ├── git.ts            out-of-band checkpoint refs
│   └── redact.ts         secret removal for recorded commands
│
├── sensors/              write state, never block
│   ├── statusline.ts     the statusLine sensor
│   ├── subagents.ts      the subagentStatusLine sensor
│   └── agents.ts         per-agent sampling and historical durations
│
├── actuators/            read pre-computed state and act
│   ├── dispatch.ts       hook routing
│   ├── gate.ts           the spawn gate and boundary marking
│   └── landing.ts        tiered injection, Stop brake, 429 tombstones
│
└── ui/                   what a person or a client talks to
    ├── install.ts        status line install with chaining
    ├── configCmd.ts      config get/set/unset with validation
    ├── doctor.ts         the self-check and cold-resume harness
    └── mcp.ts            optional three-tool MCP server
```

`sensors/` importing `format/` is the one edge worth explaining: the statusLine sensor both
updates state and prints the bar, so it legitimately needs a formatter. `render.ts` sits
below it rather than in `ui/` because it is a leaf — it formats numbers and imports nothing
but types and `budget/mode.ts`.
