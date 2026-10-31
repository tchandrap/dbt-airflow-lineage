import { describe, it, expect } from 'vitest';
import { authLoginEnv, buildExcludeRegex, findAuthUrl, classifyGcloudError, DEFAULT_SYNC_EXCLUDE, isValidGcsPath, normalizeGcs, parentGcs, parseLs, shortError } from '../src/gcloud';

describe('classifyGcloudError', () => {
  it('recognises the expired-login error from the screenshot', () => {
    const err = 'ERROR: (gcloud.storage.rsync) There was a problem refreshing your current auth tokens: Reauthentication failed. cannot prompt during non-interactive execution.\nPlease run:\n\n  $ gcloud auth login\n\nto obtain new credentials.';
    expect(classifyGcloudError({ code: 1, err, out: '' })).toBe('auth');
  });
  it('other categories', () => {
    expect(classifyGcloudError({ code: 'ENOENT', err: '', out: '' })).toBe('missing-cli');
    expect(classifyGcloudError({ code: 1, err: 'ERROR: HTTPError 403: user does not have storage.objects.list permission', out: '' })).toBe('forbidden');
    expect(classifyGcloudError({ code: 1, err: 'ERROR: (gcloud.storage.ls) One or more URLs matched no objects.', out: '' })).toBe('not-found');
    expect(classifyGcloudError({ code: 1, err: 'ERROR: You do not currently have an active account selected.', out: '' })).toBe('auth');
    expect(classifyGcloudError({ code: 1, err: 'boom', out: '' })).toBe('other');
  });
});

describe('gcs paths', () => {
  it('validates and normalises', () => {
    expect(isValidGcsPath('gs://my-company-airflow-dags/dags/')).toBe(true);
    expect(normalizeGcs(' gs://b/dags// ')).toBe('gs://b/dags');
    expect(isValidGcsPath('gs://b')).toBe(true);
    for (const bad of ['', 'dags', 'gs://', 'gs://b/a b', 'gs://b/$(rm -rf)', 'https://x/y', 'gs://b/a;b']) expect(isValidGcsPath(bad)).toBe(false);
  });
  it('parent paths', () => {
    expect(parentGcs('gs://b/a/b')).toBe('gs://b/a');
    expect(parentGcs('gs://b/a')).toBe('gs://b');
    expect(parentGcs('gs://b')).toBeNull();
  });
});

describe('parseLs / shortError', () => {
  it('splits folders and files', () => {
    const r = parseLs('gs://b/dags/\ngs://b/dags/x.py\n\ngs://b/dags/sub/\nnoise');
    expect(r.folders).toEqual(['gs://b/dags/', 'gs://b/dags/sub/']);
    expect(r.files).toEqual(['gs://b/dags/x.py']);
  });
  it('keeps the useful line of an error', () => {
    const e = shortError({ out: '', err: 'ERROR: (gcloud.storage.ls) bucket nope not found\nPlease run:\n  $ gcloud auth login\nto obtain new credentials.' });
    expect(e).toContain('bucket nope not found');
    expect(e).not.toContain('$ gcloud');
  });
});

describe('gcloud crash', () => {
  it('recognises the crash from the screenshot (so we can fall back to gsutil)', () => {
    const err = "ERROR: gcloud crashed (TypeError): ExecutionError.__init__() missing 1 required positional argument: 'error'\n\nIf you would like to report this issue, please run the following command:\n  gcloud feedback";
    expect(classifyGcloudError({ code: 1, err, out: '' })).toBe('crash');
  });
});

describe('sync exclusions', () => {
  const re = new RegExp(buildExcludeRegex(DEFAULT_SYNC_EXCLUDE));
  it('keeps DAG python files and skips test data, other file types and test folders', () => {
    for (const keep of ['my_dag.py', 'finance/daily/dag_a.py', 'mytests/x.py', 'tests_helpers/x.py']) expect(re.test(keep), keep).toBe(false);
    for (const skip of ['tests/data/mambu_reconciliation/transaction/history.json', 'finance/config.yaml', 'README.md', 'a/tests/test_dag.py', 'test/x.py', 'a/__pycache__/x.cpython-311.pyc', '.dbt-airflow-lineage-cache']) expect(re.test(skip), skip).toBe(true);
  });
  it('rejects commas and invalid regexes, ignores blanks', () => {
    expect(() => buildExcludeRegex(['a{1,3}'])).toThrow(/comma/);
    expect(() => buildExcludeRegex(['(unclosed'])).toThrow(/not a valid regular expression/);
    expect(buildExcludeRegex(['  ', ''])).toBe('');
    expect(buildExcludeRegex(['a', 'b'])).toBe('(?:a)|(?:b)');
  });
});

describe('gcloud sign-in helpers', () => {
  it('finds the sign-in link in gcloud output', () => {
    const out = 'Your browser has been opened to visit:\n\n    https://accounts.google.com/o/oauth2/auth?response_type=code&client_id=x&state=y\n';
    expect(findAuthUrl(out)).toBe('https://accounts.google.com/o/oauth2/auth?response_type=code&client_id=x&state=y');
    expect(findAuthUrl('Go to https://example.com/')).toBeUndefined();
    expect(findAuthUrl('')).toBeUndefined();
  });
  it('stops gcloud from launching its own browser, except on Windows', () => {
    expect(authLoginEnv({ A: '1' }, 'darwin')).toEqual({ A: '1', BROWSER: 'true' });
    expect(authLoginEnv({ A: '1' }, 'linux').BROWSER).toBe('true');
    expect(authLoginEnv({ A: '1', BROWSER: 'x' }, 'win32')).toEqual({ A: '1', BROWSER: 'x' });
  });
});
