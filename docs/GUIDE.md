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
- [When Guardian speaks](#when-guardian-speaks)
- [When a rate limit hits anyway](#when-a-rate-limit-hits-anyway)
- [Configuration](#configuration)
- [Command reference](#command-reference)
- [Checking that it works](#checking-that-it-works)
- [Troubleshooting](#troubleshooting)
- [What Guardian does not do](#what-guardian-does-not-do)
- [How the code is arranged](#how-the-code-is-arranged)

---

## Install

Guardian is two halves, and a full install wants both.

| Half | Gives you | Installed by |
|---|---|---|
| the binary | the gauge, the state, every CLI command | `npm install -g .` |
| the plugin | the hooks that act on that state, the `guardian-protocol` skill, `/guardian` | `claude plugin install` |

```bash
git clone <this repo> && cd claude-session-guardian
npm install
npm run build

npm install -g .            # puts `claude-guardian` on PATH, everywhere
claude-guardian install     # wires the status line into ~/.claude/settings.json

claude plugin marketplace add .
claude plugin install claude-session-guardian@claude-session-guardian
```

Then **restart Claude Code**. Both the status line command and the plugin are read at
startup, so a running session will not pick either up.

```
$ claude-guardian install
Guardian installed.
  settings: C:\Users\you\.claude\settings.json
  command:  node "C:/path/to/dist/guardian.cjs" sense
  chained your existing status line: node "C:\...\mcp-claude-sharedctx\dist\cli.js" statusline

Restart Claude Code — the status line command is read at startup.
```

Note the third line. If you already had a status line, Guardian **keeps** it: it runs your
command on every tick and appends its own segment. Nothing you had is lost.

```
🐝 hive · c3804 · 0f/0d  🛡 LAND ctx ▓▓▓▓▓░░░░░ 53% ⚠ ~21m  5h ▓▓▓▓▓▓▓▓▓░ 89% ⚠ ~3m
└──────── the status line you had ─────────┘└──────── Guardian's segment ────────┘
```

**Skipping the plugin is the common mistake.** Without its hooks nothing acts on its own:
no seal before compaction, no spawn gate near a wall, no Stop brake, no 429 recovery. You
get a gauge that tells you the truth and then lets you drive into the wall anyway.

### Per project: usually nothing, sometimes `init`

Most projects need no setup at all. The sensor resolves the project root itself, creates
`.claude/guardian/` on the first tick with a `.gitignore` that ignores the whole directory,
and falls back to the built-in defaults when there is no `config.json`. Open a project and
work.

The exception is a project that defines its own `statusLine` in `.claude/settings.json`.
That replaces the user-level one outright — settings are layered, and a status line is a
single value, not a merge — so Guardian's sensor never runs there. Everything else looks
installed: the hooks fire, `/guardian` answers, and the state they read is empty. Nothing
warns you and nothing lands.

```
$ claude-guardian init
Guardian initialised for C:\Dev\Misc\claude-guardian
  settings: C:\Dev\Misc\claude-guardian\.claude\settings.local.json
            this project only, overriding C:\Dev\Misc\claude-guardian\.claude\settings.json
            (settings.local.json is personal, so no absolute path reaches the repo)
  state:    C:\Dev\Misc\claude-guardian\.claude\guardian (ignores itself)
  kept the status line that was there, and runs it first:
    node "C:\...\mcp-claude-sharedctx\dist\cli.js" statusline --with "node \"${CLAUDE_PROJECT_DIR:-.}/...\""
```

`init` finds whichever settings layer actually decides the status line and takes it over
from `settings.local.json` — never from the shared `.claude/settings.json`, because
Guardian's command is an absolute path to one machine's bundle and has no business in a
file the repo commits. Whatever was there is kept and runs first, variables and all:
`${CLAUDE_PROJECT_DIR}`, `${VAR:-default}` and `$VAR` are expanded the way Claude Code
would have expanded them, which `cmd.exe` cannot do on its own.

Run it from anywhere inside the project, or as `/guardian init`. It is idempotent, and
`claude-guardian uninstall` undoes whichever layer it wrote.

To remove everything:

```bash
claude-guardian uninstall            # restores your old status line, deletes checkpoint refs
claude plugin uninstall claude-session-guardian
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

### The colours

Each gauge is coloured on its own: green while that axis is calm, amber at `WATCH`, bold
amber at `PREPARE`, red at `LAND`, inverted red at `EMERGENCY`. The shield takes the colour
of the worst axis, which is the session mode.

| Colour | The axis is |
|---|---|
| green | not heading for a wall — no deadline, or one further out than `thresholds_minutes.watch` |
| amber | inside the watch horizon |
| bold amber | inside the prepare horizon |
| red | at or inside the landing horizon |
| inverted red | minutes, or already stopped |

The colour tracks the axis's **mode**, not its percentage — so the `5h ▓▓▓▓▓▓▓▓▓░ 94%`
above is green, because a window that refills faster than you burn it is not a problem at
any percentage. Colouring the number by the number would contradict the one thing this
tool exists to tell you. `render.color: false` turns all of it off.

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

## When Guardian speaks

Guardian is silent below `PREPARE`. The status line is there for anyone looking; injecting
text into the conversation costs the budget it exists to protect. Above that, what it says
grows with severity and nothing more.

**At PREPARE** — one line, about forty tokens:

```
[Guardian: PREPARE — 5-hour: 83% used, ~12m to wall, resets in 3.6h] Do not begin
work that cannot reach a reportable state in that window. Prefer finishing what is
open.
```

**At LAND** — the landing protocol, about two hundred tokens:

```
[Guardian: LAND — 5-hour: 96% used, ~4m to wall, resets in 3.6h]

Land the work. In this order:
1. Bring the current operation to a stopping point. Do not start another.
2. Record what cannot be observed from the files:
   `claude-guardian note --next "<the single most specific next step>"`
   Add `--gotcha` or `--decision` for anything a fresh session would get wrong.
3. Seal it: `/guardian handoff`.

Guardian already has the files, commands, commits, tasks and tests. What it cannot
see is intent, so the note is the part that matters. New subagents are blocked;
do small remaining work inline.
```

**At EMERGENCY** — two commands and a full stop.

The deeper checklist lives in a `guardian-protocol` skill, which loads only when it is
needed rather than sitting in every prompt.

### The Stop brake

If the session tries to end at `LAND` or above with **no handoff sealed**, Guardian refuses
the turn-end once and asks for exactly one thing:

```
Session Guardian is in LAND (5-hour: 96% used, ~4m to wall) and no handoff has been
sealed. Before stopping, do exactly this and nothing more: record the next action
with `claude-guardian note --next "..."`, then run `claude-guardian handoff
--reason "LAND"`. Then stop.
```

**It fires at most once per session.** A `Stop` hook that can fire twice is a loop, and a
loop there would be worse than having no hook at all, so the latch is written to disk before
the refusal is returned. The test suite hammers it ten times in a row to prove it.

Turn it off with:

```
/guardian config set landing.force_seal_turn false
```

There is also a hard brake that halts the agentic loop at `EMERGENCY` once a handoff is
sealed. It is **off by default** — an unexpected halt is worse than the problem for most
people:

```
/guardian config set landing.halt_loop_at_emergency true
```

---

## When a rate limit hits anyway

Sometimes the wall arrives faster than any warning. Guardian handles the aftermath.

The moment a turn ends in a 429, Guardian reads the `quotaLimits` record the transcript
leaves behind — which carries the exact reset timestamp no live gauge can supply after the
fact — seals a handoff, and switches to `HARD_STOPPED`.

Your next prompt gets:

```
[Guardian: HARD_STOPPED] A rate limit (five_hour) refused a request. The window
reopens at 2026-09-01 12:30 UTC — nothing will succeed before then. A handoff has
been sealed; run `/guardian wait` for a countdown, and `/guardian resume` once the
window reopens. Do not retry in the meantime.
```

```
$ /guardian wait
Rate limit: five_hour
Refused at: 2026-09-01 11:00:00.000Z
Reopens at: 2026-09-01 12:30:00.000Z
Status:     80m until the window reopens

The work is sealed. Run /guardian resume once the window reopens.
```

The point of `Do not retry` is that a retry cannot succeed, and each attempt spends a turn
finding that out.

## Configuration

Everything is configurable from the `/guardian` command. Nothing needs hand-editing.

```
/guardian config                              list every setting, its value, and what it does
/guardian config set thresholds_minutes.land 8
/guardian config set agents.deny_spawn_from EMERGENCY
/guardian config set thresholds_minutes.prepare 20 thresholds_minutes.land 10
/guardian config get thresholds_minutes.land
/guardian config unset thresholds_minutes.land      back to the default
/guardian config reset                              remove all overrides
/guardian config check                              validate the current file
/guardian off                                       silent, but still installed
/guardian on
```

The listing marks what you have changed:

```
$ /guardian config

Guardian settings for C:\proj
  file: C:\proj\.claude\guardian\config.json

  enabled                              true             master switch; false makes Guardian silent
  thresholds_minutes.watch             30               minutes-to-wall at which the bar turns amber
  thresholds_minutes.prepare           12               minutes-to-wall at which to stop starting new work
  thresholds_minutes.land              8          set   minutes-to-wall at which spawns are denied
  thresholds_minutes.emergency         1.5              minutes-to-wall treated as the wall being here
  ...
```

`set` validates before writing, and refuses anything that would not work:

```
$ /guardian config set thresholds_minutes.land 40
error: thresholds_minutes.land — must be <= thresholds_minutes.prepare (12); otherwise
PREPARE can never be reached before LAND

Nothing was written.

$ /guardian config set render.color banana
error: render.color — must be true or false

$ /guardian config set thresholds_minute.land 5
error: thresholds_minute.land — unknown setting "thresholds_minute.land"
```

That last one is the reason to use the CLI rather than the file: a typo'd key in
`config.json` is silently ignored, and you would never know your setting had no effect.

You can also just describe what you want — "warn me earlier", "stop blocking my subagents",
"turn off the colours" — and Claude will map it to the right setting.

### The command menu

Type `/guardian` and the palette lists every Guardian command. Arrow between them, press
Enter, then keep typing the arguments:

```
/guardian              Session Guardian - usage status, handoff, resume, and configuration
/guardian-status       how much session budget is left, and how long until the wall
/guardian-config       list settings, or change one (thresholds, agent gate, colours)
/guardian-handoff      seal a resumable handoff of this session's work right now
/guardian-resume       load the last sealed handoff and verify the workspace against it
/guardian-wait         when does the rate-limit window reopen after a 429
/guardian-agents       live subagents, their context use, and typical run times
```

Each shows its expected arguments once selected, so `/guardian-config` displays
`[set <setting> <value> | get <setting> | unset <setting> | reset | check]`.

One honest limitation: Claude Code has no arrow-navigable picker for *argument* values —
`argument-hint` is a display hint, not a menu. The navigable list is the command list, which
is why each subcommand is its own entry rather than an argument to one command. Everything
still works as an argument too, so `/guardian config set ...` and `/guardian-config set ...`
are equivalent.

### The file

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
    "window_min": 15,
    "min_span_s": 45,
    "alpha": 0.35,
    "max_samples": 60,
    "reset_margin_min": 1,
    "min_samples": 3
  },

  "landing": {
    "inject_from": "PREPARE",
    "force_seal_turn": true,
    "halt_loop_at_emergency": false
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
| `burn.window_min` | Longer is steadier, slower to notice a sudden fan-out. 15 is calibrated, not guessed — see below. |
| `burn.alpha` | Higher reacts faster and is twitchier. |
| `burn.max_samples` | How many readings the state file carries. It also sets how far apart they sit: the window is always covered, so a smaller budget just means coarser spacing. |
| `burn.reset_margin_min` | Slack required before a refilling window counts as safe. Raise it if you distrust the estimate. |
| `burn.min_samples` | Readings required before a rate is believed. Two points can lie — one anomalous percentage would otherwise imply an absurd rate. |
| `agents.deny_spawn_from` | Mode at which new subagents are refused. `HARD_STOPPED` disables the gate. |
| `agents.inject_checkpoint_prompt_from` | Mode at which spawned agents get the self-checkpointing note. |
| `safe_boundary_commands` | Irreversible work to record as possibly-interrupted. Never blocked. |
| `landing.inject_from` | Mode at which Guardian starts injecting a brief. `LAND` for a quieter tool. |
| `landing.force_seal_turn` | Whether the `Stop` hook refuses one turn-end to force a seal. |
| `landing.halt_loop_at_emergency` | Hard brake on the agentic loop at `EMERGENCY`. Off by default. |
| `render.color` | Set `false` for a terminal that mangles ANSI. |
| `enabled` | `false` makes Guardian completely silent while leaving it installed. |

### Where the burn defaults come from

`window_min` and `alpha` are not taste. `scripts/calibrate.ts` replays every transcript in
`~/.claude/projects` through the real estimator and scores the burn it predicted against
the burn that actually followed five minutes later:

```bash
node --experimental-strip-types scripts/calibrate.ts
node --experimental-strip-types scripts/calibrate.ts --windows 10,15,20 --samples 60,240
```

Across 43 sessions and 1,046 hours, `window_min: 15` with the shipped 60-sample budget
scored the lowest median relative error (0.41, against 0.46 at a 10-minute window) at both
the idle and the busy status-line cadence, which is why those are the defaults. Raising
`max_samples` to buy finer spacing measured *worse* in the tail — the extra readings are
mostly the rounding in the reported percentage.

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
| `/guardian wait` | Countdown to a rate-limit window reopening |
| `/guardian config [get\|set\|unset\|reset\|check\|path]` | Read and change settings, validated |
| `/guardian doctor [--cold] [--seal] [--strict]` | Could a fresh session resume this work? |
| `/guardian log [--lines N]` | Tail Guardian's own log |
| `/guardian on` / `off` | Enable or disable Guardian for this project |
| `claude-guardian agents` | Live subagents, plus historical duration by agent type |
| `claude-guardian checkpoints` | List git checkpoint refs |
| `claude-guardian where` | Print the command `install` configures |

`sense`, `sense-agents`, `hook <Event>` and `mcp` are internal; Claude Code invokes them.

### Optional MCP server

Guardian works fully without it — the hooks cover the workflow. The server exists so
Claude can ask about the budget *on purpose* rather than wait to be told, and it ships
**off**. To enable it, copy the block from `mcp/guardian.mcp.json` into your own
`.mcp.json`, replacing the path:

```json
{
  "mcpServers": {
    "guardian": {
      "command": "node",
      "args": ["/path/to/claude-session-guardian/dist/guardian.cjs", "mcp"]
    }
  }
}
```

It exposes exactly three tools: `guardian_status`, `guardian_checkpoint` and
`guardian_resume_context`. Three, not fourteen, because every tool schema is resident
context in every request — a large MCP surface would spend budget on every turn, which is
self-defeating in a tool whose whole purpose is conserving it.

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

## Checking that it works

A handoff system nobody has tested is a handoff system that does not work, and the failure
mode is silence — you discover it at the worst possible moment.

```
/guardian doctor
```

Free, instant, and answers one question: **if this session died right now, could a fresh one
continue?**

```
Guardian self-check
  project: C:\proj

  [ok  ] status line    points at Guardian
  [ok  ] agent rows     per-agent sensing is wired
  [ok  ] enabled        Guardian is active for this project
  [ok  ] config         valid
  [ok  ] sensor         21 sample(s), last updated just now
  [ok  ] rate limits    account usage is being reported
  [ok  ] burn rate      measurable, so time-to-wall is real
  [ok  ] handoff        sealed 2m ago — PreCompact (auto)
  [FAIL] next action    absent — the resuming session has to guess where to start
                       → claude-guardian note --next "<the single most specific next step>"
  [warn] objective      absent; the resuming session knows the steps but not the goal
  [ok  ] files          14 tracked, 14 verifiable by hash
  [ok  ] workspace      matches the sealed manifest
  [ok  ] test baseline  `npm test` — passing
  [ok  ] checkpoint     refs/guardian/s1/2026-09-01T09-12-34-000Z (`git show 2c9d9f7a`)
  [ok  ] digest         the injectable summary exists

NOT RESUMABLE — 1 problem(s) would stop a fresh session from continuing this work.
```

Every `FAIL` line carries the command that fixes it. A missing next action is a **failure**,
not a warning, because it is the one field nothing else substitutes for.

`doctor` also catches the quieter problems:

| Line | What it means |
|---|---|
| `checkpoint ... no longer exists` | The ref was deleted. Uncommitted work at seal time is gone. |
| `workspace 3 file(s) changed` | Someone edited outside the handoff. Reconcile on resume. |
| `in flight` | An irreversible operation started and was never seen to return. |
| `agents ... still running at seal time` | Their work is lost; they are recorded, not resumable. |
| `test baseline FAILING at seal time` | You are resuming onto a red build. Say so, don't hide it. |

Useful flags: `--seal` seals a fresh handoff first; `--strict` exits nonzero, for a hook or
CI; `--keep` leaves the cold-resume worktree in place.

### Testing the parachute for real

The static audit checks that the manifest has the right *shape*. It cannot tell you whether
the words in it are any good. For that:

```
/guardian doctor --cold
```

This builds a scratch git worktree at the checkpoint, drops in only the handoff digest,
and runs a **fresh `claude -p` that has never seen this session** — asking it what the next
action is, which files it would touch, and what it cannot determine.

```
  [ok  ] cold resume    a cold session read the handoff and answered
  [ok  ] next action    the cold session restated the recorded next action
  [warn] files          it named none of the files the manifest records

--- what the cold session said ---
The next action is to finish rotateRefreshToken() in the auth module — the happy
path is done and the reuse-detection branch is unwritten. I cannot determine which
test command to run, or whether the token store schema was already migrated.
--- end ---

Those two checks are keyword overlap, not comprehension. Read the answer: if a
model with no memory of this work could not say what to do next, neither could you
tomorrow, and the manifest needs a better `note --next`.
```

Two things to be clear about. It **spends real budget** — it is a full model call, so it is
opt-in and not something to run near a wall. And the two mechanical checks are keyword
overlap, nothing more; Guardian does not claim to grade the answer's meaning. The value is
in reading what a cold reader actually concluded, which tells you more about your manifest
than any score would.

The gap that shows up most often is a vague next action:

- `"Continue working on auth"` — the cold session says it cannot determine where to start.
- `"Finish rotateRefreshToken() in src/auth/refresh.ts:88 — happy path works, the
  reuse-detection branch is unwritten. Then run npm test -- auth."` — it starts immediately.

### The log

```
/guardian log
```

Empty is the healthy state: every hook fails open silently, so anything in here is something
that went wrong and was swallowed rather than allowed to break the session.

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

**Guardian will not let the turn end.**
It is at `LAND` or above with no handoff sealed, and it asks once. Record a next action and
run `/guardian handoff`, or disable it with
`/guardian config set landing.force_seal_turn false`.

**Guardian is talking too much.**
`/guardian config set landing.inject_from LAND` limits it to the landing protocol, or
`/guardian off` silences it entirely while leaving it installed.

**Something is wrong and I want the log.**
`/guardian log`, or `.claude/guardian/logs/guardian.log`. It is empty unless something threw
— every hook fails open, so failures are silent by design.

**I want to know whether any of this actually works.**
`/guardian doctor`. It is free and instant. `/guardian doctor --cold` goes further and
cold-resumes the handoff with a fresh model, at the cost of a real model call.

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

**It stops two things, both narrowly.** New subagent spawns at `LAND` and above, because a
delegation is the one action whose partial results cannot be recovered; and one turn-end,
once per session, when nothing has been sealed. Everything else — edits, reads, searches,
shell commands, migrations — passes through untouched at every mode. Both brakes are
switchable, and the message always names the setting that lifts them.

**It cannot predict a sudden 429.** If a limit is consumed faster than the burn rate implies
— another session on the same account, a fan-out landing all at once — the wall can arrive
with no warning. Guardian handles the aftermath (seal, `HARD_STOPPED`, reset countdown) but
makes no claim to have seen it coming.

**It cannot see account usage your plan does not report.** There is exactly one live feed
for rate limits, and if your plan omits it, Guardian says `unknown` rather than guessing.

**It does not grade your handoff's prose.** `doctor --cold` shows you what a cold reader
concluded and checks two things mechanically — whether it echoed the next action, whether it
named a recorded file. Judging whether the manifest is *good* is left to you, because a
keyword score dressed up as comprehension would be worse than no score.

---

## How the code is arranged

Only relevant if you are changing Guardian rather than using it.

The folders under `src/` are the architecture rather than a filing convention, and imports
only ever point downward. `npm run layers` fails the build if that stops being true, so the
claim cannot quietly rot.

| Layer | Holds | Depends on |
|---|---|---|
| `core/` | paths, config, state, sessions, log | nothing but types |
| `budget/` | burn-rate estimation, the mode ladder | `core` |
| `format/` | status bar and dashboard rendering | `budget` |
| `handoff/` | ledger, manifest, git checkpoints, redaction | `core`, `budget` |
| `sensors/` | statusLine and subagentStatusLine sensors | everything below |
| `actuators/` | hook dispatch, spawn gate, landing | everything below |
| `ui/` | install, config command, doctor, MCP | everything below |

`types.ts` and `cli.ts` sit at the top level: one is imported by everything, the other is
the bundle entry point and is exempt from the layer rule because wiring is its job.

The direction encodes the central design idea. **Sensors write, actuators read.** A sensor
recomputes burn rates and writes a small `state.json`; an actuator does one `readFileSync`
of that file and decides. Nothing polls, and no analysis sits on a blocking path — which is
what keeps the synchronous spawn gate cheap enough to run on every delegation.

Adding a feature means asking which layer it belongs to. If the answer is "it needs to
import upward", the dependency is inverted and the check will say so.

```bash
npm run check      # typecheck + layers + build + tests
npm run layers     # just the architecture check
npm test           # 196 tests
```

`GUARDIAN_NOW=<epoch>` replays a session at its original timestamps, which is how the mode
ladder is demonstrated and how `doctor --cold` reproduces a handoff.
