import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnWithStdinFile } from '../src/core/spawn.ts';

// The property the whole helper exists for. `spawnSync`'s timeout kills the process it
// started; under `shell: true` that is the shell, and while Node holds a stdin pipe for the
// grandchild the call waits for the grandchild anyway. A cap that does not cap is how a slow
// bar held the whole status line, and how doctor's 240s cold-session cap bounded a cmd.exe
// that had already handed off.
test('the timeout bounds a shelled child that outlives its shell', () => {
  const started = Date.now();
  const r = spawnWithStdinFile(
    `"${process.execPath}" -e "setTimeout(()=>{},5000)"`,
    null,
    'payload that is never read\n',
    { timeoutMs: 700, shell: true },
  );
  const elapsed = Date.now() - started;
  assert.ok(r.error || r.signal, 'expected the child to be killed by the cap');
  // Generous headroom for process start on a loaded machine, but nowhere near the 5s the
  // child asked for — which is what the unbounded shape actually returned.
  assert.ok(elapsed < 4000, `cap did not hold: returned after ${elapsed}ms`);
});

test('a payload on the descriptor still reaches the child', () => {
  const r = spawnWithStdinFile(
    process.execPath,
    ['-e', 'process.stdout.write(require("fs").readFileSync(0,"utf8").trim().toUpperCase())'],
    'hello from the file descriptor',
    { timeoutMs: 20_000 },
  );
  assert.equal(r.status, 0, `exit ${r.status}: ${(r.stderr ?? '').slice(0, 200)}`);
  assert.equal((r.stdout ?? '').trim(), 'HELLO FROM THE FILE DESCRIPTOR');
});
