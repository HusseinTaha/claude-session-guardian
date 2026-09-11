- Shared memory: bootstrap with `ctx_get(role=<yours>)` before exploring; pass `since=<last CURSOR>` on later calls; `ctx_commit` compact results before finishing.

# claude-guardian

A watchdog for Claude Code sessions. `graft/` indexes this repo — read AGENTS.md and query
the graph before grepping.

## Rules that are not obvious from the code

**Fail open, always.** A watchdog that breaks the session it watches is worse than none.
Every path exits 0 with usable output — malformed payloads, corrupt state, an unwritable
state directory, a missing config. The suite asserts this; do not add a path that throws.

**Sensors write, actuators read.** The `statusLine` sensor computes mode and writes
`state.json`; hooks only read it. Analysis never goes on a blocking path. `npm run layers`
enforces the direction of imports.

**The hot path is measured.** `sense()` runs on every session event: p50 ~2.4ms. Run
`npm run perf` after touching it. No git calls, no network, no directory walks there.

**Windows first.** Forward slashes in configured commands — backslashes are consumed as
escapes before the script runs. `cmd.exe` is the shell for anything spawned with
`shell: true`, so it understands neither `${VAR}` nor `${VAR:-default}`; expand them first.

**Percentages are not the signal, time-to-wall is.** 94% of a window that refills faster
than you burn it is safe. Anything that colours, sorts, or warns by percentage alone
contradicts the premise of the tool.

**Settings layer, a status line does not.** A project's `statusLine` replaces the user's
outright. Anything reasoning about "is Guardian wired here" must walk `settingsChain()`,
not read the user file — that mistake made `doctor` report a confident false pass.

**Never write Guardian's command into a shared settings file.** It carries an absolute path
to one machine's bundle. `init` overrides from `settings.local.json` instead.

**The plugin ships `build/plugin`, not the repo — and that directory is committed.** A
marketplace source pointed at a working directory installs everything in it, `.mcp.json`
included, and Claude Code enables what it finds, so the manifest points at a staged tree
instead. But the marketplace root is this repo, which means a clone without that tree cannot
install the plugin at all, and nothing says so: `marketplace add` succeeds, because
validation reads `marketplace.json` and never checks that its source resolves, and only
`plugin install` fails, with `Source path does not exist`. It shipped that way for four
versions and was found by installing the published repo rather than reading it. So the
staged payload is tracked, `/dist/` is root-scoped because a bare `dist/` matches at every
depth and was silently ignoring the copy inside it, and `npm run check` restages — drift is a
dirty tree, not a broken install. Add new payload entries to the explicit list in
`stage-plugin.mjs`.

**The published bundle exists once, and `bin` points at the staged copy.** The payload has to
contain `dist/guardian.cjs`, so shipping the root one beside it put the same 157KB in the
tarball twice — 314KB of 424KB. `bin` therefore reaches into `build/plugin`, which reads
oddly in `package.json` and is the reason the package is 248KB: the CLI is one more entry
point into the payload, not a second copy of it.

**Substitution happens at a layer you did not pick.** `${VAR:-default}` looks like it
handles the empty case and does not: whoever expands it first wins, and that is never the
layer you meant. It cost a chained status line (cmd.exe cannot expand it) and a slash
command's argument (Claude Code substitutes `$ARGUMENTS`, not the `:-` form). Prefer the
bare form and handle the default in code you control.

**A command's payload is data, not commands.** Heredoc bodies carry commit messages and
patch scripts; quoted arguments carry notes and handoff text. Pattern-matching the whole line
made a commit message about a bad test baseline become the test baseline — and then, in the
same repo, a `guardian note --next "...npm run check..."` become one. Anything classifying a
command removes each heredoc from its marker to its terminator — never truncates at `<<`,
which silently discarded the commands after the body — and blanks quoted spans before
matching. Extraction still returns the original text.

**A gauge must never contradict what it gauges.** The dashboard read `state.manifest` while
the CLI's seal wrote only the manifest file, so it reported "not sealed" with a sealed
manifest beside it. Every write path that changes an observable fact updates the state the
display reads.

