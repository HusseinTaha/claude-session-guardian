---
description: Guardian — list settings, or change one (thresholds, agent gate, colours)
argument-hint: "[set <setting> <value> | get <setting> | unset <setting> | reset | check]"
allowed-tools: Bash(node:*)
disable-model-invocation: true
---

!`node "${CLAUDE_PLUGIN_ROOT}/dist/guardian.cjs" config $ARGUMENTS`

With no arguments this lists every setting, its value, whether it is overridden, and what it
does. Common changes:

```
/guardian-config set thresholds_minutes.land 8          land later
/guardian-config set thresholds_minutes.watch 45        warn earlier
/guardian-config set agents.deny_spawn_from EMERGENCY   let subagents run for longer
/guardian-config set agents.deny_spawn_from HARD_STOPPED  never block subagents
/guardian-config set landing.inject_from LAND           talk less
/guardian-config set landing.force_seal_turn false      never refuse a turn-end
/guardian-config set landing.auto_seal_from EMERGENCY   seal automatically later
/guardian-config set landing.auto_seal_from HARD_STOPPED  never seal automatically
/guardian-config set render.color false
```

Values are validated before anything is written; an inconsistent combination is refused with
an explanation rather than saved. If the user described what they wanted instead of naming a
setting, map it to the right key, show the command you are running, and run it. Never edit
`.claude/guardian/config.json` by hand — the CLI validates and catches typo'd keys, which the
file silently ignores.
