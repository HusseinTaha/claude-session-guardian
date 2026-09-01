import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import type { GuardianState } from './types.ts';
import { statePath, ensureGuardianDir } from './paths.ts';

export function emptyState(sessionId: string): GuardianState {
  return {
    schema: 1,
    session_id: sessionId,
    updated_at: 0,
    mode: 'NORMAL',
    reason: 'no observations yet',
    binding_axis: null,
    axes: {},
    cost_usd: null,
    model: null,
    agents: { live: 0, spawn_allowed: true },
    samples: [],
    latches: {},
    hard_stop: null,
    manifest: { sealed_at: null },
  };
}

/** JSON has no Infinity. Guardian genuinely means it — an axis whose window refills
 *  before it can be exhausted has infinite headroom — so it survives the round trip as a
 *  sentinel string rather than being flattened to null, which would read as "unknown".
 *  Confining the quirk here keeps the arithmetic in mode.ts natural. */
const INF = '__Infinity__';

function replacer(_k: string, v: unknown): unknown {
  return v === Infinity ? INF : v === -Infinity ? `-${INF}` : v;
}
function reviver(_k: string, v: unknown): unknown {
  return v === INF ? Infinity : v === `-${INF}` ? -Infinity : v;
}

/** Always returns a usable state. A corrupt or half-written file is indistinguishable
 *  from no file as far as callers are concerned — actuators must never crash on it. */
export function readState(projectDir: string, sessionId: string): GuardianState {
  try {
    const raw = JSON.parse(readFileSync(statePath(projectDir, sessionId), 'utf8'), reviver) as GuardianState;
    if (raw?.schema !== 1) return emptyState(sessionId);
    return { ...emptyState(sessionId), ...raw };
  } catch {
    return emptyState(sessionId);
  }
}

/** Temp + rename, so a reader never observes a partial document. Both files live in the
 *  same directory to keep the rename atomic on Windows and POSIX alike. */
export function writeState(projectDir: string, state: GuardianState): void {
  const p = statePath(projectDir, state.session_id);
  const tmp = `${p}.${process.pid}.tmp`;
  ensureGuardianDir(projectDir, dirname(p));
  writeFileSync(tmp, JSON.stringify(state, replacer, 2));
  try {
    renameSync(tmp, p);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
}
