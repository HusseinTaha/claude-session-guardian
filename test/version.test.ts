import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../src/version.ts';

const read = (p: string): { version: string } =>
  JSON.parse(readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8'));

// `guardian version` answered 0.5.0 while both manifests said 0.7.1. Three places holding
// one number is fine; three places nobody compares is how they drift two minors apart.
test('the reported version matches both manifests', () => {
  assert.equal(VERSION, read('../package.json').version, 'package.json disagrees');
  assert.equal(VERSION, read('../.claude-plugin/plugin.json').version, 'plugin.json disagrees');
});
