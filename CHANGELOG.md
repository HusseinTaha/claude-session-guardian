# Changelog

## 0.6.0

The release where the estimator was calibrated against real data and the install path was
exercised on a real machine. Both turned up defects that the test suite could not have —
one class needs a thousand hours of transcripts to see, the other needs an actual install.

### The burn estimator

- **Sample thinning could not accumulate history.** The gap was measured from the tail
  sample, and overwriting the tail advanced its timestamp too, so any status line firing
  faster than the interval reset the clock every tick and the series never grew past one
  point. The burn rate was permanently unmeasurable in exactly the busy sessions that
  approach a wall. Thinning now measures from the sample before the tail.
- **`max_samples` silently capped `window_min`.** At a fixed 5s gap, 60 samples held 300s,
  so any window over 5 minutes was quietly truncated. Spacing is derived from the two
  together now, and a budget too small to fit `min_samples` inside the window is a config
  error rather than a silently unmeasurable rate.
- **`burn.window_min` 10 → 15**, calibrated rather than chosen: median relative error 0.41
  against 0.46 at 10 minutes, holding at both the idle and the busy status-line cadence and
  under the account-wide reconstruction. `alpha` stays 0.35; a larger sample budget measured
  worse in the tail.

### `scripts/calibrate.ts`

- `--diagnose` reports why each real 429 arrived unwarned: level, burn, mode and lead at the
  moment of the wall.
- Wall clustering: 22 tombstones were 16 walls, and the retries against an already-closed
  window were being counted as separate misses.
- Warning episodes are intervals, not start times. One that began two hours before a wall
  and was still running when it hit used to score as a miss.
- Five-hour spend is summed across every transcript on the machine, because the budget is
  per account and a session cannot see what the others are spending. Implied-capacity
  spread fell from 51% to 32%. `--per-session` reverts it.
- `--alphas`, `--windows`, `--samples`, `--tick` for scoped grids.

After all of it: 10 of 16 walls warned, and every remaining miss sits where the offline
reconstruction still reads far below the wall. None is an estimator blind spot.

### Install and setup

- **`guardian init`** — set up the project you are in, from anywhere inside it. Finds
  whichever settings layer actually decides the status line and takes it over from
  `settings.local.json`, so no machine-specific absolute path lands in a file the repo
  shares. Most projects still need nothing at all; this is for the ones that define their
  own `statusLine`, where Guardian was installed, hooked, and silently sensing nothing.
- **The command is `guardian`**, with `claude-guardian` kept as an alias for a PATH that
  already has one.
- **The bundle had no shebang**, so npm's POSIX shim ran it as a shell script and the global
  binary was unusable from any sh-based shell.
- **`plugin.json` re-declared the standard `hooks/hooks.json`**, which is loaded
  automatically. The duplicate made the entire plugin fail to load — every hook, the skill
  and the commands — behind a "successfully installed" line.
- **The plugin shipped whatever else was in the directory.** A `.mcp.json` kept for local
  development became an MCP server the plugin declared, enabled in every project of everyone
  who installed it. The marketplace source is now `build/plugin`, staged by
  `npm run stage-plugin` from an explicit list.
- **`uninstall` pinned a copy of the repo's status line** into `settings.local.json` when
  undoing an override. Harmless until the repo changed its bar and the stale copy silently
  kept winning. The override is removed instead, and the message no longer claims a write
  that did not happen.

### Chaining another status line

- **`${CLAUDE_PROJECT_DIR}`, `${VAR:-default}` and `$VAR` are expanded** the way Claude Code
  expands them before running a configured command. Guardian re-runs the displaced one
  through `cmd.exe`, which does not understand that syntax, so a project bar written that way
  resolved to a path with braces in it and vanished from the line.
- **The chained command follows its source file** rather than a snapshot taken at install.
  Tools that manage their own status line rewrite it; pinning the old text left their edits
  landing nowhere. The snapshot remains the fallback.

### Diagnostics

- **`doctor` checks the status line that actually runs.** It read the user's settings alone,
  so it reported "points at Guardian" for projects where a project-level `statusLine`
  overrode it and the sensor had never run — the one check whose job was catching exactly
  that.
- `uninstall` names any other layer still wired, rather than leaving it to be discovered.

### Display

- **Each gauge carries its own colour** — green, amber, bold amber, red, inverted red —
  keyed on that axis's mode rather than its percentage, so a 94% window that refills faster
  than you burn it stays green.
- **Guardian's segment takes the line below the bar it chained** (`statusline.own_line`).
  Two full status lines on one row wrap in most terminals.
- **Agent rows say what the agent is doing.** Replacing the default row had dropped its
  description, leaving two agents of the same type indistinguishable. On a narrow terminal
  the description absorbs the truncation alone — trimming the whole line took the context
  warning and the clock, which are the fields a decision near a wall is made on.

### Landing

