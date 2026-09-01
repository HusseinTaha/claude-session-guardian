import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { readState, writeState, emptyState } from '../src/state.ts';
import { statePath, configPath, sanitize } from '../src/paths.ts';
import { loadConfig, DEFAULT_CONFIG } from '../src/config.ts';
import { install, uninstall } from '../src/install.ts';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'guardian-test-'));
}

test('Infinity survives the round trip instead of collapsing to null', () => {
  const dir = tmp();
  const st = emptyState('s1');
  st.axes.five_hour = {
    used_pct: 97,
    burn_pct_per_min: 1,
    resets_at: 123,
    time_to_wall_min: Infinity,
    mode: 'NORMAL',
  };
  writeState(dir, st);
  const back = readState(dir, 's1');
  assert.equal(back.axes.five_hour?.time_to_wall_min, Infinity);
  // And it is not silently stored as JSON null, which would read as "unknown".
  assert.doesNotMatch(readFileSync(statePath(dir, 's1'), 'utf8'), /"time_to_wall_min": null/);
});

test('a corrupt state file is indistinguishable from no state file', () => {
  const dir = tmp();
  const p = statePath(dir, 's1');
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, '{ this is not json');
  const st = readState(dir, 's1');
  assert.equal(st.mode, 'NORMAL');
  assert.equal(st.schema, 1);
});

test('a state file from a future schema is discarded rather than misread', () => {
  const dir = tmp();
  const p = statePath(dir, 's1');
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ schema: 99, mode: 'EMERGENCY' }));
  assert.equal(readState(dir, 's1').mode, 'NORMAL');
});

test('two sessions sharing a directory do not clobber each other', () => {
  const dir = tmp();
  writeState(dir, { ...emptyState('sessA'), mode: 'LAND' });
  writeState(dir, { ...emptyState('sessB'), mode: 'WATCH' });
  assert.equal(readState(dir, 'sessA').mode, 'LAND');
  assert.equal(readState(dir, 'sessB').mode, 'WATCH');
});

test('session ids never escape the state directory', () => {
  assert.equal(sanitize('../../etc/passwd'), '.._.._etc_passwd');
  assert.equal(sanitize(''), 'unknown');
});

test('config merges one level deep over the defaults', () => {
  const dir = tmp();
  mkdirSync(dirname(configPath(dir)), { recursive: true });
  writeFileSync(configPath(dir), JSON.stringify({ thresholds_minutes: { land: 9 } }));
  const cfg = loadConfig(dir);
  assert.equal(cfg.thresholds_minutes.land, 9);
  assert.equal(cfg.thresholds_minutes.watch, DEFAULT_CONFIG.thresholds_minutes.watch);
  assert.equal(cfg.enabled, true);
});

test('a corrupt config falls back to defaults rather than disabling the guard', () => {
  const dir = tmp();
  mkdirSync(dirname(configPath(dir)), { recursive: true });
  writeFileSync(configPath(dir), 'not json');
  assert.deepEqual(loadConfig(dir), DEFAULT_CONFIG);
});

test('install chains an existing status line rather than replacing it', () => {
  const dir = tmp();
  const settings = join(dir, 'settings.json');
  writeFileSync(settings, JSON.stringify({ statusLine: { type: 'command', command: 'my-bar.sh' } }));

  const r = install(dir, settings);
  assert.equal(r.chained, 'my-bar.sh');
  const after = JSON.parse(readFileSync(settings, 'utf8'));
  assert.match(after.statusLine.command, /guardian\.cjs/);
  assert.equal(after.statusLine.refreshInterval, 10);
  assert.equal(loadConfig(dir).statusline.chained_command, 'my-bar.sh');

  // Idempotent: installing twice must not chain Guardian to itself.
  const again = install(dir, settings);
  assert.equal(again.alreadyInstalled, true);
  assert.equal(loadConfig(dir).statusline.chained_command, 'my-bar.sh');

  assert.equal(uninstall(dir, settings), 'my-bar.sh');
  assert.equal(JSON.parse(readFileSync(settings, 'utf8')).statusLine.command, 'my-bar.sh');
});

test('install preserves unrelated settings and uninstall leaves none of its own', () => {
  const dir = tmp();
  const settings = join(dir, 'settings.json');
  writeFileSync(settings, JSON.stringify({ theme: 'dark', permissions: { allow: ['Bash'] } }));
  install(dir, settings);
  uninstall(dir, settings);
  const after = JSON.parse(readFileSync(settings, 'utf8'));
  assert.equal(after.theme, 'dark');
  assert.deepEqual(after.permissions.allow, ['Bash']);
  assert.equal('statusLine' in after, false);
});

test('the state directory ignores itself, since manifests hold prompts and paths', () => {
  const dir = tmp();
  install(dir, join(dir, 'settings.json'));
  assert.equal(readFileSync(join(dir, '.claude', 'guardian', '.gitignore'), 'utf8').trim(), '*');
});
