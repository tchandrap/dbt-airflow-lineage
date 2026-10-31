import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { fork, spawn } from 'child_process';
import { authLoginEnv, buildExcludeRegex, classifyGcloudError, findAuthUrl, DEFAULT_SYNC_EXCLUDE, isValidGcsPath, normalizeGcs, parentGcs, parseLs, runCli, RunResult, shortError } from './gcloud';
import { LineageIndex, ResolvedPipeline, scanAirflow } from './index';
import { applyEdits, readMeta, Edits, MetaError, Target } from './meta';
import { buildPayload, defaultFilter, FilterState } from './payload';
import { legacyReportEntry, ReportConfig, reportMatch, reportsConfigured, runTool, TOOLS } from './tools';
import { claudeCodeCommand, claudeDesktopConfigPath, codexToml, jsonEntry, mergeClaudeDesktopConfig, McpServerSpec } from './mcp/clients';
import type { Graph } from './types';

let ctx: vscode.ExtensionContext;
let index: LineageIndex | undefined;
let projectDir = '';
let loading: Promise<void> | undefined;
let view: vscode.WebviewView | undefined;
let focusId: string | undefined;
const out = vscode.window.createOutputChannel('dbt airflow lineage');
const changed = new vscode.EventEmitter<void>();

const cfg = () => vscode.workspace.getConfiguration('dbtAirflow');

async function findProjectDir(): Promise<string | undefined> {
  const set = cfg().get<string>('projectDir');
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (set) return path.isAbsolute(set) ? set : root && path.join(root, set);
  const hits = await vscode.workspace.findFiles('**/dbt_project.yml', '**/{dbt_packages,node_modules,target}/**', 5);
  return hits.length ? path.dirname(hits[0].fsPath) : undefined;
}

function cachePathFor(manifest: string): string {
  const stat = fs.statSync(manifest);
  const key = crypto.createHash('md5').update(`v3:${manifest}:${stat.mtimeMs}:${stat.size}`).digest('hex');
  fs.mkdirSync(ctx.globalStorageUri.fsPath, { recursive: true });
  return path.join(ctx.globalStorageUri.fsPath, `graph-${key}.json`);
}

let graphCachePath: string | undefined;
let manifestFile: string | undefined;

function slimManifest(manifest: string): Promise<Graph> {
  manifestFile = manifest;
  const cache = cachePathFor(manifest);
  const stat = fs.statSync(manifest);
  graphCachePath = cache;
  if (fs.existsSync(cache)) return Promise.resolve(JSON.parse(fs.readFileSync(cache, 'utf8')));
  for (const f of fs.readdirSync(ctx.globalStorageUri.fsPath)) if (f.startsWith('graph-')) fs.rmSync(path.join(ctx.globalStorageUri.fsPath, f), { force: true });
  return new Promise((resolve, reject) => {
    const child = fork(ctx.asAbsolutePath('dist/slimWorker.js'), [manifest, cache], { execArgv: ['--max-old-space-size=6144'] });
    child.on('message', (m: any) => (m.ok ? resolve(JSON.parse(fs.readFileSync(cache, 'utf8'))) : reject(new Error(m.error))));
    child.on('error', reject);
    child.on('exit', (c) => c && reject(new Error(`manifest worker exited with ${c} (manifest too large for memory?)`)));
  });
}

// ---------------------------------------------------------------- Airflow source: none | local folder(s) | GCS bucket
const DEFAULT_BUCKET = '';
const CACHE_MARKER = '.dbt-airflow-lineage-cache';
type AirflowSource = 'none' | 'local' | 'gcs';

function airflowSource(): AirflowSource {
  const v = cfg().get<string>('airflowSource', 'auto');
  if (v === 'none' || v === 'local' || v === 'gcs') return v;
  return cfg().get<string[]>('airflowPaths', []).length ? 'local' : 'none'; // auto: honour existing setups
}
const configTarget = () => (vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);

/** Root of everything we own on disk for GCS: the marker lives here, the mirrored files live in `<root>/dags`. */
function dagsCacheRoot(): string {
  const custom = cfg().get<string>('dagsDownloadDir', '').trim();
  return custom ? path.join(custom, 'airflow-dags-cache') : path.join(ctx.globalStorageUri.fsPath, 'airflow-dags-cache');
}
/** The folder rsync mirrors into (and the only one that is scanned). Kept apart from the marker so pruning cannot delete it. */
const dagsCacheDir = () => path.join(dagsCacheRoot(), 'dags');

function airflowDirs(): string[] {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  const src = airflowSource();
  if (src === 'local') return cfg().get<string[]>('airflowPaths', []).map((p) => (path.isAbsolute(p) ? p : path.join(root, p)));
  if (src === 'gcs') return fs.existsSync(dagsCacheDir()) ? [dagsCacheDir()] : [];
  return [];
}

const syncInfo = (state: 'idle' | 'running' | 'done' | 'error', text = '') => ({
  type: 'sync', state, text, source: airflowSource(), at: ctx.globalState.get<number>('dagsSyncedAt') ?? null,
});
const postSync = (state: 'running' | 'done' | 'error', text = '') => view?.webview.postMessage(syncInfo(state, text));

/** Run gcloud; on an expired/missing login offer to sign in (in a real terminal, since gcloud must prompt) and retry. */
async function gcloud(args: string[], opts: { quiet?: boolean; onData?: (s: string) => void } = {}): Promise<RunResult> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await runCli('gcloud', args, (s) => { out.append(s); opts.onData?.(s); });
    if (r.code === 0) return r;
    const problem = classifyGcloudError(r);
    if (problem === 'missing-cli') {
      vscode.window.showErrorMessage('The Google Cloud CLI (gcloud) was not found.', 'Install guide').then((c) => c && vscode.env.openExternal(vscode.Uri.parse('https://cloud.google.com/sdk/docs/install')));
      return r;
    }
    if (problem !== 'auth' || opts.quiet) return r;
    const choice = await vscode.window.showWarningMessage('Your Google Cloud sign-in is missing or expired.', { modal: true, detail: 'A Google sign-in page will open in your browser. This only refreshes your own credentials.' }, 'Sign in with gcloud', 'Use another account…');
    if (!choice) return r;
    const ok = choice === 'Sign in with gcloud' ? await signInViaTerminal() : await switchAccount();
    if (!ok) return r;
  }
  return runCli('gcloud', args);
}

/** `gcloud auth login` run by the extension: the sign-in link is opened with the editor's own opener, so no terminal or browser launch from gcloud is needed. */
async function signInViaTerminal(): Promise<boolean> {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Signing in to Google Cloud: finish in your browser…', cancellable: true }, (progress, token) => new Promise<boolean>((resolveSignIn) => {
    progress.report({ message: 'Step 1 of 2: starting gcloud…' });
    const c = spawn('gcloud', ['auth', 'login', '--brief'], { shell: false, env: authLoginEnv(process.env) });
    let buf = '', url: string | undefined, done = false;
    const finish = (ok: boolean) => { if (!done) { done = true; resolveSignIn(ok); } };
    const onData = (d: unknown) => {
      const s = String(d);
      out.append(s); buf += s;
      if (!url && (url = findAuthUrl(buf))) {
        void vscode.env.openExternal(vscode.Uri.parse(url));
        progress.report({ message: 'Step 2 of 2: waiting for you to finish signing in in your browser…', increment: 50 });
        vscode.window.showInformationMessage('A Google sign-in page was opened in your browser.', 'Open it again').then((a) => { if (a && url) void vscode.env.openExternal(vscode.Uri.parse(url)); });
      }
    };
    c.stdout.on('data', onData); c.stderr.on('data', onData);
    c.on('error', (e: any) => { vscode.window.showErrorMessage(e.code === 'ENOENT' ? 'The Google Cloud CLI (gcloud) was not found.' : `Could not start gcloud: ${e.message}`); finish(false); });
    c.on('close', (code) => {
      if (code !== 0 && !done) vscode.window.showErrorMessage(`Google Cloud sign-in did not finish (${shortError({ err: buf, out: '' }) || `exit ${code}`}).`);
      finish(code === 0);
    });
    token.onCancellationRequested(() => { c.kill(); finish(false); });
  }));
}

async function switchAccount(): Promise<boolean> {
  const r = await runCli('gcloud', ['auth', 'list', '--format=value(account)']);
  const accounts = r.out.split('\n').map((a) => a.trim()).filter(Boolean);
  const pick = await vscode.window.showQuickPick([...accounts.map((a) => ({ label: `$(account) ${a}`, account: a })), { label: '$(add) Sign in with another account…', account: '' }], { placeHolder: 'Which Google account should be used?' });
  if (!pick) return false;
  if (!pick.account) return signInViaTerminal();
  const s = await runCli('gcloud', ['config', 'set', 'account', pick.account]);
  if (s.code !== 0) { vscode.window.showErrorMessage(`Could not switch account: ${shortError(s)}`); return false; }
  return true;
}

