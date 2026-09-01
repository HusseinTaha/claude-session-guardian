Yes — this is feasible, and I think the best implementation is a small Claude Code “usage watchdog + handoff orchestrator”, rather than trying to make the MCP itself somehow control Claude's internal session.

The key distinction is:

MCP can expose tools to Claude such as get_usage_status(), prepare_handoff(), save_agent_state(), list_active_agents(), etc.
A watchdog process/hook can independently monitor usage and inject a warning/action into Claude when the threshold is reached.
A persistent state directory can make the work resumable from a completely new Claude session.

Anthropic's own guidance is actually quite aligned with this approach: for long-running agentic work, use structured state, progress files, git checkpoints, and explicitly design for continuation in a fresh context window. 
C
Claude Platform Docs

What I would build

I'd call it something like:

Claude Session Guardian

                  ┌──────────────────────────┐
                  │     Claude Code session   │
                  │                          │
                  │  main agent              │
                  │    ├── subagent A        │
                  │    ├── subagent B        │
                  │    └── subagent C        │
                  └────────────┬─────────────┘
                               │
                               ▼
                    ┌────────────────────┐
                    │ Session Guardian   │
                    │                    │
                    │ /usage monitor     │
                    │ threshold engine   │
                    │ state manager      │
                    └─────────┬──────────┘
                              │
             ┌────────────────┼────────────────┐
             ▼                ▼                ▼
       < 80% normal       80-95% warning      ≥95%
                                             HANDOFF MODE
                                                │
                              ┌─────────────────┼─────────────────┐
                              ▼                 ▼                 ▼
                         stop spawning     finish safe       save state
                         new agents        operations        + checkpoint
                              │                 │                 │
                              └─────────────────┼─────────────────┘
                                                ▼
                                      HANDOFF_MANIFEST.json
                                                │
                                                ▼
                                      New Claude session
                                                │
                                                ▼
                                      resume from state

The important part

I would not wait until 95%.

I'd use multiple stages:

Usage	Guardian behavior
< 80%	Normal operation
80%	Start tracking remaining work more aggressively
85%	Warn Claude about approaching limit
90%	Enter handoff preparation mode
93%	Stop starting expensive/new subagents
95%	Handoff mode
97%+	Emergency checkpoint; minimize further work
100%	Everything possible should already be persisted

This matters because if Claude is currently doing something expensive at 95%, you don't want the system to suddenly discover that it needs to save five agents' state.

One important architectural issue

There are actually two different usages you want to monitor:

1. Context/session usage

Something like:

current session/context
████████████████████░░ 92%


This determines whether the current Claude conversation is approaching its limit.

2. Account/session-period usage

The /usage command may expose things such as:

5-hour session: 82%
weekly: 71%


You want the guardian to track both.

Conceptually:

{
  "session": {
    "used_percent": 92,
    "remaining_percent": 8
  },
  "weekly": {
    "used_percent": 71,
    "remaining_percent": 29
  },
  "mode": "HANDOFF_PREPARATION"
}


The guardian should then use:

effective_usage = max(session_usage, weekly_usage)


for deciding whether to become conservative.

But I'd keep the two values separate because weekly exhaustion and context/session exhaustion have very different consequences.

I would make the MCP expose these tools

Something like:

claude-guardian
│
├── get_usage()
├── get_guardian_status()
│
├── list_active_agents()
├── inspect_agent(agent_id)
│
├── prepare_handoff()
├── checkpoint_current_work()
├── checkpoint_agent(agent_id)
├── checkpoint_all_agents()
│
├── assess_remaining_work()
├── can_finish_safely()
│
├── mark_agent_paused(agent_id)
├── mark_agent_complete(agent_id)
│
├── create_handoff_manifest()
└── resume_from_handoff()


For example, Claude could call:

{
  "tool": "get_usage"
}


and receive:

{
  "session_usage_percent": 94.2,
  "weekly_usage_percent": 67.8,
  "threshold": 95,
  "mode": "WARNING",
  "estimated_remaining_session_capacity": "low"
}


Then:

prepare_handoff()


would tell Claude:

HANDOFF PREPARATION REQUIRED

Session usage: 94.2%

Do not:
- spawn additional subagents
- begin large new tasks
- start operations that cannot be checkpointed

Do:
- inspect all active agents
- determine which can finish safely
- checkpoint completed work
- persist unfinished work
- record exact next steps
- create HANDOFF_MANIFEST.json

