import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function git(cwd: string, args: string[], env?: Record<string, string>): { ok: boolean; out: string } {
  try {
    const r = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
      env: { ...process.env, ...env },
    });
    return { ok: r.status === 0, out: (r.stdout ?? '').trim() };
  } catch {
    return { ok: false, out: '' };
  }
}

/** git-check-ref-format is stricter than a filesystem: a path component may not begin
 *  with a dot, may not contain `..`, and may not end in `.lock`. Reusing the filesystem
 *  sanitizer here produced refs git silently refused, which lost the checkpoint. */
export function refComponent(s: string): string {
  const cleaned = s
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .replace(/^[-_]+/, '')
    .replace(/[-_]+$/, '');
  return cleaned || 'unknown';
}

export interface CheckpointResult {
  kind: 'ref' | 'stash' | 'status-only' | 'none';
  ref: string | null;
  sha: string | null;
  branch: string | null;
  head: string | null;
  dirty_files: number;
  detail: string;
}

export function isRepo(cwd: string): boolean {
  return git(cwd, ['rev-parse', '--is-inside-work-tree']).out === 'true';
}

function dirtyCount(cwd: string): number {
  const r = git(cwd, ['status', '--porcelain']);
  return r.ok ? r.out.split('\n').filter((l) => l.trim()).length : 0;
}

/** Capture the working tree as a real commit object that nothing points at except a
 *  Guardian-owned ref.
 *
 *  Committing to the user's branch mid-task is intrusive, and leaving work uncommitted
 *  risks losing it. Writing through a throwaway index gets both: a fully recoverable
 *  commit that never touches HEAD, the index, or the working tree, is invisible to
 *  `git log`, and disappears with one `update-ref -d`. */
export function checkpoint(projectDir: string, sessionId: string, stamp: string): CheckpointResult {
  const base: CheckpointResult = {
    kind: 'none',
    ref: null,
    sha: null,
    branch: null,
    head: null,
    dirty_files: 0,
    detail: '',
  };

  if (!isRepo(projectDir)) {
    return { ...base, kind: 'none', detail: 'not a git repository' };
  }

  const branch = git(projectDir, ['rev-parse', '--abbrev-ref', 'HEAD']).out || null;
  const headRes = git(projectDir, ['rev-parse', 'HEAD']);
  const head = headRes.ok ? headRes.out : null; // absent in a repo with no commits yet
  const dirty = dirtyCount(projectDir);
  const ref = `refs/guardian/${refComponent(sessionId)}/${refComponent(stamp)}`;

  let tmp: string | null = null;
  try {
    tmp = mkdtempSync(join(tmpdir(), 'guardian-idx-'));
    const indexFile = join(tmp, 'index');
    const env = { GIT_INDEX_FILE: indexFile };

    if (head && !git(projectDir, ['read-tree', 'HEAD'], env).ok) {
      throw new Error('read-tree failed');
    }
    // -A honours .gitignore, so ignored files stay out of the checkpoint.
    if (!git(projectDir, ['add', '-A'], env).ok) throw new Error('add failed');
    const tree = git(projectDir, ['write-tree'], env);
    if (!tree.ok || !tree.out) throw new Error('write-tree failed');

    const msg = `guardian checkpoint ${stamp} (session ${sessionId})`;
    const args = ['commit-tree', tree.out, '-m', msg];
    if (head) args.push('-p', head);
    const commit = git(projectDir, args);
    if (!commit.ok || !commit.out) throw new Error('commit-tree failed');

    if (!git(projectDir, ['update-ref', ref, commit.out]).ok) throw new Error('update-ref failed');

    return {
      kind: 'ref',
      ref,
      sha: commit.out,
      branch,
      head,
      dirty_files: dirty,
      detail: `${dirty} uncommitted file(s) captured`,
    };
  } catch (err) {
    // `stash create` also leaves the working tree untouched, but produces a dangling
    // commit, so it still needs a ref to survive garbage collection.
    const stash = git(projectDir, ['stash', 'create', `guardian checkpoint ${stamp}`]);
    if (stash.ok && stash.out) {
      git(projectDir, ['update-ref', ref, stash.out]);
      return {
        kind: 'stash',
        ref,
        sha: stash.out,
        branch,
        head,
        dirty_files: dirty,
        detail: `plumbing path failed (${(err as Error).message}); used stash create`,
      };
    }
    return {
      kind: 'status-only',
      ref: null,
      sha: null,
      branch,
      head,
      dirty_files: dirty,
      detail: `could not checkpoint (${(err as Error).message}); recorded state only`,
    };
  } finally {
    if (tmp) {
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

export function listCheckpoints(projectDir: string): string[] {
  const r = git(projectDir, ['for-each-ref', '--format=%(refname)', 'refs/guardian']);
  return r.ok && r.out ? r.out.split('\n').filter(Boolean) : [];
}

/** Keep the recent history and drop the rest. Every checkpoint ref pins a whole tree, and
 *  a reachable ref is one `git gc` will never reclaim — so an unbounded set of them is a
 *  repository that grows for as long as Guardian is installed. Auto-sealing made that rate
 *  a seal per climb rather than a seal per session. Refs are named by ISO stamp, so the
 *  newest are the last in sort order. */
export function pruneCheckpoints(projectDir: string, keep: number): number {
  const refs = listCheckpoints(projectDir).sort();
  let n = 0;
  for (const ref of refs.slice(0, Math.max(0, refs.length - keep))) {
    if (git(projectDir, ['update-ref', '-d', ref]).ok) n++;
  }
  return n;
}

/** Guardian must leave nothing behind on uninstall. */
export function removeCheckpoints(projectDir: string): number {
  const refs = listCheckpoints(projectDir);
  let n = 0;
  for (const ref of refs) {
    if (git(projectDir, ['update-ref', '-d', ref]).ok) n++;
  }
  return n;
}

/** Does this commit still describe the working tree? Used on resume to tell "nothing has
 *  changed since the handoff" from "someone has been editing outside Claude". */
export function headMatches(projectDir: string, sha: string | null): boolean | null {
  if (!sha || !isRepo(projectDir)) return null;
  const head = git(projectDir, ['rev-parse', 'HEAD']);
  return head.ok ? head.out === sha : null;
}
