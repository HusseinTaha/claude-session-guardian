import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkpoint,
  listCheckpoints,
  removeCheckpoints,
  isRepo,
  refComponent,
} from '../src/handoff/git.ts';

function g(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  return (r.stdout ?? '').trim();
}

function repo(withCommit = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'guardian-git-'));
  g(dir, 'init', '-q');
  g(dir, 'config', 'user.name', 'Test');
  g(dir, 'config', 'user.email', 'test@example.com');
  g(dir, 'config', 'commit.gpgsign', 'false');
  if (withCommit) {
    writeFileSync(join(dir, 'tracked.txt'), 'original\n');
    g(dir, 'add', '-A');
    g(dir, 'commit', '-q', '-m', 'initial');
  }
  return dir;
}

test('a checkpoint captures the working tree without touching HEAD, index or worktree', () => {
  const dir = repo();
  writeFileSync(join(dir, 'tracked.txt'), 'modified\n');
  writeFileSync(join(dir, 'untracked.txt'), 'new file\n');

  const headBefore = g(dir, 'rev-parse', 'HEAD');
  const statusBefore = g(dir, 'status', '--porcelain');
  const logBefore = g(dir, 'log', '--oneline');

  const cp = checkpoint(dir, 'sess-1', '2026-09-01T10-00-00');

  assert.equal(cp.kind, 'ref');
  assert.ok(cp.ref?.startsWith('refs/guardian/sess-1/'));
  assert.ok(cp.sha);
  assert.equal(cp.dirty_files, 2);

  // The three things a checkpoint must never disturb.
  assert.equal(g(dir, 'rev-parse', 'HEAD'), headBefore, 'HEAD moved');
  assert.equal(g(dir, 'status', '--porcelain'), statusBefore, 'index or worktree changed');
  assert.equal(g(dir, 'log', '--oneline'), logBefore, 'checkpoint appeared in history');

  // And it must actually contain the uncommitted work, or it is theatre.
  assert.equal(g(dir, 'show', `${cp.sha}:tracked.txt`), 'modified');
  assert.equal(g(dir, 'show', `${cp.sha}:untracked.txt`), 'new file');
  // Parented on HEAD, so `git show` renders it as a normal diff.
  assert.equal(g(dir, 'rev-parse', `${cp.sha}^`), headBefore);
});

test('a checkpoint honours .gitignore', () => {
  const dir = repo();
  writeFileSync(join(dir, '.gitignore'), 'secrets/\n*.log\n');
  mkdirSync(join(dir, 'secrets'));
  writeFileSync(join(dir, 'secrets', 'key.txt'), 'do not capture\n');
  writeFileSync(join(dir, 'debug.log'), 'noise\n');
  writeFileSync(join(dir, 'keep.txt'), 'capture me\n');

  const cp = checkpoint(dir, 'sess-2', 'stamp');
  assert.equal(cp.kind, 'ref');
  const tree = g(dir, 'ls-tree', '-r', '--name-only', cp.sha!);
  assert.ok(tree.includes('keep.txt'));
  assert.ok(!tree.includes('secrets/key.txt'), 'ignored directory was captured');
  assert.ok(!tree.includes('debug.log'), 'ignored file was captured');
});

test('a checkpoint works in a repository with no commits yet', () => {
  const dir = repo(false);
  writeFileSync(join(dir, 'first.txt'), 'hello\n');
  const cp = checkpoint(dir, 'sess-3', 'stamp');
  assert.equal(cp.kind, 'ref');
  assert.equal(cp.head, null);
  assert.equal(g(dir, 'show', `${cp.sha}:first.txt`), 'hello');
  // No parent, since there is nothing to parent onto.
  assert.equal(g(dir, 'rev-list', '--count', cp.sha!), '1');
});

test('a clean repository still produces a checkpoint', () => {
  const dir = repo();
  const cp = checkpoint(dir, 'sess-4', 'stamp');
  assert.equal(cp.kind, 'ref');
  assert.equal(cp.dirty_files, 0);
});

test('outside a repository the checkpoint degrades rather than failing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'guardian-nogit-'));
  assert.equal(isRepo(dir), false);
  const cp = checkpoint(dir, 'sess-5', 'stamp');
  assert.equal(cp.kind, 'none');
  assert.equal(cp.ref, null);
  assert.match(cp.detail, /not a git repository/);
});

test('checkpoints are listable and removable, so uninstall leaves nothing behind', () => {
  const dir = repo();
  writeFileSync(join(dir, 'a.txt'), 'x\n');
  checkpoint(dir, 'sess-6', 'one');
  checkpoint(dir, 'sess-6', 'two');
  assert.equal(listCheckpoints(dir).length, 2);
  assert.equal(removeCheckpoints(dir), 2);
  assert.equal(listCheckpoints(dir).length, 0);
});

test('a hostile or dot-leading session id still yields a valid, contained ref', () => {
  const dir = repo();
  for (const sid of ['../../evil', '.hidden', 'a..b', 'weird/id', 'ends.lock']) {
    const cp = checkpoint(dir, sid, 'stamp');
    assert.equal(cp.kind, 'ref', `${sid} produced ${cp.kind}: ${cp.detail}`);
    assert.ok(cp.ref?.startsWith('refs/guardian/'), `${sid} -> ${cp.ref}`);
    assert.ok(!cp.ref?.includes('..'), `${sid} -> ${cp.ref}`);
    // git itself is the authority on whether the ref is legal.
    assert.equal(
      spawnSync('git', ['check-ref-format', cp.ref!], { cwd: dir }).status,
      0,
      `git rejected ${cp.ref}`,
    );
  }
});

test('refComponent produces components git accepts', () => {
  assert.equal(refComponent('.hidden'), 'hidden');
  assert.equal(refComponent('a..b'), 'a__b');
  assert.equal(refComponent('___'), 'unknown');
  assert.equal(refComponent('2026-09-01T10-00-00'), '2026-09-01T10-00-00');
});
