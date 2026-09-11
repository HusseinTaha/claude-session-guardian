/**
 * Stage the plugin payload into build/plugin/.
 *
 * A plugin marketplace whose source is the working directory installs the working
 * directory — all of it. Not just the tracked files: `.mcp.json`, `.claude/`, `node_modules/`
 * and every scratch file come too, and Claude Code reads what it finds. A `.mcp.json` sitting
 * in a checkout for local development therefore becomes an MCP server the plugin declares,
 * enabled in every project of everyone who installs it. That is a supply-chain accident, not
 * a feature.
 *
 * Installing from git instead would carry only tracked files, which sounds like the fix until
 * you notice `dist/` is gitignored and the commands run `${CLAUDE_PLUGIN_ROOT}/dist/guardian.cjs`.
 * The plugin needs a built bundle that source control does not carry.
 *
 * So the source is neither: it is a directory built to contain exactly the payload, and
 * nothing else can end up in it because nothing else is copied in.
 */
import { cpSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'build', 'plugin');

/** Everything the plugin manifest references, and nothing that merely happens to be here. */
const PAYLOAD = [
  // Only the plugin manifest, never the marketplace one: marketplace.json belongs at the
  // marketplace root and points *here*, so a copy inside the payload is self-referential
  // and names a path that cannot exist at this level.
  '.claude-plugin/plugin.json',
  'commands',
  'hooks',
  'skills',
  'dist',
  'README.md',
  'LICENSE',
];

if (!existsSync(join(root, 'dist', 'guardian.cjs'))) {
  console.error('no dist/guardian.cjs — run `npm run build` first');
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const staged = [];
for (const entry of PAYLOAD) {
  const from = join(root, entry);
  if (!existsSync(from)) continue;
  cpSync(from, join(out, entry), { recursive: true });
  staged.push(entry);
}

// The marketplace manifest has to sit at the marketplace root, which is the repo, and point
// here. The plugin manifest is what travels, so assert the staged tree is self-contained.
const missing = ['.claude-plugin/plugin.json', 'dist/guardian.cjs'].filter(
  (p) => !existsSync(join(out, ...p.split('/'))),
);
if (missing.length) {
  console.error(`staged tree is incomplete: ${missing.join(', ')}`);
  process.exit(1);
}

console.log(`staged ${staged.length} entries into build/plugin/`);
console.log(`  ${readdirSync(out).join('  ')}`);
