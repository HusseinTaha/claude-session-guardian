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

**The plugin ships `build/plugin`, not the repo.** A marketplace source pointed at a working
directory installs everything in it, `.mcp.json` included, and Claude Code enables what it
finds. Run `npm run stage-plugin` (part of `npm run check`) and add new payload entries to
its explicit list.

**Burn defaults are calibrated, not chosen.** `scripts/calibrate.ts` replays real transcripts
from `~/.claude/projects`. Changing `burn.*` means re-running it, not reasoning about it.

## Commands

```bash
npm run check     # typecheck + layers + build + stage-plugin + tests
npm run perf      # hot-path latency
node --experimental-strip-types scripts/calibrate.ts --diagnose
```

