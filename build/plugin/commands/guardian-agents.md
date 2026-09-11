---
description: Guardian — live subagents, their context use, and typical run times
argument-hint: ""
allowed-tools: Bash(node:*)
disable-model-invocation: true
---

!`node "${CLAUDE_PLUGIN_ROOT}/dist/guardian.cjs" agents`

The median duration per agent type is a measurement of past runs in this project, not a
prediction about any current one — say so if you use it to advise on whether a delegation
fits in the remaining budget. `n=` is the sample size; a small `n` is weak evidence.