But there's an even better approach

I wouldn't rely on MCP alone.

I'd use three layers.

Layer 1 — Guardian daemon

A tiny background process:

claude-guardian daemon


It periodically checks usage.

For example:

every 10 seconds
      │
      ▼
check /usage
      │
      ▼
parse session + weekly usage
      │
      ▼
threshold crossed?
      │
      ├── no → continue
      │
      └── yes
             │
             ▼
       trigger guardian


This is important because an MCP tool generally only gets invoked when Claude decides to invoke it.

You don't want Claude having to remember to ask:

"Hmm, I wonder if my usage is at 95%."

The watchdog should independently know.

Layer 2 — Claude Code hook/injection

When the watchdog detects:

>= 90%


it should cause Claude Code to receive something equivalent to:

[SYSTEM: CLAUDE SESSION GUARDIAN]

Usage threshold reached.

Session usage: 91.4%
Weekly usage: 63.2%

You are entering HANDOFF PREPARATION mode.

Before continuing substantial work:
1. Inspect all active agents.
2. Determine what can safely complete.
3. Do not spawn new agents unless absolutely necessary.
4. Save progress for every unfinished workstream.
5. Commit/checkpoint code where appropriate.
6. Persist agent state.
7. Create/update HANDOFF_MANIFEST.json.
8. Continue only if the current operation can safely finish.


At 95%:

[CRITICAL: SESSION GUARDIAN]

Session usage: 95.1%

STOP STARTING NEW WORK.

Safely wind down current operations.

You MUST:
- pause/terminate delegations that cannot finish safely
- checkpoint every active workstream
- persist exact next actions
- preserve errors and pending decisions
- create a resumable handoff manifest
- leave the repository/workspace in a recoverable state

Do not attempt another large task.

Layer 3 — Persistent state

This is arguably the most important piece.

Don't try to somehow freeze Claude's internal neural/context state.

Instead, make the work itself resumable.

I'd create:

.claude/
└── guardian/
    ├── state.json
    ├── usage.json
    ├── active-agents.json
    ├── handoff/
    │   ├── latest.json
    │   ├── 2026-09-01T09-10-32.json
    │   └── ...
    └── agents/
        ├── agent-001.json
        ├── agent-002.json
        └── agent-003.json


And possibly:

.claude/
├── progress.md
├── tasks.json
├── decisions.md
└── handoff.md


Anthropic specifically recommends structured state, progress notes, git checkpoints, and designing workflows so a fresh context can discover the state and continue. 
C
Claude Platform Docs

The handoff manifest

This is where I'd make the system really good.

At 95%, Claude produces something like:

{
  "handoff_version": 1,
  "created_at": "2026-09-01T09:12:34Z",

  "usage": {
    "session_percent": 95.3,
    "weekly_percent": 72.1
  },

  "project": {
    "working_directory": "/project/foo",
    "git_branch": "feature/new-system",
    "git_commit": "a82f91c"
  },

  "overall_task": "Implement the new authentication system",

  "status": "HANDOFF_REQUIRED",

  "completed": [
    "Database schema",
    "JWT validation",
    "Login endpoint"
  ],

  "in_progress": [
    {
      "task": "Refresh token implementation",
      "status": "60%",
      "files": [
        "src/auth/refresh.ts"
      ],
      "next_action": "Finish token rotation logic and add tests"
    }
  ],

  "blocked": [
    {
      "task": "Integration tests",
      "reason": "Test database container unavailable"
    }
  ],

  "agents": [
    {
      "id": "agent-001",
      "task": "Refresh token implementation",
      "status": "PAUSED",
      "state_file": ".claude/guardian/agents/agent-001.json",
      "resume_instruction": "Continue refresh token rotation"
    }
  ],

  "next_session_instructions": [
    "Read this manifest",
    "Read progress.md",
    "Check git status",
    "Inspect unfinished tasks",
    "Resume agent-001",
    "Run authentication tests before modifying other components"
  ]
}


Then the new Claude session doesn't have to remember anything.

It reads:

.claude/guardian/handoff/latest.json


and continues.

Agent handling is the tricky part

I'd divide agents into three categories.

A — Safe to finish

Example:

Agent A:
running unit tests
estimated remaining: 30 sec


Let it finish.

B — Safe to checkpoint and pause

Example:

Agent B:
implementing API endpoint
estimated remaining: 8 minutes


