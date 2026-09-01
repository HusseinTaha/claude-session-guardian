import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from './paths.ts';

/** Most recent session in this project, for commands invoked outside a hook where no
 *  session id is on hand.
 *
 *  Considers ledgers and agent files as well as state files: hooks create a ledger from the
 *  first tool call, while the state file only appears once the status line has run. The
 *  suffix list is longest-first so `<id>.agents.json` is not read as a session called
 *  `<id>.agents`. */
export function latestSessionIn(projectDir: string): string | null {
  const SUFFIXES = ['.ledger.jsonl', '.agents.json', '.json'];
  try {
    const dir = join(stateDir(projectDir), 'sessions');
    const seen = new Map<string, number>();
    for (const f of readdirSync(dir)) {
      const suffix = SUFFIXES.find((x) => f.endsWith(x));
      if (!suffix) continue;
      const sid = f.slice(0, -suffix.length);
      if (!sid) continue;
      seen.set(sid, Math.max(seen.get(sid) ?? 0, statSync(join(dir, f)).mtimeMs));
    }
    return [...seen.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  } catch {
    return null;
  }
}
