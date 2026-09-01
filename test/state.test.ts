import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { readState, writeState, emptyState } from '../src/core/state.ts';
import { statePath, configPath, sanitize } from '../src/core/paths.ts';
import { loadConfig, DEFAULT_CONFIG } from '../src/core/config.ts';
import { install, init, uninstall } from '../src/ui/install.ts';
import { validateConfig } from '../src/ui/configCmd.ts';

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

test('a sample budget too small for the window is rejected, not silently obeyed', () => {
  // The two settings are coupled: max_samples decides how far apart samples sit, so a
  // tiny budget spreads them past the window and no rate is ever measurable.
  const bad = validateConfig({ burn: { window_min: 30, max_samples: 3 } });
  const p = bad.find((x) => x.path === 'burn.max_samples');
  assert.ok(p, `expected a burn.max_samples problem, got ${JSON.stringify(bad)}`);
  assert.equal(p!.severity, 'error');

  assert.deepEqual(validateConfig({ burn: { window_min: 30 } }), []);
  assert.deepEqual(validateConfig({}), []);
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

test('init wires whichever settings file actually decides the status line', () => {
  const dir = tmp();
  // A project with its own status line: the user's is irrelevant here, because a project
  // `statusLine` replaces it outright rather than merging. Wiring the user file would
  // leave Guardian installed and blind in exactly this project.
  const projSettings = join(dir, '.claude', 'settings.json');
  mkdirSync(dirname(projSettings), { recursive: true });
  writeFileSync(projSettings, JSON.stringify({ statusLine: { type: 'command', command: 'repo-bar.cjs' } }));

  const r = init(dir, join(dir, 'user-settings.json'));
  assert.equal(r.scope, 'project-local');
  // Compared by suffix: the project dir comes back through realpath, which on Windows
  // turns the 8.3 temp path this test was handed into its long form.
  assert.ok(r.settingsFile.endsWith(join('.claude', 'settings.local.json')), r.settingsFile);
  assert.ok(r.displaced.endsWith(join('.claude', 'settings.json')), r.displaced);
  assert.equal(r.chained, 'repo-bar.cjs');

  // The shared file is left exactly as the repo had it: Guardian's command is an absolute
  // path to one machine's bundle and has no business in a committed settings file.
  assert.equal(JSON.parse(readFileSync(projSettings, 'utf8')).statusLine.command, 'repo-bar.cjs');
  const local = JSON.parse(readFileSync(join(dir, '.claude', 'settings.local.json'), 'utf8'));
  assert.match(local.statusLine.command, /guardian\.cjs/);
  assert.equal(loadConfig(dir).statusline.chained_command, 'repo-bar.cjs');

  // Idempotent, and re-running must not forget what it displaced the first time.
  const again = init(dir, join(dir, 'user-settings.json'));
  assert.equal(again.alreadySensing, true);
  assert.equal(loadConfig(dir).statusline.chained_command, 'repo-bar.cjs');
});

test('uninstall removes an override layer rather than copying the repo bar into it', () => {
  const dir = tmp();
  const projSettings = join(dir, '.claude', 'settings.json');
  const localSettings = join(dir, '.claude', 'settings.local.json');
  mkdirSync(dirname(projSettings), { recursive: true });
  writeFileSync(projSettings, JSON.stringify({ statusLine: { type: 'command', command: 'repo-bar.cjs' } }));

  init(dir, join(dir, 'user-settings.json'));
  uninstall(dir, localSettings);

  // Restoring `repo-bar.cjs` into settings.local.json would pin a personal copy above the
  // repo's own, and the day the shared one changes the stale copy silently keeps winning.
  const local = JSON.parse(readFileSync(localSettings, 'utf8'));
  assert.equal('statusLine' in local, false, JSON.stringify(local));
  assert.equal('subagentStatusLine' in local, false);
  // And the repo's file is what decides again, untouched throughout.
  assert.equal(JSON.parse(readFileSync(projSettings, 'utf8')).statusLine.command, 'repo-bar.cjs');
});

test('init on a project with no settings of its own leaves the user file deciding', () => {
  const dir = tmp();
  const userSettings = join(dir, 'user-settings.json');
  const r = init(dir, userSettings);
  assert.equal(r.scope, 'user');
  assert.match(JSON.parse(readFileSync(userSettings, 'utf8')).statusLine.command, /guardian\.cjs/);
  // It must not invent a project settings file: that would pin one machine's absolute
  // paths into a repo other people share.
  assert.equal(existsSync(join(dir, '.claude', 'settings.json')), false);
  assert.equal(existsSync(configPath(dir)), true);
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
