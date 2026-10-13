import { describe, it, expect } from 'vitest';
import { applyEdits, readMeta, MetaError } from '../src/meta';
import { parseDocument } from 'yaml';

const T = { section: 'models' as const, name: 'm1' };
const SRC = `version: 2
# keep me
models:
- name: m1
  description: >-
    Folded text
    second line
  tests:
  - dbt_utils.unique_combination_of_columns:
      arguments:
        combination_of_columns: [a, b]
  columns:
  - name: id   # pk
    description: "old"
    tests:
    - unique
    - not_null
  - name: kind
    tests:
    - accepted_values:
        arguments:
          values: ['A', 'B']
  - name: bare
    tests: []
- name: m2
  description: other
`;

describe('readMeta', () => {
  it('reads description, columns and tests', () => {
    const m = readMeta(SRC, T);
    expect(m.found).toBe(true);
    expect(m.description).toBe('Folded text second line');
    expect(m.tests[0].label).toBe('dbt_utils.unique_combination_of_columns');
    expect(m.columns.map((c) => [c.name, c.tests.map((t) => t.label)])).toEqual([['id', ['unique', 'not_null']], ['kind', ['accepted_values']], ['bare', []]]);
    expect(m.columns[1].tests[0].args).toBe('{"values":["A","B"]}');
  });
  it('not found', () => expect(readMeta(SRC, { section: 'models', name: 'zz' }).found).toBe(false));
});

describe('applyEdits touches only what changed', () => {
  const valid = (s: string) => expect(parseDocument(s).errors).toHaveLength(0);
  it('column description replace', () => {
    const out = applyEdits(SRC, T, { columns: { id: 'Primary key' } });
    expect(out).toBe(SRC.replace('description: "old"', 'description: "Primary key"'));
  });
  it('adds a description where missing, after name', () => {
    const out = applyEdits(SRC, T, { columns: { kind: 'Type "x"' } });
    expect(out).toContain('  - name: kind\n    description: "Type \\"x\\""\n    tests:');
    valid(out);
  });
  it('replaces a folded model description, preserving the rest', () => {
    const out = applyEdits(SRC, T, { description: 'New one-liner' });
    expect(out).toContain('  description: "New one-liner"\n  tests:');
    expect(out).toContain('# keep me');
    expect(readMeta(out, T).description).toBe('New one-liner');
    valid(out);
  });
  it('multi-line description becomes a block literal', () => {
    const out = applyEdits(SRC, T, { description: 'line1\nline2' });
    expect(readMeta(out, T).description).toBe('line1\nline2');
    valid(out);
  });
  it('removes one of several tests / the whole key when last', () => {
    const out = applyEdits(SRC, T, { removeTests: [{ column: 'id', index: 0, label: 'unique' }] });
    expect(out).toBe(SRC.replace('    - unique\n', ''));
    const out2 = applyEdits(SRC, T, { removeTests: [{ column: 'kind', index: 0, label: 'accepted_values' }] });
    expect(out2).not.toContain('accepted_values');
    expect(out2).toContain('  - name: kind\n  - name: bare');
    valid(out2);
  });
  it('adds simple and argument tests, matching repo style', () => {
    const out = applyEdits(SRC, T, { addTests: [
      { column: 'id', test: { name: 'unique' } },
      { column: 'bare', test: { name: 'accepted_values', args: { values: ['x', 'y z', 1] } } },
      { column: 'kind', test: { name: 'not_null' } },
    ] });
    expect(out).toContain("    - not_null\n    - unique\n  - name: kind");
    expect(out).toContain("  - name: bare\n    tests:\n    - accepted_values:\n        arguments:\n          values: ['x', 'y z', 1]");
    const m = readMeta(out, T);
    expect(m.columns[2].tests[0].label).toBe('accepted_values');
    expect(m.columns[1].tests.map((t) => t.label)).toEqual(['accepted_values', 'not_null']);
    valid(out);
  });
  it('adds a model-level tests key when missing and handles add+remove together', () => {
    const out = applyEdits(SRC, { section: 'models', name: 'm2' }, { addTests: [{ test: { name: 'dbt_utils.recency', args: { datepart: 'day', interval: 2 } } }] });
    expect(out.endsWith("  description: other\n  tests:\n  - dbt_utils.recency:\n      arguments:\n        datepart: day\n        interval: 2\n")).toBe(true);
    const out2 = applyEdits(SRC, T, { removeTests: [{ column: 'id', index: 1, label: 'not_null' }], addTests: [{ column: 'id', test: { name: 'relationships', args: { to: "ref('x')", field: 'id' } } }] });
    expect(out2).toContain("    - unique\n    - relationships:\n        arguments:\n          to: ref('x')\n          field: id\n");
    expect(out2).not.toContain('not_null');
    valid(out2);
  });
  it('rejects stale removals and undeclared columns', () => {
    expect(() => applyEdits(SRC, T, { removeTests: [{ column: 'id', index: 0, label: 'not_null' }] })).toThrow(MetaError);
    expect(() => applyEdits(SRC, T, { columns: { nope: 'x' } })).toThrow(MetaError);
  });
});