Don't let it continue consuming the remaining session budget.

Checkpoint:

state → agent-B.json
status → PAUSED

C — Dangerous to interrupt

Example:

Agent C:
database migration currently executing


Don't blindly kill it.

Instead:

WAIT_FOR_SAFE_BOUNDARY


The guardian should tell Claude:

Allow this operation to reach a safe boundary, then checkpoint.

That's why I would not build a dumb "kill all agents at 95%" switch.

It needs a state machine.

State machine

Something like:

NORMAL
  │
  │ usage >= 80%
  ▼
WATCH
  │
  │ usage >= 90%
  ▼
PREPARE_HANDOFF
  │
  ├── current operation safe?
  │       │
  │       ├── yes → finish
  │       └── no  → checkpoint
  │
  ▼
DRAINING
  │
  ├── active agents
  │      ├── complete → record
  │      ├── safe → finish
  │      └── unsafe → pause/checkpoint
  │
  ▼
HANDOFF_READY
  │
  ▼
NEW_SESSION
  │
  ▼
RESTORE
  │
  ▼
NORMAL


That is much safer than:

95% → kill everything

I would also add "estimated time remaining"

This is where your idea becomes substantially better.

Suppose:

Usage: 91%

Active agents:

Agent A
estimated completion: 2 min

Agent B
estimated completion: 18 min

Agent C
estimated completion: 45 sec


The guardian can tell Claude:

SAFE TO CONTINUE:

A: 2 min
C: 45 sec

NOT SAFE:

B: 18 min

Recommendation:
Allow A and C to finish.
Checkpoint/pause B.


At 95%:

Agent A: 20 sec → FINISH
Agent B: 12 min → PAUSE
Agent C: 5 min → PAUSE


This is much closer to what you're describing.

One thing I'd change in your original idea

Don't phrase the instruction as:

"pause agents when usage hits 95%."

Instead:

"At 90%, begin evaluating whether work can safely complete before the session budget is exhausted. At 95%, enter mandatory handoff mode and prevent initiation of non-essential work."

That distinction is important.

Because usage percentage alone doesn't tell you how much actual useful work can still happen.

MCP vs patch

I'd build it as:

MVP
Claude Code
     │
     ├── MCP server
     │     ├── usage
     │     ├── agents
     │     ├── checkpoint
     │     └── handoff
     │
     └── Guardian daemon
           │
           └── usage monitor

Don't start by modifying Claude itself

A patch to Claude Code could work, but it's likely to be fragile because Claude Code internals can change.

An external guardian gives you:

version independence
easier debugging
no modification of Claude binaries
ability to use it with multiple Claude Code versions
easier state persistence
easier emergency recovery

MCP is well suited to exposing the guardian's capabilities to Claude; Anthropic supports MCP servers as tool providers. 
C
Claude Platform Docs

And I'd add one killer feature
guardian_status

Claude should be able to call:

guardian_status()


and receive:

╔══════════════════════════════════════╗
║       CLAUDE SESSION GUARDIAN        ║
╠══════════════════════════════════════╣
║ Session:        91.7%                ║
║ Weekly:         63.4%                ║
║ Mode:           PREPARE_HANDOFF      ║
║                                      ║
║ Active agents:  3                   ║
║ Safe to finish: 1                   ║
║ Must checkpoint: 2                   ║
║                                      ║
║ Handoff state: 72% complete          ║
╚══════════════════════════════════════╝


Then Claude can reason about its own situation instead of blindly working until it gets cut off.

What I'd build for you

If you want to actually implement this, I would make it a Python/TypeScript MCP + local watchdog, with:

/usage parser
session + weekly usage tracking
configurable thresholds
automatic 80/90/95/97% state transitions
active-agent discovery
agent state files
safe-boundary detection
automatic checkpointing
HANDOFF_MANIFEST.json
Claude Code startup/resume instructions
git checkpoint integration
protection against spawning new agents during handoff
emergency mode at ~97%
logging/dashboard
a resume command that tells the new Claude session exactly what to do

And importantly, I'd make the handoff protocol generic, so it isn't just about Claude's usage. It would essentially create a durable "save game" for an autonomous coding session.

If you want, I can next lay out the actual project architecture + MCP tool schemas + watchdog implementation + Claude Code hook/config files, so you could hand the specification directly to Claude and have Claude build the Guardian itself.