/** Mirrors the DAG bucket into a private cache folder (only that folder is ever written / pruned). */
async function syncDags() {
  if (syncing) return;
  if (airflowSource() !== 'gcs') {
    const c = await vscode.window.showInformationMessage('Airflow pipelines are not set to come from GCS.', 'Set up Airflow…');
    if (c) await setupAirflow();
    return;
  }
  const bucket = normalizeGcs(cfg().get<string>('dagsBucket', DEFAULT_BUCKET));
  if (!isValidGcsPath(bucket)) {
    vscode.window.showErrorMessage(`"${bucket}" is not a valid gs:// path.`, 'Fix it…').then((c) => c && setupAirflow());
    return postSync('error', 'Invalid bucket path');
  }
  const root = dagsCacheRoot();
  const dest = dagsCacheDir();
  const markerPath = path.join(root, CACHE_MARKER);
  const rootIsOurs = !fs.existsSync(root) || fs.readdirSync(root).length === 0 || fs.existsSync(markerPath);
  fs.mkdirSync(dest, { recursive: true });
  if (rootIsOurs && !fs.existsSync(markerPath)) fs.writeFileSync(markerPath, 'Managed by the dbt airflow lineage extension. Files in ./dags are mirrored from GCS and may be deleted on sync.\n');
  const prune = fs.existsSync(markerPath); // never delete in a folder we did not create
  let exclude = '';
  try { exclude = buildExcludeRegex(cfg().get<string[]>('dagsSyncExclude', DEFAULT_SYNC_EXCLUDE)); }
  catch (e: any) { vscode.window.showErrorMessage(`dbtAirflow.dagsSyncExclude: ${e.message}`); return postSync('error', 'Invalid exclude pattern'); }
  syncing = true;
  postSync('running', `Syncing ${bucket}…`);
  out.appendLine(`Syncing ${bucket} → ${dest}${prune ? '' : ' (no pruning: folder was not created by this extension)'}${exclude ? `\nOnly copying files not matching: ${exclude}` : ''}`);
  try {
    const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Syncing Airflow DAGs from GCS…' }, async (progress) => {
      let copied = 0;
      progress.report({ message: 'Step 1 of 2: connecting to the bucket and listing the DAG files…' });
      const onData = (t: string) => { const n = (t.match(/^Copying /gm) ?? []).length; if (n) { copied += n; progress.report({ message: `Step 1 of 2: downloading DAG files (${copied} copied)…` }); setBusyText(`Downloading DAG files (${copied} copied)…`); } };
      const args = ['storage', 'rsync', '--recursive', ...(prune ? ['--delete-unmatched-destination-objects'] : []), ...(exclude ? [`--exclude=${exclude}`] : []), bucket, dest];
      let res = await gcloud(args, { onData });
      const gsutilArgs = ['-m', 'rsync', '-r', ...(prune ? ['-d'] : []), ...(exclude ? ['-x', exclude] : []), bucket, dest];
      if (res.code === 'ENOENT') res = await runCli('gsutil', gsutilArgs, (t) => { out.append(t); onData(t); });
      else if (res.code !== 0 && classifyGcloudError(res) === 'crash') {
        // gcloud's own error handling crashed and hides the real cause: gsutil usually reports it, or just works
        out.appendLine('\ngcloud crashed; retrying with gsutil…');
        const alt = await runCli('gsutil', gsutilArgs, (t) => { out.append(t); onData(t); });
        if (alt.code !== 'ENOENT') res = alt;
      }
      progress.report({ message: `Step 2 of 2: ${copied} DAG file${copied === 1 ? '' : 's'} downloaded, now rebuilding the lineage…`, increment: 60 });
      return res;
    });
    if (r.code !== 0) {
      const p = classifyGcloudError(r);
      const why = p === 'forbidden' ? 'Your account cannot read this bucket.' : p === 'not-found' ? 'The bucket or folder was not found.' : p === 'auth' ? 'Not signed in.'
        : p === 'crash' ? 'gcloud crashed while downloading (a gcloud bug that hides the real error). Try `gcloud components update`, install gsutil, or narrow the path.' : '';
      throw Object.assign(new Error(`${why} ${p === 'crash' ? '' : shortError(r) || 'sync failed'}`.trim()), { problem: p });
    }
    await ctx.globalState.update('dagsSyncedAt', Date.now());
    loading = undefined;
    const fresh2 = await ensure();
    changed.fire();
    const n = fresh2?.pipelines.length ?? 0;
    post();
    postSync('done', `${n} pipelines`);
    vscode.window.showInformationMessage(`Airflow DAGs synced — ${n} pipelines indexed.`);
  } catch (e: any) {
    out.appendLine(String(e?.message ?? e));
    postSync('error', String(e?.message ?? e));
    const buttons = e.problem === 'auth' ? ['Sign in with gcloud', 'Show output'] : e.problem === 'not-found' || e.problem === 'forbidden' ? ['Change path…', 'Show output'] : ['Set up Airflow…', 'Show output'];
    vscode.window.showErrorMessage(`DAG sync failed: ${e.message}`, ...buttons).then(async (c) => {
      if (c === 'Show output') out.show();
      else if (c === 'Sign in with gcloud') { if (await signInViaTerminal()) void syncDags(); } // retry once signed in
      else if (c) void setupAirflow();
    });
  } finally { syncing = false; }
}
let syncing = false;

// ---------------------------------------------------------------- setup wizard
async function setupAirflow() {
  const current = airflowSource();
  const pick = await vscode.window.showQuickPick([
    { label: '$(folder) Local folder', description: current === 'local' ? 'current' : '', detail: 'Read DAGs that are already on this machine (e.g. a checkout of the Airflow repo).', id: 'local' },
    { label: '$(cloud-download) Google Cloud Storage', description: current === 'gcs' ? 'current' : '', detail: 'Mirror the DAGs from a bucket with gcloud. Handy for always-fresh production DAGs.', id: 'gcs' },
    { label: '$(circle-slash) Not now', description: current === 'none' ? 'current' : '', detail: 'Show lineage without Airflow pipelines. You can set this up any time.', id: 'none' },
  ], { title: 'Where should Airflow pipelines come from?', placeHolder: 'Airflow pipelines are optional' });
  if (!pick) return;
  if (pick.id === 'none') { await cfg().update('airflowSource', 'none', configTarget()); return reloadAll(); }
  if (pick.id === 'local') return setupLocal();
  return setupGcs();
}

async function setupLocal() {
  const existing = cfg().get<string[]>('airflowPaths', []);
  const folders = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: true, openLabel: 'Use as Airflow DAGs folder', title: 'Pick the folder(s) that contain your Airflow DAG code',
    defaultUri: existing[0] ? vscode.Uri.file(path.isAbsolute(existing[0]) ? existing[0] : path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '', existing[0])) : undefined });
  if (!folders?.length) return;
  await cfg().update('airflowPaths', folders.map((f) => f.fsPath), configTarget());
  await cfg().update('airflowSource', 'local', configTarget());
  reloadAll();
}

/** Browse buckets / folders with gcloud so nobody has to type a gs:// path from memory. Returns the chosen path or undefined. */
async function browseGcs(start?: string): Promise<string | undefined> {
  let cur = start && isValidGcsPath(start) ? normalizeGcs(start) : '';
  for (;;) {
    let items: (vscode.QuickPickItem & { go?: string; use?: boolean; up?: boolean; typed?: boolean })[] = [];
    if (!cur) {
      const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Listing buckets…' }, () => gcloud(['storage', 'buckets', 'list', '--format=value(name)']));
      if (r.code !== 0) { vscode.window.showWarningMessage(`Could not list buckets (${shortError(r) || 'no access'}). Type the path instead.`); return undefined; }
      items = r.out.split('\n').map((b) => b.trim()).filter(Boolean).map((b) => ({ label: `$(database) ${b}`, go: `gs://${b}` }));
    } else {
      const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Listing ${cur}…` }, () => gcloud(['storage', 'ls', `${cur}/`]));
      if (r.code !== 0) { vscode.window.showWarningMessage(`Could not open ${cur}: ${shortError(r)}`); const up = parentGcs(cur); if (up === null && !cur) return undefined; cur = up ?? ''; continue; }
      const ls = parseLs(r.out);
      items = [
        { label: `$(check) Use this folder`, description: cur, detail: `${ls.files.length} file(s), ${ls.folders.length} sub-folder(s)`, use: true },
        { label: '$(arrow-up) Go up', up: true },
        ...ls.folders.map((f) => ({ label: `$(folder) ${f.replace(/\/$/, '').split('/').pop()}`, go: normalizeGcs(f) })),
      ];
    }
    items.push({ label: '$(edit) Type a path instead…', typed: true });
    const pick = await vscode.window.showQuickPick(items, { title: cur ? `Choose the DAGs folder — ${cur}` : 'Choose a bucket', placeHolder: 'Pick a folder, then “Use this folder”', ignoreFocusOut: true });
    if (!pick) return undefined;
    if (pick.typed) return '';
    if (pick.use) return cur;
    if (pick.up) { cur = parentGcs(cur) ?? ''; continue; }
    if (pick.go) cur = pick.go;
  }
}

async function setupGcs() {
  // 1) make sure gcloud exists and is signed in
  const who = await gcloud(['config', 'get-value', 'account']);
  if (who.code === 'ENOENT') return;
  const account = who.out.trim();
  if (who.code === 0 && (!account || account === '(unset)')) {
    const ok = await vscode.window.showInformationMessage('You are not signed in to Google Cloud yet.', { modal: true }, 'Sign in with gcloud');
    if (!ok || !(await signInViaTerminal())) return;
  }

  // 2) bucket path: browse, type, or keep the current one
  const currentPath = cfg().get<string>('dagsBucket', DEFAULT_BUCKET);
  const how = await vscode.window.showQuickPick([
    { label: '$(check) Keep current path', description: currentPath, id: 'keep' },
    { label: '$(search) Browse my buckets…', detail: 'Pick the bucket and folder from a list.', id: 'browse' },
    { label: '$(edit) Type a path…', detail: 'e.g. gs://my-bucket/dags', id: 'type' },
  ], { title: 'Google Cloud Storage path of the DAGs', placeHolder: account ? `Signed in as ${account}` : undefined, ignoreFocusOut: true });
  if (!how) return;
  let chosen = currentPath;
  if (how.id === 'browse') {
    const b = await browseGcs(isValidGcsPath(currentPath) ? currentPath : undefined);
    if (b === undefined) return;
    chosen = b;
  }
  if (how.id === 'type' || chosen === '') {
    const typed = await vscode.window.showInputBox({ title: 'Google Cloud Storage path of the DAGs', prompt: 'Folder that contains the DAG .py files', value: currentPath, ignoreFocusOut: true,
      validateInput: (v) => (isValidGcsPath(v) ? undefined : 'Use the form gs://bucket/folder (letters, digits, . _ - and /)') });
    if (!typed) return;
    chosen = typed;
  }
  chosen = normalizeGcs(chosen);

  // 3) test access before saving
  const test = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Checking ${chosen}…` }, () => gcloud(['storage', 'ls', `${chosen}/`]));
  if (test.code !== 0) {
    const p = classifyGcloudError(test);
    const msg = p === 'forbidden' ? 'Your account cannot read this location.' : p === 'not-found' ? 'This bucket or folder does not exist.' : p === 'auth' ? 'Sign-in did not complete.' : shortError(test);
    const c = await vscode.window.showErrorMessage(`${msg} (${chosen})`, 'Try another path…', p === 'forbidden' ? 'Use another account…' : 'Cancel');
    if (c === 'Try another path…') return setupGcs();
    if (c === 'Use another account…' && (await switchAccount())) return setupGcs();
    return;
  }
  const found = parseLs(test.out);
  if (!found.files.length && !found.folders.length) {
    const c = await vscode.window.showWarningMessage(`${chosen} is empty. Use it anyway?`, 'Use anyway', 'Choose another…');
    if (c === 'Choose another…') return setupGcs();
    if (c !== 'Use anyway') return;
  }

  // 4) where to keep the copy
  const where = await vscode.window.showQuickPick([
    { label: '$(lock) Extension storage (recommended)', detail: 'Managed automatically; nothing appears in your projects.', id: 'default' },
    { label: '$(folder) Choose a folder…', detail: 'A sub-folder “airflow-dags-cache” is created there. Only that sub-folder is ever modified.', id: 'custom' },
  ], { title: 'Where should the downloaded DAGs be stored?', ignoreFocusOut: true });
  if (!where) return;
  let downloadDir = '';
  if (where.id === 'custom') {
    const f = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Store DAGs here' });
    if (!f?.length) return;
    downloadDir = f[0].fsPath;
  }

  // 5) save + offer the first sync
  await cfg().update('dagsBucket', chosen, configTarget());
  await cfg().update('dagsDownloadDir', downloadDir, configTarget());
  await cfg().update('airflowSource', 'gcs', configTarget());
  reloadAll();
  const go = await vscode.window.showInformationMessage(`Airflow DAGs will come from ${chosen} (${found.files.length} files, ${found.folders.length} folders at the top level).`, 'Sync now', 'Later');
  if (go === 'Sync now') await syncDags();
}

