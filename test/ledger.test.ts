import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { redact, clip } from '../src/handoff/redact.ts';
import {
  appendEvent,
  readLedger,
  classifyCommand,
  inferOk,
  hashFile,
  commandEvent,
  testCommand,
} from '../src/handoff/ledger.ts';
import { resolveStateRoot, ledgerPath } from '../src/core/paths.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'guardian-led-'));
/** resolveStateRoot normalises Windows 8.3 short paths, so compare against the real path. */
const realp = (p: string) => realpathSync.native(p).toLowerCase();

test('redact removes known token shapes', () => {
  const cases: Array<[string, string]> = [
    ['curl -H "Authorization: Bearer abc123xyz"', 'Authorization: [REDACTED]'],
    ['export GITHUB_TOKEN=ghp_0123456789abcdefghij', '[REDACTED]'],
    ['echo sk-ant-api03-abcdefghijklmnop', 'sk-ant-[REDACTED]'],
    ['aws --key AKIAIOSFODNN7EXAMPLE', 'AKIA[REDACTED]'],
    ['psql postgres://user:hunter2@db.example.com/app', 'user:[REDACTED]@'],
    ['deploy --token=s3cr3tvalue', '[REDACTED]'],
    ['DB_PASSWORD="p@ssw0rd" npm start', '[REDACTED]'],
  ];
  for (const [input, expected] of cases) {
    const out = redact(input);
    assert.ok(out.includes(expected), `${input}\n  -> ${out}\n  expected to contain ${expected}`);
  }
});

test('redact leaves ordinary commands legible', () => {
  const cmd = 'npm run build && node --test "test/**/*.test.ts"';
  assert.equal(redact(cmd), cmd);
});

test('redact does not leak the secret it replaced', () => {
  assert.ok(!redact('export API_KEY=supersecret123').includes('supersecret123'));
  assert.ok(!redact('curl -H "Authorization: Bearer tok_abc"').includes('tok_abc'));
});

test('clip bounds ledger text', () => {
  assert.equal(clip('short', 400), 'short');
  const long = clip('x'.repeat(1000), 100);
  assert.ok(long.length < 200);
  assert.match(long, /\+900 chars/);
});

test('classifyCommand recognises the commands worth remembering', () => {
  assert.equal(classifyCommand('npm test'), 'test');
  assert.equal(classifyCommand('node --test test/'), 'test');
  assert.equal(classifyCommand('pytest -q'), 'test');
  assert.equal(classifyCommand('dotnet test'), 'test');
  assert.equal(classifyCommand('npm run build'), 'build');
  assert.equal(classifyCommand('cargo build --release'), 'build');
  assert.equal(classifyCommand('git commit -m x'), 'git');
  assert.equal(classifyCommand('ls -la'), 'other');
});

test('inferOk reads a verdict only when the output actually carries one', () => {
  assert.equal(inferOk('ℹ pass 55\nℹ fail 0'), true);
  assert.equal(inferOk('Tests: 3 failed, 2 passed'), false);
  assert.equal(inferOk('Traceback (most recent call last):'), false);
  assert.equal(inferOk('0 failures'), true);
  // Ambiguous output must not produce an invented verdict in a handoff.
  assert.equal(inferOk('some unrelated output'), null);
  assert.equal(inferOk(''), null);
});

test('a command event is redacted and classified before it reaches disk', () => {
  const ev = commandEvent('deploy --token=abcdef123456 --env prod', 'Done in 3s', 1000);
  assert.equal(ev.k, 'command');
  if (ev.k !== 'command') return;
  assert.ok(!ev.command.includes('abcdef123456'));
  assert.equal(ev.ok, true);
});

test('the ledger tolerates a truncated final line', () => {
  const dir = tmp();
  appendEvent(dir, 's1', { k: 'note', t: 1, field: 'objective', text: 'do the thing' });
  appendEvent(dir, 's1', { k: 'note', t: 2, field: 'next_action', text: 'next step' });
  // A process dying mid-append leaves exactly this.
  appendFileSync(ledgerPath(dir, 's1'), '{"k":"note","t":3,"fie');
  const events = readLedger(dir, 's1');
  assert.equal(events.length, 2);
  assert.equal(events[1]?.k, 'note');
});

test('an absent ledger reads as empty rather than throwing', () => {
  assert.deepEqual(readLedger(tmp(), 'nope'), []);
});

test('hashFile detects a change and survives a missing file', () => {
  const dir = tmp();
  const f = join(dir, 'a.txt');
  writeFileSync(f, 'one');
  const h1 = hashFile(f);
  assert.ok(h1.sha256);
  assert.equal(h1.bytes, 3);
  writeFileSync(f, 'two');
  assert.notEqual(hashFile(f).sha256, h1.sha256);
  assert.deepEqual(hashFile(join(dir, 'gone.txt')), { sha256: null, bytes: null });
});

// Regression: a bare `.claude` marker matched the user's OWN config directory, so any
// project living under the home directory wrote its state into ~/.claude/guardian.
test('resolveStateRoot never resolves a project to the home directory', () => {
  const underHome = join(homedir(), 'some', 'project', 'src');
  const root = resolveStateRoot(underHome);
  assert.notEqual(root.toLowerCase(), homedir().toLowerCase());
});

test('resolveStateRoot finds a repository root from a subdirectory', () => {
  const dir = tmp();
  mkdirSync(join(dir, '.git'), { recursive: true });
  const sub = join(dir, 'a', 'b', 'c');
  mkdirSync(sub, { recursive: true });
  assert.equal(resolveStateRoot(sub).toLowerCase(), realp(dir));
});

test('resolveStateRoot prefers an existing Guardian directory', () => {
  const dir = tmp();
  mkdirSync(join(dir, '.claude', 'guardian'), { recursive: true });
  const sub = join(dir, 'nested', 'deep');
  mkdirSync(sub, { recursive: true });
  assert.equal(resolveStateRoot(sub).toLowerCase(), realp(dir));
});

test('resolveStateRoot falls back to the starting directory when nothing marks a root', () => {
  const dir = tmp();
  assert.equal(resolveStateRoot(dir).toLowerCase(), realp(dir));
});

test('redact handles a name that is itself the keyword, and a multi-word header value', () => {
  // Both of these leaked before: the name pattern required a prefix, and the header value
  // pattern stopped at the first space, leaving the token behind.
  assert.equal(redact('export API_KEY=supersecret123'), 'export API_KEY=[REDACTED]');
  assert.equal(redact('token: abc def ghi'), 'token: [REDACTED]');
  assert.ok(!redact('curl -H "Authorization: Bearer tok_abc"').includes('tok_abc'));
  assert.ok(!redact('--password hunter2').includes('hunter2'));
});

test('the test baseline is the command, not the line it was buried in', () => {
  // A real capture: the whole compound line was stored as the session's test command, and
  // the resume protocol then told a fresh session to run it verbatim — including a global
  // install and a `resume` that consumes a manifest.
  assert.equal(
    testCommand('npm run check 2>&1 | grep -E "ok"; npm install -g . >/dev/null 2>&1; guardian resume'),
    'npm run check',
  );
  assert.equal(testCommand('npm test'), 'npm test');
  assert.equal(testCommand('npm test -- --grep auth | tee out.log'), 'npm test -- --grep auth');
  assert.equal(testCommand('cd x && pytest -q 2>&1 | tail -5'), 'pytest -q');
  assert.equal(testCommand('echo hi'), null);
});