const SRC2 = `version: 2
models:
- name: m1
  description: d
  config:
    tags:
    - team_a
    - daily
    labels:
      owner: falcon
    materialized: table
  meta:
    owner: falcon
  columns:
  - name: id
    description: pk
    tests:
    - unique
`;
const valid2 = (s: string) => expect(parseDocument(s).errors).toHaveLength(0);

describe('properties (config / meta / tags)', () => {
  it('reads flattened properties', () => {
    const p = readMeta(SRC2, T).props;
    expect(p.find((x) => x.path.join('.') === 'config.tags')).toMatchObject({ type: 'list', items: ['team_a', 'daily'] });
    expect(p.find((x) => x.path.join('.') === 'config.materialized')?.value).toBe('table');
    expect(p.find((x) => x.path.join('.') === 'meta.owner')?.value).toBe('falcon');
  });
  it('sets an existing scalar in place, adds missing keys, creates nested maps', () => {
    const a = applyEdits(SRC2, T, { setProps: [{ path: ['config', 'materialized'], value: 'incremental' }] });
    expect(a).toBe(SRC2.replace('materialized: table', 'materialized: incremental'));
    const b = applyEdits(SRC2, T, { setProps: [{ path: ['config', 'unique_key'], value: 'id' }, { path: ['meta', 'team'], value: 'fca' }, { path: ['docs', 'show'], value: 'false' }] });
    expect(b).toContain('    materialized: table\n    unique_key: id\n  meta:\n    owner: falcon\n    team: fca\n');
    expect(b).toContain('  docs:\n    show: false\n');
    valid2(b);
    expect(readMeta(b, T).props.find((x) => x.path.join('.') === 'docs.show')?.value).toBe('false');
  });
  it('removes a property, climbing out of maps it would leave empty', () => {
    const a = applyEdits(SRC2, T, { removeProps: [{ path: ['config', 'labels', 'owner'] }, { path: ['meta', 'owner'] }] });
    expect(a).not.toContain('labels'); expect(a).not.toContain('meta:'); expect(a).toContain('materialized: table');
    valid2(a);
  });
  it('adds and removes list items (tags)', () => {
    const a = applyEdits(SRC2, T, { addListItems: [{ path: ['config', 'tags'], value: 'finance' }], removeListItems: [{ path: ['config', 'tags'], index: 0, label: 'team_a' }] });
    expect(readMeta(a, T).props.find((x) => x.path.join('.') === 'config.tags')?.items).toEqual(['daily', 'finance']);
    valid2(a);
    const b = applyEdits(SRC2, T, { removeListItems: [{ path: ['config', 'tags'], index: 0, label: 'team_a' }, { path: ['config', 'tags'], index: 1, label: 'daily' }] });
    expect(b).not.toContain('tags:'); expect(b).toContain('labels:'); valid2(b);
    const c = applyEdits(SRC2, T, { addListItems: [{ path: ['config', 'new_list'], value: 'x' }, { path: ['meta', 'groups'], value: 'y' }] });
    expect(c).toContain('    new_list:\n    - x\n'); expect(c).toContain('    groups:\n    - y\n'); valid2(c);
    expect(() => applyEdits(SRC2, T, { removeListItems: [{ path: ['config', 'tags'], index: 0, label: 'nope' }] })).toThrow(MetaError);
  });
});

