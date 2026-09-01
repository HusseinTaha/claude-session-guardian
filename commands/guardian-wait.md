---
description: Guardian — when does the rate-limit window reopen after a 429
argument-hint: ""
allowed-tools: Bash(node:*)
disable-model-invocation: true
---

!`node "${CLAUDE_PLUGIN_ROOT}/dist/guardian.cjs" wait`

Tell the user plainly when the window reopens. Do not attempt any further API work before
then — a retry cannot succeed and each attempt spends a turn discovering that. The work is
already sealed; `/guardian-resume` picks it up once the window is open.