Yes. In that case, I would not make the primary interface an MCP server.

What you're describing is much closer to a Claude Code plugin/skill/command distributed as an npm package, where the user installs it once and then invokes something like:

/guardian


inside any Claude Code project — similar to /loop, /design, /graft, etc.

The important part is that /guardian itself can start a local background monitor and establish the handoff protocol for that Claude session.

The experience I'd target

Install globally:

npm install -g claude-session-guardian


Then inside any project:

/guardian


Claude responds something like:

🛡 Claude Session Guardian enabled

Session usage: 72%
Weekly usage: 41%

Monitoring:
  ✓ Session usage
  ✓ Weekly usage
  ✓ Active subagents
  ✓ Long-running operations
  ✓ Handoff state

Thresholds:
  80%  → Watch
  90%  → Prepare handoff
  95%  → Handoff mode
  97%  → Emergency checkpoint

State:
  .claude/guardian/

Guardian will remain active for this Claude session.


Then you simply continue working:

You:
implement the payment system

Claude:
I'll delegate this to three agents...


Guardian runs in the background.

At 89%:

🟡 GUARDIAN WARNING

Session usage: 89%

Begin preparing for handoff.

Active agents:
  agent-1  payment API       ~4 min
  agent-2  frontend          ~2 min
  agent-3  tests              ~8 min

Recommendation:
  ✓ Allow agent-2 to finish
  ✓ Allow agent-1 to reach safe checkpoint
  ⚠ Pause/checkpoint agent-3


At 95%:

🔴 GUARDIAN HANDOFF MODE

Session usage: 95.2%

DO NOT START NEW WORK.

Preparing handoff...

✓ Agent 1 checkpointed
✓ Agent 2 completed
✓ Agent 3 paused
✓ Git state recorded
✓ Task state saved
✓ Handoff manifest created

Handoff ready:

.claude/guardian/handoff/latest.json


Then your next Claude session can run:

/guardian resume


and Claude gets:

🛡 Resuming previous session

Previous session:
  Usage: 95.2%
  Status: HANDOFF_READY

Recovered:
  ✓ 2 completed agents
  ✓ 1 paused agent
  ✓ 14 modified files
  ✓ 7 completed tasks
  ✓ 3 pending tasks

Next action:
  Resume agent-3
  Continue payment integration tests

The npm project

I'd structure it roughly like this:

claude-session-guardian/
│
├── package.json
├── README.md
├── LICENSE
│
├── bin/
│   └── guardian.js
│
├── src/
│   ├── cli.ts
│   ├── guardian.ts
│   ├── monitor.ts
│   ├── usage.ts
│   ├── thresholds.ts
│   │
│   ├── handoff/
│   │   ├── manager.ts
│   │   ├── manifest.ts
│   │   ├── checkpoint.ts
│   │   └── restore.ts
│   │
│   ├── agents/
│   │   ├── discovery.ts
│   │   ├── inspector.ts
│   │   └── state.ts
│   │
│   └── claude/
│       ├── commands.ts
│       ├── hooks.ts
│       └── instructions.ts
│
├── commands/
│   ├── guardian.md
│   ├── guardian-resume.md
│   └── guardian-status.md
│
└── templates/
    ├── handoff.md
    ├── progress.md
    └── agent-state.json


But there's an important question here:

How does /guardian actually become a Claude Code command?

We should design around Claude Code's current extension mechanism, rather than inventing our own command format.

There are a few possibilities:

npm package
     │
     ├── Claude Code plugin
     │       └── /guardian
     │
     ├── hooks
     │       └── automatic monitoring
     │
     └── optional MCP
             └── tools available to Claude


That's actually the architecture I'd recommend.

/guardian should be the command

I'd give it subcommands:

/guardian
/guardian status
/guardian start
/guardian stop
/guardian pause
/guardian resume
/guardian handoff


But the normal user only needs:

/guardian


and:

/guardian resume


Everything else is there for control/debugging.

The really important distinction

There are two processes.

Claude-facing component
/guardian


This establishes the instructions and configuration inside Claude.

External guardian process
claude-session-guardian monitor


This actually watches the usage.

