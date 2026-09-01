---
name: guardian-protocol
description: How to land a Claude Code session cleanly when Session Guardian reports LAND, EMERGENCY or HARD_STOPPED — what to seal, what to record, and what not to start. Use when a Guardian brief appears in the conversation, when asked to wrap up or hand off a session, or when a rate limit has refused a request.
---

# Landing a session under Guardian

Guardian has told you the session is close to a wall. The goal is not to finish the work —
it is to leave the work **resumable**, so the next session loses nothing.

## What Guardian already knows

Do not spend budget re-describing any of this. Hooks recorded it as you worked:

- every file created or modified, with a SHA-256 of its current contents
- every shell command, with secrets redacted, and whether tests passed
- every commit made this session
- tasks created and completed
- subagents that ran, what they returned, and which are still in flight
- a git checkpoint of the working tree, untracked files included
- irreversible commands that started and were never seen to return

## What Guardian cannot know

Intent. That is the entire job:

```bash
guardian note --next "<the single most specific next step>"
```

This is the highest-value line in the manifest. Compare:

- Bad: `"Continue working on auth"` — the next session already knows that much.
- Good: `"Finish rotateRefreshToken() in src/auth/refresh.ts:88 — the happy path works, the
  reuse-detection branch is unwritten. Then run npm test -- auth."`

Add these when they apply:

```bash
guardian note --decision "Chose idempotency keys over a dedupe table; see ADR 014"
guardian note --gotcha   "The staging webhook secret rotates nightly; re-fetch first"
guardian note --objective "Migrate billing off the legacy gateway"
```

A `--gotcha` is worth writing whenever you know something a fresh session would get wrong.

## By mode

### LAND

1. Bring the current operation to a stopping point. Do not start another.
2. `guardian note --next "..."`, plus `--gotcha` / `--decision` if relevant.
3. `/guardian handoff`

New subagents are blocked at this point. Small remaining work goes inline, where its
partial results stay in this session instead of vanishing with a delegation.

Guardian may already have sealed one by itself on the way into `LAND`. That does not replace
step 2 or step 3: an automatic seal has the files, commands and commits, and it cannot have
the note, because you had not written it yet. Record the intent and seal again — the second
manifest supersedes the first and carries what the first could not.

### EMERGENCY

The next request may be refused. Do two commands, nothing else:

```bash
guardian note --next "..."
guardian handoff --reason EMERGENCY
```

No refactors, no "one last fix", no test runs. A sealed handoff with an unfinished feature
beats an unsealed handoff with a slightly-less-unfinished feature.

### HARD_STOPPED

A rate limit has already refused a request. Nothing will work until the window reopens.
Guardian has sealed a handoff automatically.

```bash
/guardian wait      # countdown to the reset
```

Tell the user when the window reopens and stop. Do not retry — a retry cannot succeed and
each attempt is wasted.

## Rules

**Never sacrifice repository consistency to save context.** A half-applied migration or a
partially-renamed symbol costs the next session far more than a lost summary. If the choice
is between leaving the tree consistent and sealing a richer manifest, leave the tree
consistent.

**Do not commit on the user's behalf** unless they asked. Guardian's checkpoint already
captures uncommitted work as a real commit under `refs/guardian/`, recoverable with
`git show`, without touching HEAD, the index or the working tree.

**Report honestly.** If something is broken, say so in `--gotcha`. A manifest that claims
tests pass when they do not is worse than no manifest, because the next session will build
on it.

**Do not re-run tests just to make the manifest look better.** Guardian recorded the last
real result.

## Resuming later

```bash
/guardian resume
```

That prints the digest and verifies the workspace against the recorded hashes: which files
are unchanged, which drifted, and which are gone. Reconcile any drift before acting on the
next action — drift means someone edited outside the handoff.
