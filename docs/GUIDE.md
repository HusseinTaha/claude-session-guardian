# Claude Session Guardian — User Guide

Guardian watches the four ways a Claude Code session can die and tells you **how many
minutes you have left**, not just what percentage you have used. When a wall is genuinely
close, it seals a handoff so the next session can pick the work up exactly where it stopped.

- [Install](#install)
- [Reading the status line](#reading-the-status-line)
- [The four axes](#the-four-axes)
- [A day with Guardian](#a-day-with-guardian)
- [Compaction](#compaction)
- [Handing off and resuming](#handing-off-and-resuming)
- [Subagents near a wall](#subagents-near-a-wall)
- [Recording what cannot be observed](#recording-what-cannot-be-observed)
- [Git checkpoints](#git-checkpoints)
- [Configuration](#configuration)
- [Command reference](#command-reference)
- [Troubleshooting](#troubleshooting)
- [What Guardian does not do](#what-guardian-does-not-do)

---

## Install

```bash
git clone <this repo> && cd claude-session-guardian
npm install
npm run build
node dist/guardian.cjs install
```

Then **restart Claude Code**. The status line command is read at startup, so a running
session will not pick it up.

```
$ node dist/guardian.cjs install
Guardian installed.
  settings: C:\Users\you\.claude\settings.json
  command:  node "C:/path/to/dist/guardian.cjs" sense
  chained your existing status line: ~/.claude/my-bar.sh

Restart Claude Code — the status line command is read at startup.
```

Note the third line. If you already had a status line, Guardian **keeps** it: it runs your
command on every tick and appends its own segment. Nothing you had is lost.

As a plugin instead:

```
/plugin marketplace add <this repo>
/plugin install claude-session-guardian
```

The plugin brings the hooks with it, which is what makes compaction survivable. Without
them you still get the gauge, but not the handoff.

To remove everything:

```bash
node dist/guardian.cjs uninstall     # restores your old status line, deletes checkpoint refs
rm -rf .claude/guardian              # and the state, if you want it gone
```

---

## Reading the status line

Guardian adds one segment. It is quiet when there is nothing to say.

**Normal — nothing to think about.** The shield is dim and there are no clocks.

```
🛡 ctx ▓▓░░░░░░░░ 21%  5h ▓▓▓░░░░░░░ 34%  $1.20
```

**WATCH — a wall is on the horizon.** Amber. The `⚠ ~26m` is the part that matters: at the
current burn rate you have about 26 minutes of 5-hour budget left.

```
🛡 WATCH ctx ▓▓░░░░░░░░ 17% ⚠ ~42m  5h ▓▓▓▓▓▓░░░░ 62% ⚠ ~26m  $1.08
```

**PREPARE — stop starting things you cannot finish.** Bold amber, under 12 minutes.

```
🛡 PREPARE ctx ▓▓▓▓▓░░░░░ 45% ⚠ ~28m  5h ▓▓▓▓▓▓▓▓░░ 83% ⚠ ~12m  $5.00
```

**LAND — finish what is open and seal it.** Red, under 5 minutes.

```
🛡 LAND ctx ▓▓▓▓▓▓░░░░ 61% ⚠ ~20m  5h ▓▓▓▓▓▓▓▓▓░ 95% ⚠ ~4m  $7.24
```

**EMERGENCY — the next request may 429.** Inverted red, under 90 seconds.

```
🛡 EMERGENCY ctx ▓▓▓▓▓▓▓░░░ 70% ⚠ ~15m  5h ▓▓▓▓▓▓▓▓▓▓ 98% ⚠ ~2m
```

### The one case worth internalising

```
🛡 ctx ▓▓░░░░░░░░ 20%  5h ▓▓▓▓▓▓▓▓▓░ 94%
```

**94% and no warning at all.** That is not a bug. The 5-hour window refills faster than
this session is consuming it, so it cannot actually be exhausted — the axis is safe at any
percentage. A tool that panicked at 90% would have made you stop working for no reason.

The absence of a `⚠ ~Nm` clock is the signal. No clock, no deadline.

### The dashboard

```
$ /guardian status

╔═══════════════════════════════════════════════════════════════╗
║ CLAUDE SESSION GUARDIAN                                       ║
╠═══════════════════════════════════════════════════════════════╣
║ Mode:     LAND                                                ║
║ Why:      5-hour: 95% used, ~4m to wall, resets in 3.6h       ║
║                                                               ║
║ context    ▓▓▓▓▓▓░░░░  61.0%  burn 2.00 %/min   wall ~20m     ║
║ five_hour  ▓▓▓▓▓▓▓▓▓░  94.5%  burn 1.50 %/min   wall ~4m      ║
║ seven_day  ▓▓▓▓░░░░░░  41.2%  burn —            wall unknown  ║
║                                                               ║
║ Samples:  21                                                  ║
║ Manifest: not sealed                                          ║
╚═══════════════════════════════════════════════════════════════╝
```

Read the `wall` column:

| Value | Meaning |
|---|---|
| `~4m` | A real deadline. Act on it. |
| `refills first` | That window replenishes faster than you are burning it. Safe at any percentage. |
| `unknown` | No burn rate measurable yet — too few samples, or an idle session. The percentage floor is guarding, not the clock. |

`burn —` means the same thing: not enough movement to measure a rate.

---

## The four axes

Guardian tracks each separately, because the walls are not comparable.

| Axis | What hitting it does | Recovery |
|---|---|---|
| `context` | Auto-compaction | Lossy but automatic, seconds |
| `five_hour` | HTTP 429 | Wait for the reset |
| `seven_day` | HTTP 429 | Wait days |
| `spend` | Hard block | Billing period |

**Context is capped below EMERGENCY on purpose.** Filling the context window means
compaction, which happens several times a day and recovers by itself. Treating that like a
429 would make Guardian cry wolf constantly. It will reach `LAND` — enough to seal a
handoff before compaction — and no further.

`seven_day` and `spend` only appear if your account exposes them. `rate_limits` is
populated for Claude.ai Pro and Max subscribers, and only after the first API response in a
session. If you never see 5-hour or 7-day bars, your plan does not report them, and
Guardian falls back to tracking context alone.

---

## A day with Guardian

Mostly you do nothing. Guardian is silent below 30 minutes-to-wall, and the gauge is there
if you glance at it.

What changes:

**At PREPARE**, think twice before starting a fan-out of subagents or a large refactor you
cannot finish. The clock tells you whether it fits.

**At LAND**, wrap up. Seal a handoff:

```
/guardian handoff --reason "out of 5-hour budget"
```

**When a 429 lands anyway**, the work is not gone. Guardian sealed at compaction and at
session end, and the manifest is on disk. Start a new session after the reset and
`/guardian resume`.

---

## Compaction

This is the part that pays off every day, whether or not you ever hit a rate limit.

When Claude Code compacts the context, detail is lost — including which files you already
touched, what you already finished, and what you were about to do next. Guardian closes
that gap automatically:

1. `PreCompact` fires → Guardian seals a handoff from what it observed.
2. Compaction happens.
3. `PostCompact` fires → Guardian hands the digest straight back into the fresh context.

You see one line:

```
🛡 Guardian sealed a handoff before compaction (14 files tracked).
🛡 Guardian restored the pre-compaction handoff digest.
```

And Claude receives roughly this:

```markdown
Context was just compacted. The following handoff was sealed immediately beforehand
and is authoritative for what has already been done — do not redo work listed as
completed.

# Guardian handoff

Sealed 2026-09-01T09:12:34Z — PreCompact (auto)
Objective: Implement the authentication system

## Next action
Finish token rotation in src/auth.ts, then add tests

## Completed — do not redo
- JWT validation

## In progress
- Refresh token rotation

## Files touched (1)
- src/auth.ts `b7f81ea09585`

## Repository
- branch `main` at `d3d2d3cd`
- checkpoint `refs/guardian/sessA/2026-09-01T09-12-34-000Z` (`git show 2c9d9f7a`)
- 2 uncommitted file(s) at seal time

## Tests
`npm test` — passing

## Resume protocol
1. Verify the file hashes below still match. A mismatch means the file changed
   outside this handoff.
2. Run `npm test` before writing anything, to confirm the starting state.
3. Do NOT redo anything listed under "completed".
4. Resume from "next action".

_At seal: LAND — context 70%, 5-hour 98%, resets in 3.7h._
```

No action needed on your part. It just stops being amnesia.

---

## Handing off and resuming

### Sealing

```
$ /guardian handoff --reason "wrapping up for the day"
Sealed handoff (wrapping up for the day).
  files tracked: 14
  commits:       3
  checkpoint:    ref refs/guardian/sessA/2026-09-01T17-40-02-000Z — 6 uncommitted file(s) captured
  manifest:      C:\proj\.claude\guardian\handoff\latest.json
```

Almost all of that came from watching, not from asking Claude to write it down. That is
deliberate: at 97% usage there is no budget left for a session to compose a careful
summary of itself, so Guardian records as it goes and only needs a line or two of intent at
the end.

If no next action was recorded, it says so, because that is the field that matters most:

```
No next action recorded. Add one so the next session does not have to guess:
  claude-guardian note --next "<the single most specific next step>"
```

### Resuming

Start a new session in the same project. On your first message you will see Claude
acknowledge something like:

> An unfinished handoff from a previous session was sealed 2.0 hours ago. Objective:
> Implement the auth system. Next action recorded: Finish token rotation in src/auth.ts.

It is an **offer**, not an automatic restore — silently resuming days-old work would be
worse than the problem. If it is the work you meant, say so, or run it yourself:

```
/guardian resume
```

You get the full digest plus a verification of the workspace as it is *now*:

```
## Workspace verification
- 13 file(s) unchanged since the handoff
- CHANGED since the handoff (someone edited these outside it):
    C:/proj/src/auth.ts
- git HEAD is unchanged since the handoff

The workspace has drifted from the handoff. Reconcile the differences above
before acting on "next action".
```

That check is why the manifest stores a SHA-256 per file. "Do not redo completed work" is
an unenforceable wish without it; with it, the resuming session can *prove* the work is
still there. If a teammate rebased or you edited a file by hand in between, you find out
before Claude writes over it.

`resume` marks the manifest consumed, so it cannot be applied twice.

---

## Subagents near a wall

Fan-out is where a session loses the most work. A subagent's state **is** its context —
there is no external handle on it, nothing to pause, nothing to resume. If the session dies
at minute four of an eighteen-minute delegation, that delegation is simply gone.

Guardian does three things about it.

### It shows you what each agent is actually doing

The agent panel rows are replaced with the two facts that inform a decision:

```
Explore · ctx 18% · 2m of ~5m (n=5)
Build endpoint · ctx 91% · 2m of ~18m (n=3) · WARN ctx full ~1m
```

- **`ctx 91%`** — how full that agent's own context window is.
- **`2m of ~18m (n=3)`** — two minutes elapsed, against a **median of 3 past runs** of that
  agent type in this project. The `~` and the `n=` are deliberate: it is a measurement of
  history, not a prediction about this run. Guardian cannot know how much work an agent has
  left, and does not pretend to.
- **`ctx full ~1m`** — this one *is* a projection, and a sound one: tokens remaining divided
  by the measured token rate.

History accumulates across sessions:

```
$ claude-guardian agents
Explore                  18% ctx      2100 tok/min

Historical duration by agent type:
  Explore                  median 5m (n=5)
  general-purpose          median 18m (n=3)
```

That table is what makes "will this delegation fit in my remaining budget?" answerable.

### At PREPARE, it makes new agents self-checkpointing

The spawn still goes through, but Guardian rewrites the agent's prompt on the way past:

```
Research how payments are wired through the service layer.
---
Budget note from Session Guardian: this session is at PREPARE: about 11m of
five_hour budget left.
Work so that being cut off early still leaves something useful:
- Write findings to `.claude/guardian/agent-notes/payment-research.md` as you go,
  rather than only at the end.
- Prefer returning a partial answer over returning nothing.
- Do not start work you cannot bring to a reportable state quickly.
```

You see one line: `Guardian asked this agent to checkpoint as it goes (PREPARE).`

This is the honest substitute for pausing an agent. You cannot freeze one, but you can make
it leave a trail from the moment it is born.

### At LAND, it refuses the spawn

This is the one place Guardian actually says no, and it is a hard `deny` — not a suggestion
Claude may talk itself out of:

```
Session Guardian is in LAND — 5-hour: 96% used, ~4m to wall, resets in 3.6h. New
subagents are blocked because a delegated task cannot be checkpointed or resumed
once the session stops. 2 agent(s) already running; let them return. Finish or
seal the current work instead (`/guardian handoff`), or do the task inline where
its partial results stay in this session. To override, raise
agents.deny_spawn_from in .claude/guardian/config.json.
```

Note the last sentence. A block you cannot get past is a trap, so the reason always names
the setting that lifts it:

```json
{ "agents": { "deny_spawn_from": "EMERGENCY" } }
{ "agents": { "deny_spawn_from": "HARD_STOPPED" } }
{ "agents": { "deny_spawn_from": "PREPARE" } }
```

Those are, in order: later, effectively never, and earlier.

Nothing else is ever blocked. Edits, reads, searches and shell commands pass through
untouched at every mode, including `EMERGENCY`.

### Irreversible operations are recorded, never blocked

Migrations, deploys and `terraform apply` are matched separately:

```json
{ "safe_boundary_commands": ["*migrate*", "*deploy*", "terraform *", "*kubectl apply*"] }
```

Guardian **does not** stop these near a wall. Refusing to start a migration is sometimes
right and sometimes leaves a system half-configured, and Guardian cannot tell which. What it
does instead is note that one began. If the command never returns — because the session died
mid-flight — the handoff leads with it:

```markdown
## Possibly interrupted mid-operation
- `terraform apply -auto-approve` started and was never seen to finish
Check the state of these before assuming the workspace is consistent.
```

That is the single most valuable thing a resuming session can be told, because nothing on
disk necessarily reveals it.

## Recording what cannot be observed

Guardian sees files, commands, commits, tasks and agents. It cannot see *why*. Four fields
close that gap:

```bash
claude-guardian note --objective "Migrate billing off the legacy gateway"
claude-guardian note --next     "Wire StripeAdapter into PaymentService, then run integration tests"
claude-guardian note --decision "Chose idempotency keys over dedupe table — see ADR 014"
claude-guardian note --gotcha   "The staging webhook secret rotates nightly; re-fetch before testing"
```

`--next` is the highest-value line in the entire manifest. One specific sentence there
saves a resuming session several minutes of rediscovery.

Ask Claude to do it as part of wrapping up:

> Record a Guardian note with the next action before we stop.

---

## Git checkpoints

When Guardian seals a handoff in a git repository, it captures your working tree —
including uncommitted and untracked files — as a real commit under
`refs/guardian/<session>/<timestamp>`.

It does this without touching `HEAD`, your index, or your working tree, by writing through
a throwaway index. So:

- `git log` does not show it
- `git status` is unchanged
- nothing is staged or stashed on your behalf
- `.gitignore` is honoured, and Guardian's own state directory is excluded

To see what was captured:

```bash
$ node dist/guardian.cjs checkpoints
refs/guardian/sessA/2026-09-01T09-12-34-000Z

$ git show refs/guardian/sessA/2026-09-01T09-12-34-000Z          # as a normal diff
$ git ls-tree -r --name-only refs/guardian/sessA/2026-09-01T09-12-34-000Z
```

To recover a single file as it was at seal time:

```bash
git show refs/guardian/sessA/2026-09-01T09-12-34-000Z:src/auth.ts > src/auth.ts
```

To recover everything into a scratch worktree, leaving your current work alone:

```bash
git worktree add ../recovered refs/guardian/sessA/2026-09-01T09-12-34-000Z
```

To throw them all away:

```bash
node dist/guardian.cjs uninstall     # deletes every refs/guardian/* ref
```

Outside a git repository, Guardian records file hashes and a file list instead, and says so
in the manifest.

---

## Configuration

`.claude/guardian/config.json`, merged over the defaults. Everything is optional.

```json
{
  "enabled": true,

  "thresholds_minutes": { "watch": 30, "prepare": 12, "land": 5, "emergency": 1.5 },
  "thresholds_percent_floor": { "watch": 80, "prepare": 90, "land": 95, "emergency": 97 },

  "axes": { "context": true, "five_hour": true, "seven_day": true, "spend": true },
  "axis_severity_cap": { "context": "LAND" },

  "agents": {
    "deny_spawn_from": "LAND",
    "inject_checkpoint_prompt_from": "PREPARE"
  },
  "safe_boundary_commands": ["*migrate*", "*deploy*", "terraform *", "*kubectl apply*"],

  "burn": {
    "window_min": 10,
    "min_span_s": 45,
    "alpha": 0.35,
    "max_samples": 60,
    "reset_margin_min": 1,
    "min_samples": 3
  },

  "statusline": { "manage": true, "chain_existing": true, "chained_command": null },
  "render": { "bar_width": 10, "color": true }
}
```

| Key | Why you would change it |
|---|---|
| `thresholds_minutes` | The real controls. Raise `land` if you want more room to wrap up. |
| `thresholds_percent_floor` | Backstop for when burn rate is not yet measurable. |
| `axes` | Turn off an axis your plan does not report, to keep the bar short. |
| `axis_severity_cap` | Highest mode an axis may demand. Remove the `context` cap if you want compaction treated as an emergency. |
| `burn.window_min` | Longer is steadier, slower to notice a sudden fan-out. |
| `burn.alpha` | Higher reacts faster and is twitchier. |
| `burn.reset_margin_min` | Slack required before a refilling window counts as safe. Raise it if you distrust the estimate. |
| `burn.min_samples` | Readings required before a rate is believed. Two points can lie — one anomalous percentage would otherwise imply an absurd rate. |
| `agents.deny_spawn_from` | Mode at which new subagents are refused. `HARD_STOPPED` disables the gate. |
| `agents.inject_checkpoint_prompt_from` | Mode at which spawned agents get the self-checkpointing note. |
| `safe_boundary_commands` | Irreversible work to record as possibly-interrupted. Never blocked. |
| `render.color` | Set `false` for a terminal that mangles ANSI. |
| `enabled` | `false` makes Guardian completely silent while leaving it installed. |

Turning it off for one project:

```bash
echo '{ "enabled": false }' > .claude/guardian/config.json
```

---

## Command reference

| Command | Does |
|---|---|
| `/guardian` or `/guardian status` | Dashboard for this project's latest session |
| `/guardian handoff [--reason R] [--no-git]` | Seal a manifest now |
| `/guardian resume` | Print the sealed handoff plus workspace verification; mark consumed |
| `/guardian verify` | Check the manifest against the workspace without consuming it |
| `/guardian install` / `uninstall` | Set up or remove the status line |
| `claude-guardian note --objective\|--next\|--decision\|--gotcha <text>` | Record intent |
| `claude-guardian agents` | Live subagents, plus historical duration by agent type |
| `claude-guardian checkpoints` | List git checkpoint refs |
| `claude-guardian where` | Print the command `install` configures |

`sense`, `sense-agents` and `hook <Event>` are internal; Claude Code invokes them.

### Where things live

```
.claude/guardian/
├── config.json                       your settings
├── .gitignore                        contains "*" — this tree never enters a commit
├── agent-stats.json                  historical durations by agent type
├── agent-notes/                      incremental notes agents write for themselves
├── sessions/
│   ├── <session>.json                the gauge: percentages, burn rates, mode
│   ├── <session>.agents.json         live subagents and their token pace
│   └── <session>.ledger.jsonl        append-only observations
├── handoff/
│   ├── latest.json                   the manifest
│   ├── latest.md                     the digest that gets injected
│   └── history/<timestamp>.json      every seal, kept
└── logs/guardian.log                 only written when something failed
```

---

## Troubleshooting

**No Guardian segment in the status line.**
Restart Claude Code — the command is read at startup. Then check
`node dist/guardian.cjs where` matches the `statusLine.command` in
`~/.claude/settings.json`. If your organisation sets `allowManagedHooksOnly` or
`disableAllHooks`, custom status lines are suppressed entirely and Guardian cannot run.

**`guardian: awaiting first API response`.**
Normal at the very start. `context_window` is null until the first response comes back.

**No 5-hour or 7-day bars.**
`rate_limits` appears only for Claude.ai Pro and Max subscribers, and only after the first
API response. Guardian tracks context alone in that case.

**`wall unknown` and `burn —` for a long time.**
Nothing has moved enough to measure. An idle session, or fewer than 45 seconds of samples.
The percentage floors are still guarding.

**Guardian has no state for this project yet.**
The sensor has not run in this directory. Check you are in the project root — Guardian
walks up for `.claude/guardian` or `.git` to find one root, and never treats your home
directory as a project.

**A subagent spawn was refused and I wanted it.**
Guardian is at `LAND` or above. Raise `agents.deny_spawn_from` in
`.claude/guardian/config.json` (to `EMERGENCY`, or `HARD_STOPPED` to disable the gate), or
seal a handoff and continue in a fresh session.

**Agent rows show elapsed time with no median to compare against.**
No agent of that type has completed in this project yet, so there is no history. It appears
after the first one finishes.

**A checkpoint says `status-only`.**
Not a git repository, or git plumbing failed. The manifest still carries file hashes; only
the recoverable commit is missing. `detail` in the manifest says which.

**Something is wrong and I want the log.**
`.claude/guardian/logs/guardian.log`. It is empty unless something threw — every hook
fails open, so failures are silent by design.

---

## What Guardian does not do

Being clear about this saves disappointment.

**It cannot interrupt Claude mid-turn.** Hooks only speak when an event fires, so the
earliest Guardian can inject anything is the next tool call. In practice that is seconds,
but nothing here preempts a running operation.

**It still cannot pause a running subagent.** A subagent's state *is* its context; there is
no external handle on it. What Guardian does instead is refuse *new* spawns near a wall and
make the ones it does allow self-checkpointing from birth. An agent already in flight when
the session dies is still lost — Guardian records that it was running, and nothing more.

**It does not save the conversation.** That is the wrong abstraction. Guardian persists the
*work*: files and their hashes, commits, checkpoints, tasks, tests, and stated intent. A
fresh session rebuilds understanding from those, which is more reliable than trying to
freeze a context window.

**It stops exactly one thing.** New subagent spawns, at `LAND` and above, and only because
a delegation is the one action whose partial results cannot be recovered. Everything else —
edits, reads, searches, shell commands, migrations — passes through untouched at every mode.
Guardian tells you the truth about your budget and makes the aftermath survivable; the rest
of the decisions stay yours.

**It cannot see account usage your plan does not report.** There is exactly one live feed
for rate limits, and if your plan omits it, Guardian says `unknown` rather than guessing.
