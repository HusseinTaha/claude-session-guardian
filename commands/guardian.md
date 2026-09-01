---
description: Session Guardian — usage status, install, and control
argument-hint: "[status|install|uninstall|where]"
allowed-tools: Bash(node:*)
---

Run the Guardian CLI for the subcommand in `$ARGUMENTS` (default `status`):

!`node "${CLAUDE_PLUGIN_ROOT}/dist/guardian.cjs" ${ARGUMENTS:-status}`

Report the result to the user. If the output says Guardian has no state for this project
yet, the status line sensor has not run — tell them to run `/guardian install` and restart
Claude Code, since the status line command is read at startup.

When reading a dashboard, interpret it for the user rather than restating it:

- `wall: refills first` means that window replenishes faster than this session is burning
  it. It is safe at **any** percentage; do not treat a high number there as urgent.
- `wall: unknown` means no burn rate is measurable yet (too few samples, or an idle
  session). The percentage floor is what is guarding, not the clock.
- A time on the `five_hour` or `seven_day` row is a hard deadline: hitting it returns HTTP
  429 and ends the session for hours or days.
- A time on the `context` row only means compaction is approaching — lossy, automatic, and
  recoverable in seconds. Never describe it in the same terms as a rate-limit wall.