**Failing open is not the same as failing silently.** Dropping the user's status line
because it took 2.8s is the correct fallback and an unacceptable one to perform quietly.
Where a path swallows a failure, it leaves a mark on the bar and a line in `guardian log`.

**A field name is a claim, and 154 nulls are the evidence.** Guardian read `tool_output`
where PostToolUse sends `tool_response`, so every command it ever recorded on a real machine
had `ok: null` while the tests — which synthesized the field — passed. Where a hook payload
field is optional, a path that finds nothing logs the keys that did arrive.

**Adding an actuator can disarm another one.** Auto-seal writes `manifest.sealed_at`, and the
Stop brake used to skip whenever that was set: the new actuator silently turned off the only
prompt that asks for a next action. A latch or gate keyed on another actuator's side effect
is keyed on the wrong thing — gate on the fact you actually need (here, an unrecorded
intent).

**A step name is not a reason.** For a day every checkpoint in one repo said `add failed`
while git had written `error: open("ng/nul"): No such file or directory` — a Windows
reserved device name in the tree — to a stderr nobody captured. The same empty message also
covered `git add -A` being killed at a 10s cap on a working tree that needs 21.7s, because
`spawnSync` reports a kill through `error` rather than a throw. Anything that shells out
keeps both stderr and the spawn error, and a degraded path names the cause, not the step.

**`latest` is one file for a whole project, and every session seals on the way out.** So the
last session to exit won it regardless of whether it did anything: a session that opened and
closed wrote 397 bytes over a 108KB handoff two minutes after it landed, and `/guardian
resume` then offered a manifest with no files, no commits and no next action. A seal that
records nothing never displaces one that records something (`carriesNothing`), history keeps
every seal either way, pruning never drops what `latest` points at, and the read path
(`readBestHandoff`) looks past a clobber that already happened.

**A next action has a shelf life; nothing else in the manifest does.** Files and commits are
observations and stay true. Intent describes a moment, and a nine-hour session that wrote its
note in hour one sealed "ONLY LANE K REMAINS" over twelve lanes that had since run. The note
carries `next_action_at`, anything later is counted (`next_action_superseded`), and every
surface that shows a next action says when it is spent — including the Stop brake, which
treats a superseded note as no note, and the landing brief, which otherwise reads as advice
the model already took.

**Each running agent is its own handoff.** The manifest used to say "agent ag2 was running"
and nothing actionable. It now carries what each was asked to do, how long it had been at it,
how full its own context was, and whether its notes file has anything in it — because an
in-flight agent that wrote nothing down is the only part of a session that cannot be
recovered from disk. The spawn gate can only reach agents born after the climb; agents
already running are asked through their own tool calls, and when a payload carries nothing
identifying one, the keys that did arrive go in the log.

**A timeout you have not measured is not a timeout.** `spawnSync`'s `timeout` kills the shell
it started, not the grandchild that shell started — and while Node holds a stdin pipe open
for that grandchild, the call goes on waiting for it. Measured: a 300ms cap against a 3s
child returned after 3139ms with `input`, and after 309ms with stdin on a file descriptor.
`chain_timeout_ms` therefore capped nothing, and a slow chained bar held the whole status
line for as long as it really took — worst exactly when a dozen agents were running. The
payload goes to the child on a descriptor (`spawnChained`); the contract is unchanged.

**A segment that fails should degrade, not vanish.** Three dots where the user's own bar used
to be is a loss of real information at the moment they are watching it. Guardian keeps the
last bar the chained command produced and shows that, marked `⋯` with its age, for up to ten
minutes. The mark is not optional: this is the same rule as failing open loudly. And the
`doctor` probe answers for the command, never for the cache — a gauge that agrees with a
cache is agreeing with itself.

**Burn defaults are calibrated, not chosen.** `scripts/calibrate.ts` replays real transcripts
from `~/.claude/projects`. Changing `burn.*` means re-running it, not reasoning about it.

## Commands

```bash
npm run check     # typecheck + layers + build + stage-plugin + tests
npm run perf      # hot-path latency
node --experimental-strip-types scripts/calibrate.ts --diagnose
```

