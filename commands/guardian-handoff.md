---
description: Guardian — seal a resumable handoff of this session's work right now
argument-hint: "[--reason \"why\"] [--no-git]"
allowed-tools: Bash(node:*)
disable-model-invocation: true
---

Before sealing, record what Guardian cannot observe. It already has the files, commands,
commits, tasks and tests; intent is the gap. Run this first, with a genuinely specific step:

```
node "${CLAUDE_PLUGIN_ROOT}/dist/guardian.cjs" note --next "<the single most specific next step>"
```

Add `--gotcha "..."` for anything a fresh session would get wrong, and `--decision "..."`
for a choice whose reasoning is not visible in the code.

Then seal:

!`node "${CLAUDE_PLUGIN_ROOT}/dist/guardian.cjs" handoff ${ARGUMENTS}`

Tell the user what was captured and where. If the output says no next action was recorded,
add one before finishing.
