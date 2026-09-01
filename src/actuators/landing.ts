import { openSync, readSync, closeSync, statSync } from 'node:fs';
import type { GuardianConfig, GuardianState } from '../types.ts';
import { severity, fmtMin } from '../budget/mode.ts';

/** Injection cost scales with mode.
 *
 *  Guardian exists to conserve budget, so it must not spend much of it talking. Below
 *  PREPARE it says nothing at all; the status line is already there for anyone looking. */
export function injectionFor(state: GuardianState, cfg: GuardianConfig): string | null {
  const from = cfg.landing.inject_from;
  if (severity(state.mode) < severity(from)) return null;

  switch (state.mode) {
    case 'PREPARE':
      // One line. Enough to change what gets started, not enough to be worth skipping.
      return (
        `[Guardian: PREPARE — ${state.reason}] Do not begin work that cannot reach a ` +
        `reportable state in that window. Prefer finishing what is open.`
      );

    case 'LAND':
      return LANDING_PROTOCOL(state);

    case 'EMERGENCY':
      return (
        `[Guardian: EMERGENCY — ${state.reason}] The next request may be refused. ` +
        `Do one thing: record the next action with ` +
        `\`claude-guardian note --next "..."\` and seal with \`/guardian handoff\`. ` +
        `Start nothing else.`
      );

    case 'HARD_STOPPED':
      return hardStoppedBrief(state);

    default:
      return null;
  }
}

function LANDING_PROTOCOL(state: GuardianState): string {
  return [
    `[Guardian: LAND — ${state.reason}]`,
    '',
    'Land the work. In this order:',
    '1. Bring the current operation to a stopping point. Do not start another.',
    '2. Record what cannot be observed from the files:',
    '   `claude-guardian note --next "<the single most specific next step>"`',
    '   Add `--gotcha` or `--decision` for anything a fresh session would get wrong.',
    '3. Seal it: `/guardian handoff`.',
    '',
    'Guardian already has the files, commands, commits, tasks and tests. What it cannot',
    'see is intent, so the note is the part that matters. New subagents are blocked;',
    'do small remaining work inline.',
  ].join('\n');
}

export function hardStoppedBrief(state: GuardianState): string {
  // `hard_stop` is authoritative: it comes from the 429 record itself. The axes may be
  // empty here, since a session can be refused before the status line has ever run.
  const resets =
    state.hard_stop?.resets_at ??
    state.axes.five_hour?.resets_at ??
    state.axes.seven_day?.resets_at ??
    null;
  const when = resets ? new Date(resets * 1000).toISOString().replace('T', ' ').slice(0, 16) : null;
  const kind = state.hard_stop?.kind && state.hard_stop.kind !== 'unknown'
    ? ` (${state.hard_stop.kind})`
    : '';
  return (
    `[Guardian: HARD_STOPPED] A rate limit${kind} refused a request. ` +
    (when
      ? `The window reopens at ${when} UTC — nothing will succeed before then. `
      : `The reset time was not recorded, so retry cautiously. `) +
    `A handoff has been sealed; run \`/guardian wait\` for a countdown, and ` +
    `\`/guardian resume\` once the window reopens. Do not retry in the meantime.`
  );
}

/** Instruction written to stderr when the `Stop` hook refuses to let the turn end.
 *  Deliberately narrow: one action, no room to interpret it as "carry on working". */
export function forceSealInstruction(state: GuardianState): string {
  return (
    `Session Guardian is in ${state.mode} (${state.reason}) and no handoff has been sealed. ` +
    `Before stopping, do exactly this and nothing more: record the next action with ` +
    `\`claude-guardian note --next "<the single most specific next step>"\`, then run ` +
    `\`claude-guardian handoff --reason "${state.mode}"\`. Then stop.`
  );
}

const TAIL_BYTES = 256 * 1024;

/** Read the last chunk of a file. Transcripts reach hundreds of megabytes, and the record
 *  we want is always at the end. */
export function readTail(path: string, bytes = TAIL_BYTES): string {
  let fd: number | null = null;
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - bytes);
    const length = size - start;
    if (length <= 0) return '';
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, start);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

export interface RateLimitTombstone {
  kind: string;
  resets_at: number | null;
}

/** A hard 429 leaves a `quotaLimits` record in the transcript. It appears only on rejection
 *  — a tombstone, not a gauge — which makes it useless for prediction and exactly right for
 *  answering "when does the window reopen?" after the fact. */
export function parseRateLimitTombstone(transcriptPath: string | undefined): RateLimitTombstone | null {
  if (!transcriptPath) return null;
  const tail = readTail(transcriptPath);
  if (!tail.includes('quotaLimits')) return null;

  // Scan backwards for the most recent rejection.
  const idx = tail.lastIndexOf('"quotaLimits"');
  if (idx < 0) return null;
  const window = tail.slice(idx, idx + 600);

  const status = /"status"\s*:\s*"([a-z_]+)"/.exec(window)?.[1];
  if (status && status !== 'rejected') return null;

  const kind = /"rateLimitType"\s*:\s*"([a-z_]+)"/.exec(window)?.[1] ?? 'unknown';
  const resetsRaw = /"resetsAt"\s*:\s*(\d+)/.exec(window)?.[1];
  const resets = resetsRaw ? Number(resetsRaw) : null;

  return { kind, resets_at: resets && Number.isFinite(resets) ? resets : null };
}

/** Whether a turn-ending API error looks like a rate limit. */
export function isRateLimitError(errorType: string | undefined, message: string | undefined): boolean {
  const hay = `${errorType ?? ''} ${message ?? ''}`.toLowerCase();
  return (
    hay.includes('rate_limit') ||
    hay.includes('rate limit') ||
    hay.includes('429') ||
    hay.includes('quota')
  );
}

export function countdown(resetsAt: number | null, now: number): string {
  if (!resetsAt) return 'reset time unknown';
  const min = (resetsAt - now) / 60;
  if (min <= 0) return 'the window has reopened';
  return `${fmtMin(min)} until the window reopens`;
}
