---
description: Session Guardian — usage status, handoff, resume, and configuration
argument-hint: "[status|init|config|handoff|resume|wait|verify|agents|on|off|install|uninstall]"
allowed-tools: Bash(node:*)
---

Run the Guardian CLI with the arguments in `$ARGUMENTS` (default `status`):

!`node "${CLAUDE_PLUGIN_ROOT}/dist/guardian.cjs" ${ARGUMENTS:-status}`

Report the result to the user. If the output says Guardian has no state for this project
yet, the status line sensor has not run here. The usual cause is a project that sets its own
`statusLine` in `.claude/settings.json`, which replaces the user-level one outright: tell
them to run `/guardian init` and restart Claude Code, since the status line command is read
at startup.

## Reading a dashboard

Interpret it rather than restating it:

- `wall: refills first` means that window replenishes faster than this session is burning
  it. It is safe at **any** percentage; a high number there is not urgent.
- `wall: unknown` means no burn rate is measurable yet (too few samples, or an idle
  session). The percentage floor is what is guarding, not the clock.
- A time on the `five_hour` or `seven_day` row is a hard deadline: hitting it returns HTTP
  429 and ends the session for hours or days.
- A time on the `context` row only means compaction is approaching — lossy, automatic, and
  recoverable in seconds. Never describe it in the same terms as a rate-limit wall.
- `new spawns BLOCKED` means the gate is denying subagents. Do remaining work inline.

## Configuration

`/guardian config` lists every setting with its value, whether it is overridden, and what it
does. To change one:

```
/guardian config set thresholds_minutes.land 8
/guardian config set agents.deny_spawn_from EMERGENCY
/guardian config set render.color false
/guardian config set thresholds_minutes.prepare 20 thresholds_minutes.land 10
```

Values are validated before anything is written, and an inconsistent combination is
refused with an explanation rather than saved. Other subcommands: `config get <setting>`,
`config unset <setting>`, `config reset`, `config check`, `config path`. `/guardian on` and
`/guardian off` toggle Guardian for the project.

When the user describes what they want rather than naming a setting — "warn me earlier",
"stop blocking my agents", "quieter" — map it to the right key, show them the command you
are about to run, and run it. Do not edit `.claude/guardian/config.json` by hand; the CLI
validates, and hand-editing does not.

## Landing a session

If a Guardian brief has appeared saying LAND, EMERGENCY or HARD_STOPPED, follow the
`guardian-protocol` skill. In short: record the next action with
`guardian note --next "..."`, then `/guardian handoff`. Guardian already has the
files, commands, commits, tasks and tests — intent is the only thing it cannot observe.
