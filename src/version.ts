/** The single source of truth for the version this bundle reports.
 *
 *  `guardian version` used to carry its own string literal, and it drifted: it answered
 *  0.5.0 while package.json and the plugin manifest both said 0.7.1. A number nobody
 *  checks quietly stops being true, so `test/version.test.ts` pins all three together.
 *  Bump this, package.json and .claude-plugin/plugin.json in the same commit. */
export const VERSION = '0.7.8';