So:

                     Claude Code
                         │
                         │ /guardian
                         ▼
              ┌─────────────────────┐
              │ Guardian Command    │
              │                     │
              │ instructions        │
              │ configuration       │
              │ state initialization│
              └──────────┬──────────┘
                         │
                         │ starts
                         ▼
              ┌─────────────────────┐
              │ Guardian Monitor    │
              │                     │
              │ poll usage          │
              │ detect thresholds    │
              │ monitor state        │
              │ trigger handoff      │
              └──────────┬──────────┘
                         │
                         ▼
                    Claude Code
                         │
                    handoff signal
                         │
                         ▼
                Claude executes
                handoff protocol


This is much closer to what you're imagining.

I'd also make it project-local

When you run:

/guardian


it creates:

.claude/
└── guardian/
    ├── config.json
    ├── state.json
    ├── usage.json
    ├── progress.md
    │
    ├── agents/
    │   ├── agent-001.json
    │   ├── agent-002.json
    │   └── agent-003.json
    │
    └── handoff/
        ├── latest.json
        └── history/


That means you can have:

~/projects/project-a/.claude/guardian/
~/projects/project-b/.claude/guardian/
~/projects/project-c/.claude/guardian/


and each project has independent state.

Configuration

I'd make this configurable in:

.claude/guardian/config.json


For example:

{
  "enabled": true,

  "thresholds": {
    "watch": 80,
    "prepare": 90,
    "handoff": 95,
    "emergency": 97
  },

  "agentPolicy": {
    "stopSpawningAt": 93,
    "pauseAt": 95,
    "allowSafeCompletion": true
  },

  "checkpoint": {
    "git": true,
    "writeState": true,
    "writeManifest": true
  }
}


Then you could customize it per project.

And I'd make /guardian intelligent

The command shouldn't just say:

Usage is 95%, save your work.

It should establish a persistent operating instruction for Claude.

Something along the lines of:

You are operating under Claude Session Guardian.

Your current session has a finite usage budget.

When guardian status enters WATCH:
- estimate remaining work
- track active agents
- maintain progress state

When guardian status enters PREPARE_HANDOFF:
- stop initiating unnecessary work
- evaluate all active agents
- allow short safe operations to finish
- checkpoint long-running work
- update progress state

When guardian status enters HANDOFF:
- do not start new tasks
- do not spawn new agents
- bring current operations to safe boundaries
- checkpoint unfinished work
- persist all agent state
- write the handoff manifest
- leave the repository in a resumable state

Never sacrifice repository consistency merely to save context.


That becomes the Guardian protocol.

/guardian resume is equally important

This is where the system becomes genuinely useful.

New Claude:

/guardian resume


Guardian finds:

.claude/guardian/handoff/latest.json


and gives Claude a deterministic recovery procedure:

RECOVERY PROTOCOL

1. Read handoff manifest.
2. Read progress.md.
3. Inspect git status.
4. Verify checkpoint.
5. Inspect paused agents.
6. Determine whether their work exists on disk.
7. Resume the highest-priority incomplete task.
8. Do not redo completed work.
9. Update guardian state.


So you're effectively creating:

save/load functionality for Claude Code sessions.

That's the core idea I think you're after.

One thing I would NOT do

I wouldn't try to save the actual Claude conversation/context.

That's fundamentally the wrong abstraction.

Instead:

Claude context
     ↓
ephemeral

Project state
     ↓
persistent

Agent state
     ↓
persistent

Task state
     ↓
persistent

Git state
     ↓
persistent

Handoff manifest
     ↓
persistent


Then a new Claude instance reconstructs the important context from those durable artifacts.

Optional MCP

We can still include MCP, but as a secondary component:

/guardian
     │
     ├── Guardian hooks
     ├── Guardian daemon
     ├── state manager
     │
     └── Guardian MCP
            ├── get_usage()
            ├── get_status()
            ├── checkpoint()
            ├── list_agents()
            ├── prepare_handoff()
            └── restore()


That gives Claude explicit tools for asking:

guardian.get_status()


rather than relying entirely on injected instructions.

The final user experience

Ultimately, I'd want it to feel this simple:

npm install -g claude-session-guardian


Inside your project:

/guardian


Work normally.

Guardian:

80% → watching
90% → preparing
95% → handoff
97% → emergency checkpoint


New session:

/guardian resume


Continue.

One caveat: before we write the package, I'd verify the current Claude Code plugin/skill/hook API as of September 2026, because that's the part that determines exactly how /guardian gets registered and how the monitor can communicate back into the running Claude session. I can look up the current official Claude Code extension mechanism and then design the npm package around the actual API rather than an assumed one.