describe('new columns', () => {
  it('appends after the last column, together with a test on that column', () => {
    const out = applyEdits(SRC2, T, { addColumns: [{ name: 'amount', description: 'Total "amount"' }, { name: 'ccy' }], addTests: [{ column: 'id', test: { name: 'not_null' } }] });
    expect(out).toContain('    - unique\n    - not_null\n  - name: amount\n    description: "Total \\"amount\\""\n  - name: ccy\n');
    expect(readMeta(out, T).columns.map((c) => c.name)).toEqual(['id', 'amount', 'ccy']);
    valid2(out);
  });
  it('rejects duplicates (case-insensitive, also within the same submit)', () => {
    expect(() => applyEdits(SRC2, T, { addColumns: [{ name: 'ID' }] })).toThrow(/already exists/);
    expect(() => applyEdits(SRC2, T, { addColumns: [{ name: 'x' }, { name: 'X' }] })).toThrow(/already exists/);
    expect(() => applyEdits(SRC2, T, { addColumns: [{ name: ' ' }] })).toThrow(MetaError);
  });
  it('creates the columns key when missing', () => {
    const out = applyEdits('models:\n- name: m1\n  description: d\n', T, { addColumns: [{ name: 'a' }] });
    expect(out).toBe('models:\n- name: m1\n  description: d\n  columns:\n  - name: a\n');
  });
});

describe('aliased tests', () => {
  it('lists and removes YAML-alias tests by their anchor name', () => {
    const src = 'models:\n- name: m1\n  columns:\n  - name: a\n    tests:\n    - &shared\n      unique\n    - *shared\n    - not_null\n';
    const m = readMeta(src, T);
    expect(m.columns[0].tests.map((x) => x.label)).toEqual(['unique', '*shared', 'not_null']);
    const out = applyEdits(src, T, { removeTests: [{ column: 'a', index: 2, label: 'not_null' }] });
    expect(out).not.toContain('not_null');
    expect(parseDocument(out).errors).toHaveLength(0);
  });
});

describe('YAML merge keys (<<: *anchor)', () => {
  const src = `models:
- &base
  name: base_model
  description: shared
  columns:
  - &c_id
    name: id
    description: pk
    tests:
    - unique
- <<: *base
  name: m1
  columns:
  - <<: *c_id
  - <<: *c_id
    name: id2
    description: second
`;
  it('reads names / descriptions / tests through merges', () => {
    const m = readMeta(src, T);
    expect(m.found).toBe(true);
    expect(m.description).toBe('shared');
    expect(m.columns.map((c) => [c.name, c.description, c.tests.map((t) => t.label)])).toEqual([['id', 'pk', ['unique']], ['id2', 'second', ['unique']]]);
  });
  it('overrides a description with an explicit key, but refuses to override inherited tests', () => {
    const out = applyEdits(src, T, { columns: { id: 'new pk' } });
    expect(readMeta(out, T).columns[0].description).toBe('new pk');
    expect(parseDocument(out).errors).toHaveLength(0);
    expect(() => applyEdits(src, T, { addTests: [{ column: 'id', test: { name: 'not_null' } }] })).toThrow(/inherited/);
  });
});
