---
description: Guardian — how much session budget is left, and how long until the wall
argument-hint: ""
allowed-tools: Bash(node:*)
disable-model-invocation: true
---

!`node "${CLAUDE_PLUGIN_ROOT}/dist/guardian.cjs" status`

Interpret the dashboard for the user rather than restating it. `wall: refills first` means
that window replenishes faster than this session is burning it — safe at any percentage.
`wall: unknown` means no burn rate is measurable yet, so the percentage floor is guarding.
A time on `five_hour` or `seven_day` is a hard deadline; a time on `context` only means
compaction is approaching, which is recoverable in seconds.
