import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, utimesSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnWithStdinFile, sweepPayloadResidue } from '../src/core/spawn.ts';

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

// The descriptor that made the cap real is itself a file, and its only cleanup was a
// `finally` — which a killed process never reaches. Claude Code kills a status line it has
// superseded as a matter of course, so that stranded one payload per killed run: 985 files
// and 69MB in one project's state directory, growing 200-400 a day.

// The property that makes a kill harmless: by the time anything else runs, the payload has
// no name. Asked of the child itself, because the child is the one moment the file provably
// still has to be readable. Without the early unlink the list comes back non-empty.
test('the payload is already unlinked before the child runs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'guardian-payload-'));
  try {
    const r = spawnWithStdinFile(
      process.execPath,
      [
        '-e',
        `const fs=require("fs");
         const payload=fs.readFileSync(0,"utf8");
         const left=fs.readdirSync(process.env.GUARDIAN_PROBE_DIR);
         process.stdout.write(JSON.stringify({payload,left}));`,
      ],
      'still readable, already nameless',
      {
        timeoutMs: 20_000,
        payloadDir: dir,
        env: { ...process.env, GUARDIAN_PROBE_DIR: dir },
      },
    );
    assert.equal(r.status, 0, `exit ${r.status}: ${(r.stderr ?? '').slice(0, 200)}`);
    const seen = JSON.parse((r.stdout ?? '').trim()) as { payload: string; left: string[] };
    // Delivered in full...
    assert.equal(seen.payload, 'still readable, already nameless');
    // ...with nothing on disk for a kill to strand.
    assert.deepEqual(seen.left, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the sweep takes residue past every cap and leaves live payloads alone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'guardian-sweep-'));
  try {
    const stale = join(dir, 'stdin.999999.1.txt');
    const live = join(dir, 'stdin.777777.2.txt');
    // The default payload directory is the OS temp dir, which belongs to everybody, so the
    // sweep must go by name as well as age. Anything else in there is not ours to delete.
    const foreign = join(dir, 'someone-elses-cache.txt');
    for (const f of [stale, live, foreign]) writeFileSync(f, '{}');
    const old = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(stale, old, old);
    utimesSync(foreign, old, old);

    assert.equal(sweepPayloadResidue(dir), 1);
    assert.equal(existsSync(stale), false);
    // Several sessions spawn concurrently; deleting a sibling's payload mid-read would feed
    // it an empty stdin, which is worse than the leak it fixes.
    assert.equal(existsSync(live), true);
    assert.equal(existsSync(foreign), true, 'the sweep must never touch a file it did not write');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the sweep stays bounded so a flooded directory cannot stall a refresh', () => {
  const dir = mkdtempSync(join(tmpdir(), 'guardian-sweep-cap-'));
  try {
    const old = new Date(Date.now() - 60 * 60 * 1000);
    for (let i = 0; i < 12; i++) {
      const f = join(dir, `stdin.1.${i}.txt`);
      writeFileSync(f, '{}');
      utimesSync(f, old, old);
    }
    assert.equal(sweepPayloadResidue(dir, 5), 5);
    assert.equal(sweepPayloadResidue(dir, 5), 5);
    assert.equal(sweepPayloadResidue(dir, 5), 2);
    assert.equal(sweepPayloadResidue(dir, 5), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