- **Guardian seals by itself from `LAND` upward.** `landing.force_seal_turn` only refuses one
  turn-end and then asks the model to seal, which needs a turn to actually end and a model to
  comply; when either fails, the session is what is lost. `landing.auto_seal_from` (default
  `LAND`) seals from `PostToolUse` — async by necessity, since a seal runs git and the sensor
  has a 2.4ms budget. The latch is written before the seal, so a failing seal cannot storm;
  it re-arms if the window refills and the mode drops back, so a later climb seals the newer
  work; and a handoff sealed by hand counts until there is work recorded after it. Set it to
  `HARD_STOPPED` to switch it off.
- `landing.inject_from` and `landing.auto_seal_from` are now validated as mode names. Setting
  `landing.inject_from land` used to be accepted and silently matched nothing, which made
  Guardian inject at every mode rather than the one asked for.

### Found by using the auto-seal

- **A command's verdict was never read on a real machine: 154 of 154 recorded commands had
  `ok: null`.** Guardian read `tool_output`; PostToolUse carries `tool_response`. Every
  handoff said "test baseline — result unclear", and `inferOk`'s "0 failures is a success"
  logic was dead in production while passing in tests, which synthesized the field. Both
  fields are accepted now, an object is stringified rather than dropped, and a payload with
  no output at all leaves the keys that did arrive in the log.
- **Auto-sealing disarmed the Stop brake.** `onStop` skipped when a manifest existed, and
  auto-seal produces one on the way into LAND — so the refusal stopped firing exactly when
  it mattered, and with it the only prompt that asks for a next action. The brake now refuses
  while *this session's* manifest has no `next_action`, which is the thing Guardian cannot
  observe; the seal covers everything it can.
- **A digest with no stated next action now says what was in flight** — open tasks,
  boundary commands that never returned, agents still running — under `Next action — NOT
  STATED`, never as though someone had stated it.
- **Checkpoints and sealed history are pruned to the last 20.** Every checkpoint ref pins a
  whole tree and a reachable ref is one `git gc` cannot reclaim; before auto-seal a seal
  happened once a session, now it happens on every climb.
- **`doctor` gave a confident pass on a status line that had failed on every tick for two
  hours.** It now runs the chained command itself and counts how often the log says Guardian
  had to drop it, reports `chain source` when `chained_from` is unset (a snapshot Guardian
  will run forever), and marks a handoff **stale** when work has been recorded after it — in
  any session, since a resumed project seals under one id and works under another.
- **A quoted argument is data too.** `guardian note --next "...223 tests green (npm run
  check)..."` was classified as this session's test baseline, because the words were inside
  the note — the heredoc rule with a different delivery, and found by doctor auditing the
  seal that recorded it. Classification blanks quoted spans; extraction still returns the
  original text.
- **The heredoc fix threw away everything after the body.** Truncating at the first `<<`
  meant a call that opened with a `python - <<PY` patch and went on to commit was classified
  by the word `python`, so the commit never reached the manifest — Guardian's own handoff was
  missing its own last commit, `0ef60d8`. Heredocs are removed marker-to-terminator now,
  keeping what follows, and a commit is detected anywhere in the line rather than only when
  the line begins with `git`.
- `npm run perf` covers PostToolUse, which now runs on every tool call rather than on edits
  and shell commands only: p50 1.3ms.

### Found by using it

Everything below was found by running the tool against real work, after the suite was
green. They are recorded because the pattern matters more than the individual bugs: each
one looked like it was working.

- **`doctor --cold` had never asked its question on Windows.** The prompt went in argv to a
  `shell: true` spawn, which concatenates arguments unescaped, so `-p` received the single
  word `Read`. The cold session answered *that*, and the keyword checks scored the reply.
  The prompt goes on stdin now, and a marker token in the reply proves it arrived — a
  prompt that never lands can no longer be scored as an answer.
- **The resume protocol promised sections the digest did not carry** — "verify the file
  hashes below" with no hashes below. A cold reader flagged it: it cannot tell a truncated
  file from a lying one. Steps are built from what the manifest holds.
- **A slow status line was deleted silently.** The chained command had a hard 1.5s limit; a
  bar that walks a 62k-node index takes 2.8s, so it was killed every tick and two tools
  vanished with no error. `statusline.chain_timeout_ms` (default 5000), a `⋯` where the
  segment should be, and a line in the log.
- **`/guardian resume` ran `guardian status`.** The command files used `${ARGUMENTS:-status}`,
  which Claude Code does not substitute — the shell did, saw an unset variable, and took its
  own default. Commands pass `$ARGUMENTS` bare; no arguments now means the dashboard.
- **The dashboard said "Manifest: not sealed"** beside a sealed manifest, because only the
  hook path recorded a seal in state.
- **The recorded test baseline was the whole compound line** a test happened to sit inside,
  and the resume protocol told the next session to run it verbatim — including a global
  install. Then the fix proved insufficient in the same way: a commit message *describing*
  that bug quoted `npm run check`, and the classifier read the heredoc body as commands. A
  heredoc body is data; classification stops at the first `<<`.

## 0.5.0

Phases 1–5: the sensor and time-to-wall engine; observation ledger, handoff manifest,
lossless compaction, verified resume, git checkpoints; per-agent sensing, the spawn gate,
self-checkpointing subagents; tiered injection, the Stop brake, 429 recovery; a validated
config CLI, the `doctor` self-check with its cold-resume harness, and an optional MCP server.
