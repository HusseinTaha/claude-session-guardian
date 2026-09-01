---
description: Guardian — could a fresh session actually resume this work? Self-check.
argument-hint: "[--cold] [--seal] [--strict]"
allowed-tools: Bash(node:*)
disable-model-invocation: true
---

!`node "${CLAUDE_PLUGIN_ROOT}/dist/guardian.cjs" doctor ${ARGUMENTS}`

Summarise the verdict and act on the `FAIL` lines — each one carries the command that fixes
it. A missing next action is the one worth fixing immediately: run
`guardian note --next "<the single most specific next step>"` and re-run the check.

Without `--cold` this is a static audit of the manifest's shape and costs nothing. With
`--cold` it builds a scratch worktree and runs a fresh `claude -p` that has never seen this
session, which spends real budget — mention that before suggesting it.

If a cold answer is printed, read it rather than trusting the two mechanical checks: those
are keyword overlap, not comprehension. If a model with no memory of this work could not say
what to do next, the manifest needs a more specific `note --next`.