async function load(): Promise<void> {
  const dir = await findProjectDir();
  if (!dir) { out.appendLine('No dbt_project.yml found.'); return; }
  projectDir = dir;
  const manifest = path.join(dir, cfg().get<string>('manifestPath', 'target/manifest.json'));
  if (!fs.existsSync(manifest)) {
    const pick = await vscode.window.showWarningMessage(`manifest.json not found at ${manifest}`, 'Run dbt parse');
    if (pick) await runParse();
    return;
  }
  const fresh = !fs.existsSync(cachePathFor(manifest));
  await withSteps('dbt airflow lineage: loading the project', [
    fresh ? 'reading manifest.json (the first time takes longer on big projects)…' : 'loading the cached lineage…',
    'scanning the Airflow DAG files…',
    'building the lineage index…',
  ], async (next) => {
    const step = async () => { await next(); };
    try {
      await step(); setBusyText(fresh ? 'Reading manifest.json…' : 'Loading the lineage…');
      const graph = await slimManifest(manifest);
      await step(); setBusyText('Scanning the Airflow DAGs…');
      const dirs = airflowDirs();
      const raw = dirs.length ? scanAirflow(dirs) : [];
      await step(); setBusyText('Building the lineage index…');
      index = new LineageIndex(graph, raw);
      out.appendLine(`Indexed ${Object.keys(graph.nodes).length} nodes, ${index.pipelines.length} pipelines`);
      syncMcp(); // the server needs the fresh cache path and DAG folders
    } catch (e: any) {
      out.appendLine(String(e?.stack ?? e));
      vscode.window.showErrorMessage(`dbt Airflow: ${e.message}`);
    }
  });
  changed.fire();
}

/** Drop the index and rebuild it (manifest or Airflow source changed). */
function reloadAll() { loading = undefined; void ensure().then(() => { changed.fire(); post(); }); } // keeps showing the old graph until the new index is ready
let busyCount = 0;
let busyText = '';
const postBusy = () => view?.webview.postMessage({ type: 'busy', on: busyCount > 0, text: busyCount > 0 ? busyText : '' });
const setBusy = (d: number) => { busyCount += d; if (busyCount <= 0) busyText = ''; postBusy(); };
const setBusyText = (t: string) => { busyText = t; postBusy(); };
const tick = () => new Promise<void>((r) => setTimeout(r, 30)); // lets the progress UI paint a step before a long synchronous job blocks the extension host

/** A notification with a progress bar and "Step i of N" messages: `next()` moves to the following step. */
function withSteps<T>(title: string, steps: string[], work: (next: (extra?: string) => Promise<void>) => Promise<T>, cancellable = false): Thenable<T> {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable }, async (progress) => {
    let i = 0;
    const next = async (extra?: string) => {
      if (i >= steps.length) return;
      const message = `Step ${i + 1} of ${steps.length}: ${steps[i]}${extra ? ` ${extra}` : ''}`;
      progress.report({ message, increment: i === 0 ? 0 : 100 / steps.length });
      i++;
      await tick();
    };
    return work(next);
  });
}
const ensure = async () => {
  if (!loading) { setBusy(1); const mine = (loading = load().finally(() => { setBusy(-1); if (loading === mine) loading = undefined; })); }
  await loading; return index;
};

async function runParse() {
  const cmd = cfg().get<string>('dbtCommand', 'dbt');
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'dbt parse…' }, () =>
    new Promise<void>((res) => {
      const c = spawn(cmd, ['parse'], { cwd: projectDir || undefined, shell: true });
      c.stdout.on('data', (d) => out.append(String(d))); c.stderr.on('data', (d) => out.append(String(d)));
      c.on('close', (code) => { if (code) vscode.window.showErrorMessage(`dbt parse failed (${code}); see output`); res(); });
    }));
  await load();
}

function modelIdForUri(uri: vscode.Uri): string | undefined {
  if (!index || !projectDir) return undefined;
  return index.findByPath(path.relative(projectDir, uri.fsPath));
}

// ---------------- webview ----------------

let filter: FilterState = defaultFilter();
const depthOf = (k: 'upstreamDepth' | 'downstreamDepth') => cfg().get<number>(k, 2);
const expanded = { up: new Set<string>(), down: new Set<string>() }; // nodes opened with the + buttons (exploration only, never saved)
let impactOn = false; // the Impact view: only the paths from the focused model to the reports it affects
const payload = (id: string) => buildPayload(index!, filter, id, depthOf('upstreamDepth'), depthOf('downstreamDepth'), expanded, impactOn ? reportConfig() : null);
const clearExpanded = () => { expanded.up.clear(); expanded.down.clear(); };
const DEFAULT_DEPTH = 2;

// ---------------- YAML metadata (description / tests) ----------------

function yamlInfo(id: string): { file: string; target: Target } | { error: string } {
  const n = index?.graph.nodes[id];
  if (!n) return { error: 'Unknown node' };
  if (n.type === 'exposure') return { error: 'Exposures are not editable here.' };
  if (n.type === 'source') return { file: path.join(projectDir, n.path), target: { section: 'sources', name: n.name, sourceName: n.sourceName } };
  if (!n.patchPath) return { error: `No YAML properties entry found for this ${n.type} (it is not declared in any .yml file).` };
  const rel = n.patchPath.replace(/^[^:]+:\/\//, '');
  const file = path.join(projectDir, rel);
  if (!fs.existsSync(file)) return { error: `YAML file not found: ${rel} (installed package?)` };
  return { file, target: { section: n.type === 'model' ? 'models' : n.type === 'seed' ? 'seeds' : 'snapshots', name: n.name } };
}
const readText = (file: string) => vscode.workspace.textDocuments.find((d) => d.uri.fsPath === file)?.getText() ?? fs.readFileSync(file, 'utf8');

function sendMeta(id: string, extra: Record<string, unknown> = {}) {
  const info = yamlInfo(id);
  if ('error' in info) return view?.webview.postMessage({ type: 'meta', id, error: info.error });
  try {
    const m = readMeta(readText(info.file), info.target);
    view?.webview.postMessage({ type: 'meta', id, file: path.relative(projectDir, info.file), view: m, error: m.found ? undefined : `No entry for "${info.target.name}" in ${path.relative(projectDir, info.file)}`, ...extra });
  } catch (e: any) { view?.webview.postMessage({ type: 'meta', id, error: String(e.message) }); }
}

async function saveMeta(id: string, edits: Edits) {
  const info = yamlInfo(id);
  if ('error' in info) return view?.webview.postMessage({ type: 'meta', id, error: info.error });
  try {
    const doc = await vscode.workspace.openTextDocument(info.file);
    const next = applyEdits(doc.getText(), info.target, edits);
    if (next !== doc.getText()) {
      const wasDirty = doc.isDirty;
      const we = new vscode.WorkspaceEdit();
      we.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), next);
      await vscode.workspace.applyEdit(we);
      if (!wasDirty) await doc.save();
      sendMeta(id, { saved: wasDirty ? 'Applied (file had unsaved changes, so it was not saved).' : `Saved ${path.basename(info.file)}` });
    } else sendMeta(id, { saved: 'No changes.' });
  } catch (e: any) {
    const msg = e instanceof MetaError ? e.message : `Could not edit YAML: ${e.message}`;
    sendMeta(id, { saveError: msg });
  }
}

async function openYaml(id: string) {
  const info = yamlInfo(id);
  if ('error' in info) return;
  const m = readMeta(readText(info.file), info.target);
  await openAt(info.file, m.line || 1);
}

async function showLineage(id?: string) {
  const idx = await ensure();
  if (!idx) return;
  if (!id) {
    const uri = vscode.window.activeTextEditor?.document.uri;
    id = uri && modelIdForUri(uri);
    if (!id) {
      const pick = await vscode.window.showQuickPick(Object.values(idx.graph.nodes).filter((n) => n.type !== 'exposure').map((n) => ({ label: n.name, description: n.type, id: n.id })), { placeHolder: 'Pick a model' });
      id = pick?.id;
    }
  }
  if (!id) return;
  focusId = id; clearExpanded();
  // Focusing the view resolves it (first time) and brings the bottom-panel tab forward.
  await vscode.commands.executeCommand('dbtAirflow.lineage.focus');
  post();
}

class LineageView implements vscode.WebviewViewProvider {
  resolveWebviewView(v: vscode.WebviewView) {
    view = v;
    v.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'dist')] };
    v.webview.html = html(v.webview);
    v.onDidDispose(() => (view = undefined));
    v.onDidChangeVisibility(() => v.visible && post());
    v.webview.onDidReceiveMessage(async (m) => {
      if (!index) return;
      switch (m.type) {
        case 'ready': post(); postBusy(); break;
        case 'refocus': focusId = m.id; clearExpanded(); post(); break;
        case 'expand': if (m.dir === 'up' || m.dir === 'down') { expanded[m.dir as 'up' | 'down'].add(m.id); post(); } break;
        case 'depth': {
          const clamp = (v: unknown) => Math.max(0, Math.min(20, Math.round(Number(v) || 0)));
          await cfg().update('upstreamDepth', clamp(m.up), vscode.ConfigurationTarget.Workspace);
          await cfg().update('downstreamDepth', clamp(m.down), vscode.ConfigurationTarget.Workspace);
          clearExpanded(); post(); break;
        }
        case 'askAi': void askAi(); break;
        case 'exportMenu': await exportMenu(); break;
        case 'saveImage': await saveImage(m); break;
        case 'impact':
          if (m.on && !reportsChosen() && !(await setupReports())) break; // first use: ask what counts as a report (critical models can be added from the panel)
          impactOn = !!m.on; post(); break;
        case 'setupReports': await setupReports(m.kind === 'critical' ? 'critical' : 'reports'); post(); break;
        case 'openSettings': void vscode.commands.executeCommand('workbench.action.openSettings', '@ext:tchandrap.dbt-airflow-lineage'); break;
        case 'copy': if (typeof m.text === 'string') { await vscode.env.clipboard.writeText(m.text); vscode.window.setStatusBarMessage('Copied', 2000); } break;
        case 'open': openNode(m.id); break;
        case 'loadMeta': sendMeta(m.id); break;
        case 'saveMeta': await saveMeta(m.id, m.edits); break;
        case 'openYaml': await openYaml(m.id); break;
        case 'setFilter': clearExpanded(); impactOn = false; filter = { ...filter, ...m.filter, scope: 'project', tags: [...(m.filter.tags ?? [])], kinds: [...(m.filter.kinds ?? [])] }; post(); break;
        case 'syncDags': await syncDags(); break;
        case 'setupAirflow': await setupAirflow(); break;
        case 'rescan': reloadAll(); break;
        case 'openPipeline': { const p = index.pipelines.find((x) => x.id === m.id); if (p) openAt(p.file, m.line ?? p.line); break; }
      }
    });
  }
}

