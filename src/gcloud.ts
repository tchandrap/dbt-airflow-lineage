import { spawn } from 'child_process';

/** Helpers for talking to the Google Cloud CLI. VS Code-free so the error handling can be unit tested. */

export interface RunResult { code: number | string; out: string; err: string }

/** Run a CLI without a shell (arguments are never interpreted). `code` is a string such as 'ENOENT' if it could not start. */
export function runCli(cmd: string, args: string[], onData?: (chunk: string) => void): Promise<RunResult> {
  return new Promise((resolve) => {
    let out = '', err = '';
    const c = spawn(cmd, args, { shell: false });
    c.stdout.on('data', (d) => { const s = String(d); out += s; onData?.(s); });
    c.stderr.on('data', (d) => { const s = String(d); err += s; onData?.(s); });
    c.on('error', (e: any) => resolve({ code: e.code ?? 'ERR', out, err: err || String(e.message) }));
    c.on('close', (code) => resolve({ code: code ?? 1, out, err }));
  });
}

export const GCS_RE = /^gs:\/\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._\/-]*)?$/;
export const normalizeGcs = (p: string) => p.trim().replace(/\/+$/, '');
export const isValidGcsPath = (p: string) => GCS_RE.test(normalizeGcs(p));

export type GcloudProblem = 'missing-cli' | 'crash' | 'auth' | 'forbidden' | 'not-found' | 'other';

/** Turns gcloud / gsutil failures into something the UI can act on (log in, fix the path, install the CLI…). */
export function classifyGcloudError(r: Pick<RunResult, 'code' | 'err' | 'out'>): GcloudProblem {
  if (r.code === 0) return 'other';
  if (r.code === 'ENOENT') return 'missing-cli';
  const t = `${r.err}\n${r.out}`;
  // gcloud's own error reporting crashing (it hides the real cause): not the user's fault, retry with gsutil
  if (/gcloud crashed|Traceback \(most recent call last\)/i.test(t)) return 'crash';
  if (/Reauthentication (failed|required)|cannot prompt during non-interactive|invalid_grant|gcloud auth login|do not currently have an active account|no active account|credentials? (have|has)? ?(expired|been revoked)|refreshing your current auth tokens|\b401\b/i.test(t)) return 'auth';
  if (/\b403\b|AccessDenied|does not have .*permission|permission .* denied|forbidden/i.test(t)) return 'forbidden';
  if (/\b404\b|NotFound|BucketNotFound|matched no objects|no such object|does not exist/i.test(t)) return 'not-found';
  return 'other';
}

/** `gcloud storage ls` output → entries; folders end with `/`. */
export function parseLs(out: string): { folders: string[]; files: string[] } {
  const lines = out.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('gs://'));
  return { folders: lines.filter((l) => l.endsWith('/')), files: lines.filter((l) => !l.endsWith('/')) };
}

export const parentGcs = (p: string): string | null => {
  const n = normalizeGcs(p);
  const m = /^(gs:\/\/[^/]+)(?:\/(.*))?$/.exec(n);
  if (!m || !m[2]) return null;
  const parts = m[2].split('/');
  parts.pop();
  return parts.length ? `${m[1]}/${parts.join('/')}` : m[1];
};

export const shortError = (r: Pick<RunResult, 'err' | 'out'>) =>
  (r.err || r.out).trim().split('\n').map((l) => l.trim()).filter((l) => l && !/^(Please run|\$ gcloud|to obtain|to select|If you have)/.test(l)).slice(-2).join(' ').slice(0, 300);

/**
 * Regexes (Python syntax, matched against the path relative to the synced folder) for files the extension never reads.
 * It only parses DAG source code, so everything that is not a .py file is skipped, as are test and cache folders.
 */
export const DEFAULT_SYNC_EXCLUDE = ['^(?!.*\\.py$).*', '^(.*/)?(tests?|__pycache__)/.*'];

/** Joins exclude patterns into the single regex `--exclude` / `-x` takes. gcloud splits list values on commas, so commas are rejected. */
export function buildExcludeRegex(patterns: string[]): string {
  const clean = patterns.map((p) => p.trim()).filter(Boolean);
  for (const p of clean) {
    if (p.includes(',')) throw new Error(`Exclude pattern "${p}" contains a comma, which gcloud treats as a list separator. Use {1,3}-style ranges via alternation instead.`);
    try { new RegExp(p); } catch (e: any) { throw new Error(`Exclude pattern "${p}" is not a valid regular expression: ${e.message}`); }
  }
  return clean.map((p) => `(?:${p})`).join('|');
}

/** The Google sign-in link `gcloud auth login` prints (it also prints it when it opened a browser itself). */
export const findAuthUrl = (text: string): string | undefined => /https:\/\/accounts\.google\.com\/[^\s"'<>]+/.exec(text)?.[0];

/**
 * Environment for `gcloud auth login` run by the extension: `BROWSER=true` makes gcloud skip launching a browser (it just
 * prints the link), so the extension can open the link itself with the editor's own opener. Windows keeps gcloud's default.
 */
export const authLoginEnv = (env: NodeJS.ProcessEnv, platform: string = process.platform): NodeJS.ProcessEnv => (platform === 'win32' ? env : { ...env, BROWSER: 'true' });
