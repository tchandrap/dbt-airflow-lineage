import { describe, it, expect } from 'vitest';
import { classifyGcloudError, isValidGcsPath, normalizeGcs, parentGcs, parseLs, shortError } from '../src/gcloud';

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