function post() {
  if (!focusId && index) { const u = vscode.window.activeTextEditor?.document.uri; focusId = u && modelIdForUri(u); }
  if (!view || !focusId || !index || !index.graph.nodes[focusId]) return;
  view.webview.postMessage({ type: 'graph', payload: { ...payload(focusId), ai: cfg().get<boolean>('ai.enabled', false) } });
  view.webview.postMessage(syncInfo('idle', `${index.pipelines.length} pipelines`));
  view.description = index.graph.nodes[focusId].name;
}

/** Keep the lineage tab in sync with the model file being edited. */
function followActiveEditor() {
  const uri = vscode.window.activeTextEditor?.document.uri;
  const id = uri && modelIdForUri(uri);
  if (id && id !== focusId && view?.visible) { focusId = id; clearExpanded(); void resetDepths().then(post); }
}

/** A different model file: start from the default 2 upstream / 2 downstream again. */
async function resetDepths() {
  for (const k of ['upstreamDepth', 'downstreamDepth'] as const)
    if (depthOf(k) !== DEFAULT_DEPTH) await cfg().update(k, DEFAULT_DEPTH, vscode.ConfigurationTarget.Workspace);
}

function openNode(id: string) {
  const n = index?.graph.nodes[id];
  if (n?.path) openAt(path.join(projectDir, n.path), 1);
}
async function openAt(file: string, line: number) {
  const doc = await vscode.workspace.openTextDocument(file);
  const pos = new vscode.Position(Math.max(0, line - 1), 0);
  await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos), viewColumn: vscode.ViewColumn.One });
}

