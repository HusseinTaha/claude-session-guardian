#!/usr/bin/env node
/**
 * The folders under src/ claim an architecture: sensors write state, actuators read it,
 * and everything sits on a small core. A claim nobody checks quietly stops being true, so
 * this asserts that imports only ever point downward.
 *
 * Run via `npm run layers`, and as part of `npm run check`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative, normalize, sep } from 'node:path';

/** Lower may not import higher. `src` is the root, holding only types.ts and cli.ts. */
const LAYERS = {
  src: 0,
  core: 1, // paths, config, state, sessions, log
  budget: 2, // burn-rate estimation and the time-to-wall state machines
  format: 3, // pure presentation of budget numbers
  handoff: 4, // ledger, manifest, git checkpoints, redaction
  sensors: 5, // statusLine + subagentStatusLine: they write state, never block
  actuators: 6, // hooks: they read pre-computed state and act
  ui: 7, // install, config command, doctor, mcp
};

/** cli.ts is the entry point and wires everything together, so it is exempt. */
const EXEMPT = new Set(['src/cli.ts']);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (entry.endsWith('.ts')) out.push(p);
  }
  return out;
}

const posix = (p) => p.split(sep).join('/');
const layerOf = (file) => {
  const parts = posix(file).split('/');
  return parts.length > 2 ? parts[1] : 'src';
};

const files = walk('src');
const violations = [];
const unknown = new Set();

for (const file of files) {
  const from = layerOf(file);
  if (EXEMPT.has(posix(file))) continue;
  if (!(from in LAYERS)) unknown.add(from);

  const src = readFileSync(file, 'utf8');
  for (const match of src.matchAll(/['"](\.[^'"]*\.ts)['"]/g)) {
    const target = posix(normalize(join(dirname(file), match[1])));
    const to = layerOf(target);
    if (!(to in LAYERS)) unknown.add(to);
    if (from === to) continue;
    if (LAYERS[from] < LAYERS[to]) {
      violations.push(`${posix(file)} (${from}) imports ${target} (${to})`);
    }
  }
}

if (unknown.size) {
  console.error(`Unknown layer(s): ${[...unknown].join(', ')}`);
  console.error('Add them to LAYERS in scripts/check-layers.mjs, in dependency order.');
  process.exit(1);
}

if (violations.length) {
  console.error('Layering violations — a lower layer must not import a higher one:\n');
  for (const v of violations) console.error(`  ${v}`);
  console.error('\nEither move the module down, or invert the dependency.');
  process.exit(1);
}

console.log(`layers ok — ${files.length} files, ${Object.keys(LAYERS).length} layers, imports point downward`);
