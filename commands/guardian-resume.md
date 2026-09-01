---
description: Guardian — load the last sealed handoff and verify the workspace against it
argument-hint: ""
allowed-tools: Bash(node:*)
disable-model-invocation: true
---

!`node "${CLAUDE_PLUGIN_ROOT}/dist/guardian.cjs" resume`

Follow the resume protocol in the output. Specifically:

- Do not redo anything listed under "completed".
- If files are reported as CHANGED or MISSING, the workspace has drifted from the handoff —
  reconcile that before acting on the next action, and tell the user what drifted.
- Run the recorded test command before writing anything, to confirm the starting state.
- If the digest reports a possibly-interrupted irreversible operation, check its state first.

Then continue from the recorded next action.
