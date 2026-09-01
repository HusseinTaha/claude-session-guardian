/** Guardian records the commands a session ran, and those commands contain credentials.
 *  The manifest is local and gitignored, but "local" is not a licence to store secrets in
 *  plain text: the digest gets injected back into a context window, and context windows
 *  end up in transcripts.
 *
 *  Deliberately over-eager. Redacting too much costs a little readability; redacting too
 *  little writes a live token to disk. */

/** Identifiers that mark a value as secret, wherever they appear in the name. */
const SECRET_NAME =
  '[A-Za-z0-9_-]*(?:token|secret|password|passwd|pwd|apikey|api[_-]?key|auth|credential|private[_-]?key|access[_-]?key)[A-Za-z0-9_-]*';

/** Header names whose entire value is sensitive. */
const SECRET_HEADER = 'Authorization|Proxy-Authorization|X-Api-Key|X-Auth-Token|Cookie|Set-Cookie';

const RULES: Array<[RegExp, string]> = [
  // 1. Known-shape tokens. Unambiguous on sight, so they go first and match anywhere.
  [/sk-ant-[A-Za-z0-9_-]{8,}/g, 'sk-ant-[REDACTED]'],
  [/sk-[A-Za-z0-9]{20,}/g, 'sk-[REDACTED]'],
  [/gh[pousr]_[A-Za-z0-9]{16,}/g, 'gh_[REDACTED]'],
  [/github_pat_[A-Za-z0-9_]{20,}/g, 'github_pat_[REDACTED]'],
  [/xox[abposr]-[A-Za-z0-9-]{10,}/g, 'xox-[REDACTED]'],
  [/AKIA[0-9A-Z]{16}/g, 'AKIA[REDACTED]'],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, '[REDACTED-JWT]'],
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    '[REDACTED-PRIVATE-KEY]',
  ],

  // 2. Colon form: `Authorization: Bearer xyz`, `api_token: xyz`. The value runs to the
  //    end of the line or the enclosing quote — stopping at the first space would leave
  //    the token itself in place, which is the whole point of the rule.
  [new RegExp(`\\b(${SECRET_HEADER}|${SECRET_NAME})(\\s*:\\s*)([^\\n"']+)`, 'gi'), '$1$2[REDACTED]'],

  // 3. Assignment form: `API_KEY=xyz`, `--token xyz`, `DB_PASSWORD="xyz"`. Separate from
  //    the colon form so neither mangles the other's separator.
  [
    new RegExp(`\\b(${SECRET_NAME})(\\s*=\\s*)("[^"]*"|'[^']*'|\\S+)`, 'gi'),
    '$1$2[REDACTED]',
  ],
  [
    new RegExp(`(--(?:${SECRET_NAME}))(\\s+)("[^"]*"|'[^']*'|[^-\\s]\\S*)`, 'gi'),
    '$1$2[REDACTED]',
  ],

  // 4. Credentials embedded in a URL.
  [/([a-z][a-z0-9+.-]*:\/\/)([^:/@\s]+):([^@\s]+)@/gi, '$1$2:[REDACTED]@'],
];

export function redact(text: string): string {
  if (!text) return text;
  let out = text;
  for (const [re, sub] of RULES) out = out.replace(re, sub);
  return out;
}

/** Ledger entries are for orientation, not forensics. Long output is worthless in a
 *  digest and expensive in a context window. */
export function clip(text: string, max = 400): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… (+${text.length - max} chars)`;
}