function html(w: vscode.Webview) {
  const js = w.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, 'dist', 'webview.js'));
  const nonce = crypto.randomBytes(16).toString('hex');
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
body{margin:0;height:100vh;position:relative;overflow:hidden;font-family:var(--vscode-font-family);font-size:12px;color:var(--vscode-foreground);background:var(--vscode-editor-background)}
#bar{position:absolute;top:0;left:0;right:0;z-index:5;padding:5px 10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;background:var(--vscode-editor-background);border-bottom:1px solid var(--vscode-panel-border)}
#bar input[type=number]{width:44px}
#float{position:absolute;right:12px;bottom:12px;z-index:6;display:flex;align-items:center;border:1px solid var(--vscode-panel-border);border-radius:6px;background:var(--vscode-editorWidget-background,var(--vscode-editor-background));box-shadow:0 2px 10px #0006;overflow:hidden}
#qwrap{position:relative;display:flex;align-items:center}#qwrap input{padding-left:12px}
#ph{position:absolute;left:12px;display:none;align-items:center;gap:7px;opacity:.65;pointer-events:none;white-space:nowrap}#q:placeholder-shown+#ph{display:flex}
#float input{width:260px;border:0;background:transparent;color:var(--vscode-input-foreground);padding:8px 4px;font:inherit;outline:none}
#float button{border-radius:0;background:transparent;color:var(--vscode-foreground);border-left:1px solid var(--vscode-panel-border);padding:8px 11px;font-size:13px}
#float button:hover{background:var(--vscode-list-hoverBackground)}#float button.on{background:var(--vscode-button-background);color:var(--vscode-button-foreground);outline:none}
svg#graph{position:absolute;top:var(--bar-h,34px);left:0;width:100%;height:calc(100% - var(--bar-h,34px));cursor:grab;touch-action:none}
svg#graph.grabbing{cursor:grabbing}
#busytxt{position:absolute;top:calc(var(--bar-h,34px) + 8px);left:12px;z-index:6;display:none;font-size:12px;padding:3px 10px;border-radius:10px;pointer-events:none;border:1px solid var(--vscode-panel-border);background:var(--vscode-editorWidget-background,var(--vscode-editor-background))}#busytxt.on{display:block}
#busy{position:absolute;top:var(--bar-h,34px);left:0;right:0;height:3px;z-index:6;overflow:hidden;pointer-events:none;display:none}
#busy.on{display:block}#busy::before{content:'';position:absolute;top:0;height:100%;width:30%;background:var(--vscode-progressBar-background,#0e70c0);animation:busy 1.2s ease-in-out infinite}
@keyframes busy{0%{left:-30%}100%{left:100%}}
.xbtn{cursor:pointer}.xbtn circle{fill:var(--vscode-editor-background);stroke:var(--vscode-focusBorder);stroke-width:1.6}.xbtn path{stroke:var(--vscode-focusBorder);stroke-width:2;stroke-linecap:round;fill:none}.xbtn:hover circle{fill:var(--vscode-focusBorder)}.xbtn:hover path{stroke:#fff}
.muted{opacity:.65}.row{display:flex;gap:6px;margin:6px 0 2px;flex-wrap:wrap;align-items:center}
button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;padding:3px 9px;border-radius:3px;cursor:pointer;font-size:11px}
button:hover{background:var(--vscode-button-hoverBackground)}button.sec{background:var(--vscode-button-secondaryBackground,#3a3d41);color:var(--vscode-button-secondaryForeground,#ddd)}
button.on{outline:1px solid var(--vscode-focusBorder)}button:disabled{opacity:.45;cursor:default}
input[type=text],textarea,select{background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,#555);border-radius:3px;padding:3px 6px;font:inherit;box-sizing:border-box}
input[type=text],textarea{width:100%}textarea{resize:vertical;min-height:54px}
a{cursor:pointer}.chip{display:inline-flex;gap:4px;align-items:center;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);border-radius:10px;padding:1px 8px;margin:1px 3px 1px 0}
.chip a{opacity:.8}
.dialog{display:none;position:absolute;top:calc(var(--bar-h,34px) + 12px);bottom:58px;width:360px;z-index:4;overflow:auto;border:1px solid var(--vscode-panel-border);border-radius:6px;background:var(--vscode-editorWidget-background,var(--vscode-editor-background));box-shadow:0 4px 16px #0006}
.dialog.show{display:block}#ldlg{left:10px}#dlg{right:10px}
#fdlg{right:12px;top:auto;bottom:54px;max-height:calc(100% - 100px);z-index:7}
.seg{display:flex;gap:4px}.seg button{flex:1}
.suggest{display:none;position:fixed;z-index:20;max-height:220px;overflow:auto;border:1px solid var(--vscode-panel-border);border-radius:4px;background:var(--vscode-editorWidget-background,#252526);box-shadow:0 4px 14px #0008}
.suggest .sg{padding:4px 8px;cursor:pointer;font-family:var(--vscode-editor-font-family)}.suggest .sg:hover{background:var(--vscode-list-hoverBackground)}
.pl.clickable{cursor:pointer}.pl.clickable:hover{background:var(--vscode-list-hoverBackground)}.pl.on:hover{background:var(--vscode-list-activeSelectionBackground)}
.dh{display:flex;align-items:center;gap:6px;padding:8px 10px 2px;position:sticky;top:0;background:inherit;z-index:1}.dh .x{margin-left:auto;padding:0 4px;font-size:14px}
.dsub{padding:0 10px 6px}.db{padding:0 10px 10px}
.sec-h{font-weight:600;margin:12px 0 4px;display:flex;align-items:center;gap:6px}
.pl{padding:6px;border-radius:4px;border-top:1px solid var(--vscode-panel-border)}.pl.on{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}
.sel-expr{font-family:var(--vscode-editor-font-family);word-break:break-all;font-size:11px;margin-top:2px}
.sw{display:inline-block;width:11px;height:11px;border-radius:3px;flex:none}
.trow{display:flex;gap:6px;align-items:center;padding:2px 0}.trow code{font-family:var(--vscode-editor-font-family);font-size:11px;word-break:break-all}
.trow.rm code{text-decoration:line-through;opacity:.5}.trow.new code{color:var(--vscode-gitDecoration-addedResourceForeground,#73c991)}
.col{border-top:1px solid var(--vscode-panel-border);padding:6px 0}.col .cn{font-weight:600;font-family:var(--vscode-editor-font-family)}
.err{color:var(--vscode-errorForeground);margin:6px 0}.ok{color:var(--vscode-gitDecoration-addedResourceForeground,#73c991);margin:6px 0}
.foot{position:sticky;bottom:0;background:inherit;border-top:1px solid var(--vscode-panel-border);padding:8px 10px}
.fl{display:block;margin:8px 0 3px;font-weight:600}
.kinds{display:grid;grid-template-columns:1fr 1fr;gap:3px 8px}.kinds label{display:flex;gap:5px;align-items:center}
.rz{position:absolute;z-index:8;display:none;touch-action:none}.rz:hover,.rz:active{background:var(--vscode-focusBorder);opacity:.55}
.rzw{width:8px;cursor:ew-resize}.rzh{height:8px;cursor:ns-resize}
#idlg{right:10px;width:400px;display:none;flex-direction:column;overflow-y:auto;overflow-x:hidden;z-index:9}#idlg.show{display:flex}#idlg>*{flex-shrink:0}
.node.imp.crit .body{fill:color-mix(in srgb,#f5a524 22%,var(--node-bg));stroke:#f5a524}.node.imp .body{stroke:#e5534b;stroke-width:2}.node.rpt .body{fill:color-mix(in srgb,#e5534b 20%,var(--node-bg))}.edge.imp{stroke:#e5534b;stroke-width:2.4;opacity:1}.edge.imp.hot-in,.edge.imp.hot-out{stroke:#e5534b;stroke-dasharray:none;animation:none}
#impactbtn{display:inline-flex;align-items:center;gap:5px}
#impactbtn.on{background:#e5534b33;outline:1px solid #e5534b}
.irow{border:1px solid var(--vscode-panel-border);border-radius:8px;padding:7px 10px;cursor:pointer}.irow:hover{background:var(--vscode-list-hoverBackground)}.irow .ip{color:var(--vscode-descriptionForeground);margin:2px 0;word-break:break-word}.irow .iq{color:var(--vscode-textLink-foreground)}
#askai,#settingsbtn{background:transparent;border:0;box-shadow:none;padding:0 2px;display:inline-flex;align-items:center}#askai:hover,#settingsbtn:hover{background:transparent;opacity:.75}#settingsbtn{color:var(--vscode-foreground);padding:0 4px}
#legend{position:absolute;left:10px;bottom:8px;z-index:3;display:grid;grid-template-columns:repeat(3,auto);gap:5px 16px;align-items:center;justify-items:start;padding:7px 11px;border:1px solid var(--vscode-panel-border);border-radius:6px;background:var(--vscode-editorWidget-background,var(--vscode-editor-background));opacity:.95}
#legend .li{display:flex;gap:5px;align-items:center;cursor:default}#legend .li.k{cursor:pointer}#legend .li.k.off{opacity:.35}
#legend .sep{width:1px;align-self:stretch;background:var(--vscode-panel-border)}
.edge{fill:none;stroke:var(--vscode-editorLineNumber-foreground);stroke-width:1.2}
.edge.hot-in,.edge.hot-out{stroke-width:2.4;stroke-dasharray:7 6;animation:flow .7s linear infinite}
.edge.hot-in{stroke:#4fc1ff}.edge.hot-out{stroke:#ffb454}
@keyframes flow{to{stroke-dashoffset:-13}}
.node text{pointer-events:none}
.node{cursor:pointer}
.dim{opacity:.15}.ctx{opacity:.5}
.abadge rect{fill:#0b2540;stroke:#fff;stroke-width:1.5}.abadge text{fill:#fff;font-size:11px;font-weight:600;pointer-events:none}.abadge:hover rect,.abadge.open rect{fill:#13508f}
.ibadge rect{fill:#0b3b33;stroke:#5eead4;stroke-width:1.5}.ibadge text{fill:#ccfbf1;font-size:11px;font-weight:600;pointer-events:none}.ibadge:hover rect,.ibadge.open rect{fill:#0f766e}.ibadge,.abadge{cursor:pointer}
.asec{display:flex;gap:6px;align-items:center;margin:10px 4px 4px;font-size:12px}.asec:first-child{margin-top:2px}

/* ---- modern dialogs ---- */
.ic{display:inline-flex;align-items:center;justify-content:center;vertical-align:middle}
.grow{flex:1}.small{font-size:11px}.pad{padding:10px}
.dialog{border-radius:12px;box-shadow:0 10px 30px #0008;border:1px solid var(--vscode-widget-border,var(--vscode-panel-border))}
#ldlg{width:390px;display:none;flex-direction:column;overflow:hidden}#ldlg.show{display:flex}
#fdlg{width:360px;display:none;flex-direction:column;overflow:hidden}#fdlg.show{display:flex}
.mh{display:flex;align-items:center;gap:10px;padding:12px 12px 8px}.mh.slim{padding:10px 12px 4px}
.kbadge{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:9px;color:#fff;flex:none}
.kbadge.flat{width:26px;height:26px;border-radius:7px;background:var(--vscode-button-background)}
.mt{flex:1;min-width:0}.mname{font-weight:600;font-size:13px;word-break:break-all;line-height:1.25}.msub{opacity:.65;font-size:11px;margin-top:1px}
.acts{display:flex;gap:6px;flex-wrap:wrap;padding:0 12px 8px;border-bottom:1px solid var(--vscode-panel-border)}
.acts button,.addrow button,.ffoot button,.foot button{display:inline-flex;gap:5px;align-items:center}
.mbody{flex:1;overflow:auto;padding:4px 12px 12px}
.src{display:flex;gap:5px;align-items:center;font-size:11px;margin:8px 0 2px;word-break:break-all}
.sh{display:flex;align-items:center;gap:6px;margin:14px 0 6px}.st{font-weight:600;font-size:11px;letter-spacing:.06em;text-transform:uppercase;opacity:.85}
.cnt{margin-left:6px;font-weight:500;opacity:.6;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);border-radius:9px;padding:0 6px;letter-spacing:0}
.ibtn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border-radius:6px;background:transparent;color:var(--vscode-foreground);opacity:.75}
.ibtn:hover{background:var(--vscode-list-hoverBackground);opacity:1}.ibtn.on{background:var(--vscode-button-background);color:var(--vscode-button-foreground);opacity:1}
.desc{white-space:pre-wrap;line-height:1.5}
.card{border:1px solid var(--vscode-panel-border);border-radius:10px;padding:8px 10px;background:var(--vscode-editor-background)}
.gt{display:flex;gap:5px;align-items:center;font-size:11px;opacity:.65;margin:8px 0 4px;text-transform:uppercase;letter-spacing:.05em}.gt:first-child{margin-top:0}
.pills{display:flex;flex-wrap:wrap;gap:5px;align-items:center}
.pill{display:inline-flex;align-items:center;gap:5px;border-radius:999px;padding:2px 9px;font-size:11px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);max-width:100%}
.pill.test{background:rgba(46,158,91,.16);color:var(--vscode-foreground);border:1px solid rgba(46,158,91,.5)}
.pill.tag{background:rgba(75,85,196,.18);border:1px solid rgba(75,85,196,.55);color:var(--vscode-foreground)}
.pill.new{outline:1px dashed #73c991}.pill.rm{opacity:.45;text-decoration:line-through}.pill.mini{padding:0 6px;gap:3px;font-size:10px}
.pill .sub{opacity:.7;font-family:var(--vscode-editor-font-family)}.px{display:inline-flex;cursor:pointer;opacity:.7}.px:hover{opacity:1}
.kv{display:flex;flex-direction:column;gap:3px}.kvr{display:flex;gap:8px;align-items:center;min-height:24px}
.kvr .k{width:38%;flex:none;opacity:.75;font-family:var(--vscode-editor-font-family);font-size:11px;word-break:break-all}.kvr .v{flex:1;word-break:break-all}
.kvr input{flex:1;padding:2px 6px}.k.rm,.v.rm{text-decoration:line-through;opacity:.45}.k.new,.v.new{color:#73c991}
.addrow{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;padding:8px;border-radius:8px;border:1px dashed var(--vscode-panel-border);align-items:center}
.addrow input[type=text]{flex:1;min-width:110px;width:auto}.addrow select{flex:none}.addrow .err{flex-basis:100%;margin:0}
.search{display:flex;align-items:center;gap:6px;padding:3px 8px;margin-bottom:6px;border:1px solid var(--vscode-input-border,var(--vscode-panel-border));border-radius:8px;background:var(--vscode-input-background)}
.search input{border:0;background:transparent;padding:2px 0;outline:none}
.clist{display:flex;flex-direction:column;border:1px solid var(--vscode-panel-border);border-radius:10px;overflow:hidden}
.crow{border-top:1px solid var(--vscode-panel-border)}.crow:first-child{border-top:0}
.chead{display:flex;gap:7px;align-items:center;padding:6px 8px;cursor:pointer}.chead:hover{background:var(--vscode-list-hoverBackground)}
.chev{display:inline-flex;transition:transform .15s}.chev.open{transform:rotate(90deg)}
.cn{font-family:var(--vscode-editor-font-family);font-weight:600;font-size:12px}.cd{flex:1;min-width:0;opacity:.6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dot{width:7px;height:7px;border-radius:50%;background:#e2b340;flex:none}
.cbody{padding:2px 10px 10px 27px;display:flex;flex-direction:column;gap:8px}
.crow.new{background:rgba(115,201,145,.08)}
.foot{border-top:1px solid var(--vscode-panel-border);padding:8px 12px;background:inherit}.foot .row{margin:0}.msg{margin:0 0 6px}
.err.small,.ok.small{margin:0}
/* filter */
.fbody{flex:1;overflow:auto;padding:2px 14px 8px}.ffoot{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:10px 14px;border-top:1px solid var(--vscode-panel-border)}
.fl{display:flex;align-items:center;gap:5px;font-weight:600;font-size:11px;letter-spacing:.05em;text-transform:uppercase;opacity:.9;margin:12px 0 5px}
.info{display:inline-flex;opacity:.55;cursor:help}.info:hover{opacity:1}
.seg{display:flex;padding:3px;border-radius:9px;background:var(--vscode-input-background);gap:3px}
.seg button{flex:1;background:transparent;color:var(--vscode-foreground);padding:5px 8px;border-radius:7px;font-size:12px}
.seg button.on{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
.check{display:flex;align-items:center;gap:6px;margin-top:8px;font-size:12px}
.gl{font-size:11px;opacity:.6;margin:8px 0 4px}.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip2{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;font-size:12px;background:var(--vscode-input-background);color:var(--vscode-foreground);border:1px solid var(--vscode-panel-border)}
.chip2:hover{background:var(--vscode-list-hoverBackground)}.chip2.off{opacity:.4;text-decoration:line-through}.chip2.off .swi{filter:grayscale(1)}.chip2.part{border-style:dashed;opacity:.8}
.swi{display:inline-flex}
select.copy{flex-basis:100%;width:100%;min-width:0;box-sizing:border-box}.cbody{min-width:0}
.cedit{margin-left:auto;opacity:0}.chead:hover .cedit,.crow.editing .cedit{opacity:.9}.crow.editing{background:rgba(75,85,196,.08)}
.lnk{font-size:11px;font-weight:500;text-transform:none;letter-spacing:0;opacity:.8;margin-left:6px}.lnk:hover{opacity:1;text-decoration:underline}
.cnt2{margin-left:5px;font-size:11px;font-weight:600}
/* top bar right: find + sync */
.rgt{margin-left:auto;display:flex;gap:8px;align-items:center}
.find{display:flex;align-items:center;gap:6px;padding:2px 8px;border:1px solid var(--vscode-input-border,var(--vscode-panel-border));border-radius:8px;background:var(--vscode-input-background)}
.find input{border:0;background:transparent;width:150px;padding:3px 0;outline:none}
#findn{min-width:22px;text-align:right;font-size:11px}
#sync{display:inline-flex;gap:6px;align-items:center;border-radius:8px;padding:4px 10px}#sync.bad{outline:1px solid var(--vscode-errorForeground)}
#sync.spin svg{animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}
.check.first{margin-top:10px}
/* nodes */
:root{--node-bg:var(--vscode-editorWidget-background,#252526)}
.node .body{stroke-width:1.6}.node.eph .body{stroke-dasharray:4 3}
.node text.name{fill:var(--vscode-foreground);font-size:12.5px;font-weight:600}
.node text.code{fill:#fff;font-size:9px;font-weight:700;letter-spacing:.04em}
.node text.tagtx{font-size:10px;font-weight:600}
.node.focus .body{stroke:var(--vscode-focusBorder);stroke-width:2.8}.node.sel .body{stroke:#fff;stroke-width:2.8}
/* tooltip */
.tip{display:none;position:fixed;z-index:50;max-width:300px;padding:6px 9px;border-radius:6px;font-size:11.5px;line-height:1.45;white-space:pre-line;background:var(--vscode-editorHoverWidget-background,#252526);color:var(--vscode-editorHoverWidget-foreground,#ccc);border:1px solid var(--vscode-editorHoverWidget-border,#454545);box-shadow:0 4px 14px #0008;pointer-events:none}
#float button{display:inline-flex;align-items:center;justify-content:center}
#float .ic{padding:0 8px;opacity:.8}
</style></head><body>
<div id="busy" title="Reloading in the background"></div><div id="busytxt"></div>
<div id="bar"><span>Upstream <input id="up" type="number" min="0" max="20" title="Levels upstream of the focused model"></span>
<span>Downstream <input id="down" type="number" min="0" max="20" title="Levels downstream of the focused model"></span><span id="sel"></span>
<span class="rgt"><span class="find"><span class="ic" id="findic"></span><input id="find" type="text" placeholder="Find in graph" spellcheck="false"><span id="findn" class="muted"></span></span><button id="impactbtn" class="sec"></button><button id="sync" class="sec"></button><button id="askai" class="sec"></button><button id="settingsbtn"></button></span>
<span class="muted" id="hint">drag = pan / move node · wheel = zoom · click node = center + details · double-click = refocus + open SQL · click Airflow badge = pipelines · type tag: for suggestions</span></div>
<svg id="graph"></svg><div id="legend"></div><div id="idlg" class="dialog"></div><div id="ldlg" class="dialog"></div><div id="dlg" class="dialog"></div><div id="fdlg" class="dialog"></div>
<div id="float"><span id="qwrap"><input id="q" type="text" placeholder=" " spellcheck="false"><span id="ph"></span></span>
<button id="apply"></button><button id="clr" style="display:none"></button>
<button id="fbtn"></button><button id="lbtn"></button>
<button id="zin"></button><button id="zout"></button><button id="expbtn"></button><button id="fit"></button></div>
<script nonce="${nonce}" src="${js}"></script></body></html>`;
}

// ---------------- tree views ----------------

type PItem = { kind: 'pipeline'; p: ResolvedPipeline } | { kind: 'site'; p: ResolvedPipeline; i: number } | { kind: 'ingest'; p: ResolvedPipeline; i: number };
class PipelineTree implements vscode.TreeDataProvider<PItem> {
  onDidChangeTreeData = changed.event;
  getChildren(el?: PItem): PItem[] {
    if (!index) return [];
    if (!el) return [...index.pipelines].sort((a, b) => a.name.localeCompare(b.name)).map((p) => ({ kind: 'pipeline', p }));
    return el.kind === 'pipeline' ? [...el.p.sites.map((_, i): PItem => ({ kind: 'site', p: el.p, i })), ...(el.p.ingests ?? []).map((_, i): PItem => ({ kind: 'ingest', p: el.p, i }))] : [];
  }
  getTreeItem(el: PItem): vscode.TreeItem {
    if (el.kind === 'pipeline') {
      const t = new vscode.TreeItem(el.p.name, vscode.TreeItemCollapsibleState.Collapsed);
      t.description = `${el.p.schedule ?? ''} · ${el.p.models.size ? `runs ${el.p.models.size}` : ''}${el.p.models.size && el.p.ingests?.length ? ' · ' : ''}${el.p.ingests?.length ? `ingests ${el.p.ingests.length}` : ''}`;
      t.iconPath = new vscode.ThemeIcon('git-pull-request-go-to-changes');
      t.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(el.p.file), { selection: new vscode.Range(el.p.line - 1, 0, el.p.line - 1, 0) }] };
      t.tooltip = el.p.file;
      return t;
    }
    if (el.kind === 'ingest') {
      const r = el.p.ingests![el.i];
      const t = new vscode.TreeItem(`${r.dataset ? r.dataset + '.' : ''}${r.table}`);
      t.description = 'ingests';
      t.iconPath = new vscode.ThemeIcon('database');
      t.tooltip = `Loads data into BigQuery table ${r.dataset ? r.dataset + '.' : ''}${r.table} (found under "${r.via}")`;
      t.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(el.p.file), { selection: new vscode.Range(r.line - 1, 0, r.line - 1, 0) }] };
      return t;
    }
    const s = el.p.sites[el.i];
    const t = new vscode.TreeItem(s.namedSelector ? `--selector ${s.namedSelector}` : s.select ?? '(dynamic — not resolvable)');
    t.description = `${s.exclude ? '✕ ' + s.exclude + '  ' : ''}→ ${s.models.length}`;
    t.tooltip = s.error ?? (s.models.length === 0 && !s.dynamic ? 'Matches 0 models in the current manifest' : undefined);
    t.iconPath = new vscode.ThemeIcon(s.error || (!s.models.length) ? 'warning' : 'filter');
    t.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(el.p.file), { selection: new vscode.Range(s.line - 1, 0, s.line - 1, 0) }] };
    return t;
  }
}

type CItem = { label: string; description?: string; file?: string; line?: number; tooltip?: string; icon?: string; children?: CItem[] };
class CurrentTree implements vscode.TreeDataProvider<CItem> {
  onDidChangeTreeData = changed.event;
  getChildren(el?: CItem): CItem[] {
    if (el) return el.children ?? [];
    const uri = vscode.window.activeTextEditor?.document.uri;
    const id = uri && modelIdForUri(uri);
    if (!index || !id) return [{ label: 'Open a dbt model file', icon: 'info' }];
    const n = index.graph.nodes[id];
    const trig = index.triggersFor(id);
    return [
      { label: n.name, description: n.type, icon: 'symbol-class' },
      {
        label: `Triggered by ${trig.length} pipeline${trig.length === 1 ? '' : 's'}`, icon: 'play',
        children: trig.map((t) => ({
          label: t.pipeline.name, description: t.pipeline.schedule, file: t.pipeline.file, line: t.sites[0]?.line ?? t.pipeline.line, icon: 'git-pull-request-go-to-changes',
          tooltip: t.sites.map((s) => `select: ${s.select ?? s.namedSelector}${s.exclude ? `\nexclude: ${s.exclude}` : ''}`).join('\n\n'),
          children: t.sites.map((s) => ({ label: s.select ?? `--selector ${s.namedSelector}`, description: s.exclude ? `✕ ${s.exclude}` : undefined, file: t.pipeline.file, line: s.line, icon: 'filter' })),
        })),
      },
      ...(index.ingestorsFor(id).length ? [{
        label: `Ingested by ${index.ingestorsFor(id).length} pipeline${index.ingestorsFor(id).length === 1 ? '' : 's'}`, icon: 'database',
        children: index.ingestorsFor(id).map((i) => ({
          label: i.pipeline.name, description: i.pipeline.schedule, file: i.pipeline.file, line: i.refs[0]?.line ?? i.pipeline.line, icon: 'git-pull-request-go-to-changes',
          tooltip: i.refs.map((r) => `${r.dataset ?? '?'}.${r.table}${r.match === 'exact' ? '' : ` (${r.match} match)`}`).join('\n'),
        })),
      }] : []),
    ];
  }
  getTreeItem(el: CItem): vscode.TreeItem {
    const t = new vscode.TreeItem(el.label, el.children?.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    t.description = el.description; t.tooltip = el.tooltip;
    if (el.icon) t.iconPath = new vscode.ThemeIcon(el.icon);
    if (el.file) t.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(el.file), { selection: new vscode.Range((el.line ?? 1) - 1, 0, (el.line ?? 1) - 1, 0) }] };
    return t;
  }
}

class Lenses implements vscode.CodeLensProvider {
  onDidChangeCodeLenses = changed.event;
  provideCodeLenses(doc: vscode.TextDocument) {
    const id = modelIdForUri(doc.uri);
    if (!index || !id) return [];
    const n = index.triggersFor(id).length;
    const r = new vscode.Range(0, 0, 0, 0);
    return [
      new vscode.CodeLens(r, { title: `$(play) ${n} Airflow pipeline${n === 1 ? '' : 's'}`, command: 'dbtAirflow.showPipelines' }),
      new vscode.CodeLens(r, { title: '$(type-hierarchy) Lineage', command: 'dbtAirflow.showLineage', arguments: [id] }),
    ];
  }
}

// ---------------- optional AI: tools for the editor's own agent (VS Code agent mode); off unless dbtAirflow.ai.enabled ----------------

const reportConfig = (): ReportConfig => ({
  include: cfg().get<string[]>('reports.include', []) ?? [], exclude: cfg().get<string[]>('reports.exclude', []) ?? [],
  critical: cfg().get<string[]>('critical.include', []) ?? [], criticalExclude: cfg().get<string[]>('critical.exclude', []) ?? [],
});
let aiTools: vscode.Disposable[] = [];

const isCursor = () => /cursor/i.test(vscode.env.appName) || !!(vscode as any).cursor?.mcp;
const MCP_NAME = 'dbt-airflow-lineage';

/** Settings the local MCP server reads (see src/mcp/load.ts). */
function mcpEnv(): Record<string, string> {
  const r = reportConfig();
  const env: Record<string, string> = { DBT_AIRFLOW_VERSION: String(ctx.extension.packageJSON?.version ?? ''), DBT_AIRFLOW_REPORT_INCLUDE: JSON.stringify(r.include), DBT_AIRFLOW_REPORT_EXCLUDE: JSON.stringify(r.exclude), DBT_AIRFLOW_CRITICAL_INCLUDE: JSON.stringify(r.critical ?? []), DBT_AIRFLOW_CRITICAL_EXCLUDE: JSON.stringify(r.criticalExclude ?? []), DBT_AIRFLOW_DAGS: airflowDirs().join(path.delimiter) };
  if (graphCachePath) env.DBT_AIRFLOW_GRAPH = graphCachePath;
  if (manifestFile) env.DBT_AIRFLOW_MANIFEST = manifestFile;
  return env;
}

let mcpRegistered = false;
let mcpKey = '';
/**
 * Registers the local MCP server with Cursor's agent while AI is on (Cursor has no VS Code-style tool API) and removes it when AI is off.
 * Idempotent: every re-registration makes Cursor drop and restart the connection, so it only acts when the server settings changed.
 */
function syncMcp() {
  const mcp = (vscode as any).cursor?.mcp;
  if (!mcp?.registerServer) return;
  const server = cfg().get<boolean>('ai.enabled', false)
    // Cursor's own binary runs the script as plain Node (ELECTRON_RUN_AS_NODE), so users do not need Node installed
    ? { command: process.execPath, args: ['--max-old-space-size=4096', ctx.asAbsolutePath('dist/mcp.js')], env: { ELECTRON_RUN_AS_NODE: '1', ...mcpEnv() } }
    : undefined;
  const key = server ? JSON.stringify(server) : '';
  if (key === mcpKey) return;
  try { if (mcpRegistered) mcp.unregisterServer?.(MCP_NAME); } catch { /* not registered */ }
  mcpRegistered = false; mcpKey = '';
  if (!server) { out.appendLine('AI: removed the local MCP server from Cursor.'); return; }
  try {
    mcp.registerServer({ name: MCP_NAME, server });
    mcpRegistered = true; mcpKey = key;
    out.appendLine('AI: registered the local MCP server with Cursor (read-only, no network).');
  } catch (e: any) { out.appendLine(`AI: could not register the MCP server with Cursor: ${e?.message ?? e}`); }
}

/** The server for clients outside the editor: a copy of dist/mcp.js in a stable place (the extension folder changes with every update), run by the editor's own binary as Node. */
function externalServer(): McpServerSpec {
  const dir = path.join(ctx.globalStorageUri.fsPath, 'mcp');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, 'dbt-airflow-lineage-mcp.js');
  fs.copyFileSync(ctx.asAbsolutePath('dist/mcp.js'), dest);
  const env: Record<string, string> = { ELECTRON_RUN_AS_NODE: '1', ...mcpEnv() };
  delete env.DBT_AIRFLOW_GRAPH; // the cache file name changes with the manifest; the manifest path is stable
  return { command: process.execPath, args: ['--max-old-space-size=4096', dest], env };
}

type AiClient = 'claude-code' | 'claude-desktop' | 'codex' | 'other';

/** Asks which AI tools should be able to use the lineage, then sets each one up. The editor's own agent is already covered by the AI setting. */
async function connectAi() {
  const picks = await vscode.window.showQuickPick<vscode.QuickPickItem & { id: AiClient }>([
    { id: 'claude-code', label: 'Claude Code', description: 'adds the local server with `claude mcp add`', detail: 'A terminal opens with the command ready; you press Enter.' },
    { id: 'claude-desktop', label: 'Claude Desktop', description: 'adds it to claude_desktop_config.json', detail: 'Asks first and keeps a backup. Restart Claude Desktop afterwards.' },
    { id: 'codex', label: 'OpenAI Codex CLI', description: 'copies the config.toml entry', detail: 'You paste it into ~/.codex/config.toml.' },
    { id: 'other', label: 'Another AI tool (Gemini CLI, Windsurf, Zed…)', description: 'copies the MCP JSON entry', detail: 'Works with any client that supports local (stdio) MCP servers.' },
  ], {
    canPickMany: true, ignoreFocusOut: true, title: 'Which AI do you want to use with your dbt lineage?',
    placeHolder: `Your editor's own agent is already set up. Tick any others. (ChatGPT only connects to servers on the internet, so it cannot use this local one.)`,
  });
  if (!picks?.length) return;
  await withSteps(`Connecting ${picks.length} AI tool${picks.length === 1 ? '' : 's'} to your lineage`, picks.map((p) => `setting up ${p.label}…`), async (next) => {
  const server = externalServer();
  for (const { id } of picks) {
    await next();
    if (id === 'claude-code') {
      const t = vscode.window.createTerminal('claude mcp add');
      t.show();
      t.sendText(claudeCodeCommand(server), false);
      vscode.window.showInformationMessage('Press Enter in the terminal to add the dbt lineage server to Claude Code (needs the `claude` command installed).');
    } else if (id === 'claude-desktop') {
      const file = claudeDesktopConfigPath(process.platform, os.homedir(), process.env.APPDATA);
      const ok = await vscode.window.showInformationMessage('Add the dbt lineage server to Claude Desktop?', { modal: true, detail: `This adds one entry to ${file}. Your other settings are kept and a backup copy is saved next to it.` }, 'Add');
      if (ok !== 'Add') continue;
      try {
        const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
        const next = mergeClaudeDesktopConfig(existing, server);
        if (existing !== undefined) fs.copyFileSync(file, `${file}.bak-${Date.now()}`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, next);
        vscode.window.showInformationMessage('Added to Claude Desktop. Quit and reopen Claude Desktop to load it.');
      } catch (e: any) { vscode.window.showErrorMessage(`Claude Desktop: ${e.message}`); }
    } else if (id === 'codex') {
      await vscode.env.clipboard.writeText(codexToml(server));
      vscode.window.showInformationMessage('Copied. Paste it at the end of ~/.codex/config.toml, then restart Codex.');
    } else {
      await vscode.env.clipboard.writeText(jsonEntry(server));
      vscode.window.showInformationMessage('Copied the MCP entry. Paste it into your AI tool\'s MCP settings ("mcpServers").');
    }
  }
  });
}

/** (Re)registers the lineage tools with VS Code's language-model API. Registers nothing while the setting is off. */
function syncAiTools() {
  aiTools.forEach((d) => d.dispose());
  aiTools = [];
  syncMcp();
  if (!cfg().get<boolean>('ai.enabled', false) || isCursor()) return; // Cursor's agent reads the MCP server instead
  const lm = (vscode as any).lm;
  if (!lm?.registerTool) { out.appendLine('AI tools need VS Code 1.95 or newer (vscode.lm.registerTool is missing).'); return; }
  const text = (t: string) => new (vscode as any).LanguageModelToolResult([new (vscode as any).LanguageModelTextPart(t)]);
  for (const t of TOOLS) {
    aiTools.push(lm.registerTool(`dbtairflow_${t.name}`, {
      prepareInvocation: () => ({ invocationMessage: `Reading the dbt lineage (${t.name.replace(/_/g, ' ')})…` }),
      invoke: async (options: { input?: Record<string, unknown> }) => {
        await ensure();
        return text(index ? runTool(index, reportConfig(), t.name, options.input ?? {}) : 'No dbt project is loaded in this window (no dbt_project.yml or manifest.json found).');
      },
    }));
  }
  out.appendLine(`AI: registered ${TOOLS.length} lineage tools for the editor's agent. Only model, report and pipeline names are returned.`);
}

/** Asks which image format, then has the lineage view draw it. */
async function exportMenu() {
  if (!view) { await vscode.commands.executeCommand('dbtAirflow.lineage.focus'); }
  const pick = await vscode.window.showQuickPick<vscode.QuickPickItem & { format: 'svg' | 'png'; scale: number }>([
    { format: 'svg', scale: 1, label: 'SVG (vector, best quality)', description: 'stays sharp at any zoom', detail: 'Opens in browsers, Figma, Inkscape, Keynote and PowerPoint. Smallest file.' },
    { format: 'png', scale: 3, label: 'PNG, high resolution (3x)', description: 'for slides, documents and chat' },
    { format: 'png', scale: 6, label: 'PNG, very high resolution (6x)', description: 'for posters; you can zoom in a long way' },
  ], { title: 'Save the lineage as an image', placeHolder: 'The whole graph is saved, not only what is on screen' });
  if (pick) view?.webview.postMessage({ type: 'doExport', format: pick.format, scale: pick.scale });
}

async function saveImage(m: { error?: string; format?: 'svg' | 'png'; data?: string; width?: number; height?: number; name?: string }) {
  if (m.error || !m.data || !m.format) { vscode.window.showWarningMessage(m.error ?? 'There is no graph to save yet.'); return; }
  const base = (m.name ?? 'lineage').replace(/[^A-Za-z0-9._-]+/g, '_');
  const dir = projectDir || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
  const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(dir, `${base}-lineage.${m.format}`)), filters: m.format === 'svg' ? { 'SVG image': ['svg'] } : { 'PNG image': ['png'] }, title: 'Save the lineage as an image' });
  if (!target) return;
  try {
    await vscode.workspace.fs.writeFile(target, m.format === 'svg' ? Buffer.from(m.data, 'utf8') : Buffer.from(m.data, 'base64'));
    const c = await vscode.window.showInformationMessage(`Saved ${path.basename(target.fsPath)} (${m.width}×${m.height}${m.format === 'png' ? ' px' : ', vector'}).`, 'Reveal in folder', 'Open');
    if (c === 'Reveal in folder') void vscode.commands.executeCommand('revealFileInOS', target);
    else if (c === 'Open') void vscode.env.openExternal(target);
  } catch (e: any) { vscode.window.showErrorMessage(`Could not save the image: ${e?.message ?? e}`); }
}

/** One-time: turns the old single `reports.mode` / `reports.value` settings into an entry of `reports.include`, in the same place they were set. */
async function migrateReportSettings() {
  for (const target of [vscode.ConfigurationTarget.Workspace, vscode.ConfigurationTarget.Global]) {
    const pick = <T,>(i: { workspaceValue?: T; globalValue?: T } | undefined) => (target === vscode.ConfigurationTarget.Workspace ? i?.workspaceValue : i?.globalValue);
    const entry = legacyReportEntry(pick(cfg().inspect<string>('reports.mode')), pick(cfg().inspect<string>('reports.value')));
    if (!entry || (pick(cfg().inspect<string[]>('reports.include')) ?? []).length) continue;
    try { await cfg().update('reports.include', [entry], target); out.appendLine(`Reports: moved the old setting to dbtAirflow.reports.include = ["${entry}"].`); }
    catch (e: any) { out.appendLine(`Reports: could not move the old setting: ${e?.message ?? e}`); }
  }
}

/** True once at least one report source is set. */
const reportsChosen = () => reportsConfigured(reportConfig());

/**
 * Lets the user build the report definition: add as many sources as they like (exposures, tags, folders, files, any dbt selector),
 * exclude some, see how many reports each one matches, and save. Everything is combined.
 */
async function setupReports(kind: 'reports' | 'critical' = 'reports'): Promise<boolean> {
  const noun = kind === 'reports' ? 'report' : 'critical model';
  const keys = kind === 'reports' ? { inc: 'reports.include', exc: 'reports.exclude' } : { inc: 'critical.include', exc: 'critical.exclude' };
  const idx = await ensure();
  if (!idx) { vscode.window.showWarningMessage('Open a dbt project first: no manifest was found.'); return false; }
  const g = idx.graph;
  const nodes = Object.values(g.nodes);
  const exposures = nodes.filter((n) => n.type === 'exposure').length;
  let include = [...(cfg().get<string[]>(keys.inc, []) ?? [])], exclude = [...(cfg().get<string[]>(keys.exc, []) ?? [])];
  const info = (entry: string) => reportMatch(g, { include: [entry], exclude: [] }).include[0];
  const pickTag = async () => {
    const counts = new Map<string, number>();
    for (const n of nodes) if (n.type !== 'exposure' && n.type !== 'source') for (const t of n.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    const pick = await vscode.window.showQuickPick([...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 300).map(([t, c]) => ({ label: t, description: `${c} model${c === 1 ? '' : 's'}` })),
      { title: `Which tag marks a ${noun}?`, placeHolder: counts.size ? 'Type to search the tags in this project' : 'This project has no tags', ignoreFocusOut: true });
    return pick ? `tag:${pick.label}` : undefined;
  };
  const pickFolder = async () => {
    const counts = new Map<string, number>();
    for (const n of nodes) {
      if (!n.path || n.type === 'exposure' || n.type === 'source') continue;
      const parts = n.path.replace(/\\/g, '/').split('/').slice(0, -1);
      for (let i = 2; i <= parts.length; i++) { const d = parts.slice(0, i).join('/'); counts.set(d, (counts.get(d) ?? 0) + 1); }
    }
    const TYPE = '$(edit) Type a folder…';
    const pick = await vscode.window.showQuickPick([{ label: TYPE, description: '', alwaysShow: true }, ...[...counts].sort((a, b) => a[0].localeCompare(b[0])).slice(0, 500).map(([d, c]) => ({ label: d, description: `${c} model${c === 1 ? '' : 's'}` }))],
      { title: `Which folder holds ${noun}s?`, placeHolder: 'Type to search the folders in this project', ignoreFocusOut: true });
    if (!pick) return undefined;
    const v = pick.label === TYPE ? (await vscode.window.showInputBox({ title: `Folder that holds ${noun}s`, prompt: 'For example models/reporting, or just reporting (matches any folder with that name)', ignoreFocusOut: true }))?.trim() : pick.label;
    return v ? `folder:${v}` : undefined;
  };
  const ask = async (title: string, prompt: string, prefix = '') => { const v = (await vscode.window.showInputBox({ title, prompt, ignoreFocusOut: true }))?.trim(); return v ? `${prefix}${v}` : undefined; };
  type Item = vscode.QuickPickItem & { act: string; entry?: string };
  for (;;) {
    const total = reportMatch(g, { include, exclude }).ids.size;
    const sep = (label: string): Item => ({ label, kind: vscode.QuickPickItemKind.Separator, act: '' });
    const items: Item[] = [
      { act: 'done', label: `$(check) Save: ${total} ${noun}${total === 1 ? '' : 's'} match`, description: include.length ? '' : 'add at least one source first' },
      sep(`Add a source (they are combined)`),
      ...(kind === 'reports' ? [{ act: 'exposures', label: '$(add) dbt exposures', description: `${exposures} in this project` } as Item] : []),
      { act: 'tag', label: '$(add) A tag…', description: 'models with a tag, e.g. report' },
      { act: 'folder', label: '$(add) A folder…', description: 'models under a folder, e.g. models/reporting' },
      { act: 'file', label: '$(add) A file or model name…', description: 'e.g. rpt_pnl.sql' },
      { act: 'selector', label: '$(add) A dbt selector…', description: 'e.g. tag:finance,config.materialized:view  or  rpt_*' },
      { act: 'exclude', label: '$(circle-slash) Exclude something…', description: 'taken out of the list again' },
      ...(include.length || exclude.length ? [sep('Current (pick one to remove it)')] : []),
      ...include.map((e): Item => { const i = info(e); return { act: 'rm-inc', entry: e, label: `$(trash) ${e}`, description: i.error ? `invalid: ${i.error}` : `${i.count} match${i.count === 1 ? '' : 'es'}` }; }),
      ...exclude.map((e): Item => ({ act: 'rm-exc', entry: e, label: `$(trash) exclude: ${e}`, description: `${info(e).count} removed` })),
    ];
    const pick = await vscode.window.showQuickPick(items, { title: kind === 'reports' ? 'What counts as a report? Add as many sources as you like' : 'Which models are critical? Add as many sources as you like', ignoreFocusOut: true });
    if (!pick) return false;
    let entry: string | undefined;
    switch (pick.act) {
      case 'exposures': entry = 'exposures'; break;
      case 'tag': entry = await pickTag(); break;
      case 'folder': entry = await pickFolder(); break;
      case 'file': entry = await ask('A file or model name', 'For example rpt_pnl.sql, or models/marts/rpt_pnl.sql', 'file:'); break;
      case 'selector': entry = await ask('A dbt selector', 'Any selector, for example tag:finance,config.materialized:view or rpt_*'); break;
      case 'exclude': { const e = await ask(`Exclude from the ${noun}s`, 'tag:draft, folder:sandbox, file:rpt_old.sql, path:models/tmp, or any dbt selector'); if (e) exclude.push(e); break; }
      case 'rm-inc': include = include.filter((x) => x !== pick.entry); break;
      case 'rm-exc': exclude = exclude.filter((x) => x !== pick.entry); break;
      case 'done':
        if (!include.length) { vscode.window.showWarningMessage('Add at least one source first.'); break; }
        await cfg().update(keys.inc, include, configTarget());
        await cfg().update(keys.exc, exclude, configTarget());
        vscode.window.showInformationMessage(`${kind === 'reports' ? 'Reports' : 'Critical models'} set: ${total} match${total === 1 ? 'es' : ''}.`);
        return true;
    }
    if (entry) {
      if (!include.includes(entry)) include.push(entry);
      const i = info(entry);
      if (i.error) vscode.window.showWarningMessage(`${entry}: ${i.error}`);
      else if (!i.count) vscode.window.showWarningMessage(`${entry} matches no ${noun}s in this project.`);
    }
  }
}

/** Opens VS Code's own chat in agent mode with a ready question about the focused model. Offers to turn the optional AI feature on first. */
async function askAi() {
  const cursor = isCursor();
  if (!cfg().get<boolean>('ai.enabled', false)) {
    const detail = cursor
      ? 'AI answers about lineage are much more accurate when the agent can query your dbt graph instead of guessing. Turning this on sets up a local MCP server for Cursor: a small program bundled with this extension that runs on your machine, uses no network and no API key, and is read-only. Cursor\'s agent can then ask it which models, reports and pipelines are connected. It only returns names, never SQL or data. You can turn it off any time with the setting dbtAirflow.ai.enabled.'
      : 'AI answers about lineage are much more accurate when the agent can query your dbt graph instead of guessing. Turning this on adds lineage tools for the VS Code agent. They run inside this extension, use no network and no API key, and are read-only. The agent can then ask which models, reports and pipelines are connected. It only receives names, never SQL or data. You can turn it off any time with the setting dbtAirflow.ai.enabled.';
    const c = await vscode.window.showInformationMessage(cursor ? 'Set up a local MCP server for AI?' : 'Turn on AI for dbt airflow lineage?', { modal: true, detail }, 'Turn on');
    if (c !== 'Turn on') return;
    await withSteps('Setting up AI for dbt airflow lineage', [
      'turning on the AI setting…',
      cursor ? 'registering the local MCP server with Cursor…' : 'registering the lineage tools with the VS Code agent…',
      'loading the lineage so the agent can query it…',
    ], async (next) => {
      await next(); await cfg().update('ai.enabled', true, configTarget());
      await next(); syncAiTools();
      await next(); await ensure(); syncMcp(); post();
    });
    await connectAi(); // which other AI tools should use it too
  }
  await ensure();
  syncMcp();
  const uri = vscode.window.activeTextEditor?.document.uri;
  const id = focusId ?? (uri && modelIdForUri(uri));
  const name = id && index?.graph.nodes[id]?.name;
  const query = `Using the dbt lineage tools, which reports are impacted if I change ${name ?? '<model name>'}, and which Airflow pipelines run them?`;
  if (cursor) { // Cursor's chat has no command to prefill a question, so hand it over through the clipboard
    await vscode.env.clipboard.writeText(query);
    vscode.window.showInformationMessage('The local MCP server is set up. The question is copied: open Cursor\'s chat (Cmd+L), switch to Agent, and paste it.');
    return;
  }
  try { await vscode.commands.executeCommand('workbench.action.chat.open', { query, mode: 'agent', isPartialQuery: true }); }
  catch { vscode.window.showWarningMessage('VS Code chat is not available (it needs GitHub Copilot Chat). The lineage tools are registered for any agent that supports them.'); }
}

/** Every setting except the depths and the report/AI settings: a change in any of these needs a fresh index. */
const reloadSignature = () => {
  const props = Object.keys(ctx.extension.packageJSON?.contributes?.configuration?.properties ?? {}).map((k) => k.replace(/^dbtAirflow\./, ''));
  return JSON.stringify(props.filter((k) => k !== 'upstreamDepth' && k !== 'downstreamDepth' && !k.startsWith('reports.') && !k.startsWith('critical.') && !k.startsWith('ai.')).map((k) => cfg().get(k)));
};
let lastSignature = '';

export function activate(c: vscode.ExtensionContext) {
  ctx = c;
  lastSignature = reloadSignature();
  void migrateReportSettings();
  c.subscriptions.push({ dispose: () => { aiTools.forEach((d) => d.dispose()); try { if (mcpRegistered) (vscode as any).cursor?.mcp?.unregisterServer?.(MCP_NAME); } catch { /* shutting down */ } } });
  syncAiTools();
  const reload = reloadAll;
  c.subscriptions.push(
    out,
    vscode.commands.registerCommand('dbtAirflow.showLineage', (id?: string) => showLineage(typeof id === 'string' ? id : undefined)),
    vscode.commands.registerCommand('dbtAirflow.refresh', reload),
    vscode.commands.registerCommand('dbtAirflow.askAi', askAi),
    vscode.commands.registerCommand('dbtAirflow.setupReports', async () => { if (await setupReports()) post(); }),
    vscode.commands.registerCommand('dbtAirflow.exportImage', exportMenu),
    vscode.commands.registerCommand('dbtAirflow.setupCritical', async () => { if (await setupReports('critical')) post(); }),
    vscode.commands.registerCommand('dbtAirflow.connectAi', connectAi),
    vscode.commands.registerCommand('dbtAirflow.runParse', runParse),
    vscode.commands.registerCommand('dbtAirflow.syncDags', syncDags),
    vscode.commands.registerCommand('dbtAirflow.setupAirflow', setupAirflow),
    vscode.commands.registerCommand('dbtAirflow.showPipelines', async () => { await ensure(); await vscode.commands.executeCommand('dbtAirflow.current.focus'); }),
    vscode.window.registerWebviewViewProvider('dbtAirflow.lineage', new LineageView(), { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.registerTreeDataProvider('dbtAirflow.pipelines', new PipelineTree()),
    vscode.window.registerTreeDataProvider('dbtAirflow.current', new CurrentTree()),
    vscode.languages.registerCodeLensProvider({ language: 'sql' }, new Lenses()),
    vscode.window.onDidChangeActiveTextEditor(() => { changed.fire(); followActiveEditor(); }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('dbtAirflow')) return;
      if (e.affectsConfiguration('dbtAirflow.ai')) { syncAiTools(); post(); } // post(): shows or hides the Ask AI button
      syncMcp();
      const sig = reloadSignature();
      if (sig !== lastSignature) { lastSignature = sig; reload(); } // changing only the depths must not rebuild the index
    }),
    vscode.workspace.onDidSaveTextDocument((d) => { if (d.fileName.endsWith('.py') && airflowDirs().some((p) => d.fileName.startsWith(p))) reload(); }),
  );
  const w = vscode.workspace.createFileSystemWatcher('**/target/manifest.json');
  w.onDidChange(reload); w.onDidCreate(reload);
  c.subscriptions.push(w);
  void ensure();
}
export function deactivate() {}
