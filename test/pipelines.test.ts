import { describe, it, expect } from 'vitest';
import { filterPipelines, matchesPattern, mergeByName, preparePipelines } from '../src/pipelines';
import { LineageIndex } from '../src/index';
import type { Graph, GNode, Pipeline } from '../src/types';

const site = (select: string) => ({ select, exclude: null, dynamic: false, line: 1, raw: '' });
const pl = (name: string, file: string, o: Partial<Pipeline> = {}): Pipeline => ({ id: `${file}::${name}`, name, file, line: 5, sites: [site('tag:a')], explicitName: true, ...o });
const cfg = pl('acmefin_monthly_15', '/repo/configs/regulatory_reports.py', { schedule: 'asset_or_time' });
const gen = pl('acmefin_monthly_15', '/repo/generated_dags/acmefin_monthly_15_t1.py', { line: 9, sites: [site('tag:a'), site('tag:b')] });
const other = pl('daily_build', '/repo/dags/daily_build.py');

describe('pipeline patterns', () => {
  it('match by DAG name, file or folder, with wildcards and any letter case', () => {
    expect(matchesPattern(cfg, 'acmefin_monthly_15')).toBe(true);
    expect(matchesPattern(cfg, 'ACMEFIN_*')).toBe(true);
    expect(matchesPattern(cfg, 'regulatory_reports.py')).toBe(true);
    expect(matchesPattern(cfg, 'configs/regulatory_reports.py')).toBe(true);
    expect(matchesPattern(cfg, 'configs')).toBe(true);
    expect(matchesPattern(gen, 'generated_dags')).toBe(true);
    expect(matchesPattern(cfg, 'generated_dags')).toBe(false);
    expect(matchesPattern(cfg, 'acmefin')).toBe(false); // a name must match fully
    expect(matchesPattern(cfg, '  ')).toBe(false);
  });
  it('include keeps only the matches, exclude removes them, empty include keeps all', () => {
    const all = [cfg, gen, other];
    expect(filterPipelines(all, [], []).length).toBe(3);
    expect(filterPipelines(all, ['daily_build'], []).map((p) => p.name)).toEqual(['daily_build']);
    expect(filterPipelines(all, [], ['generated_dags']).map((p) => p.file)).toEqual([cfg.file, other.file]);
    expect(filterPipelines(all, ['acmefin_*'], ['generated_dags']).map((p) => p.file)).toEqual([cfg.file]);
  });
});

describe('the same DAG name in several files', () => {
  it('becomes one pipeline: the hand-written file first, selections combined, other files listed', () => {
    const [m, o] = mergeByName([gen, other, cfg]);
    expect(m.file).toBe(cfg.file);
    expect(m.sites.map((s) => s.select)).toEqual(['tag:a', 'tag:b']);
    expect(m.alsoIn).toEqual([{ file: gen.file, line: 9 }]);
    expect(m.schedule).toBe('asset_or_time');
    expect(o).toBe(other);
  });
  it('is not merged when the name only came from the file name', () => {
    const a = pl('__init__', '/a/__init__.py', { explicitName: false }), b = pl('__init__', '/b/__init__.py', { explicitName: false });
    expect(mergeByName([a, b]).length).toBe(2);
  });
  it('excluding the generated folder leaves the hand-written definition alone', () => {
    const r = preparePipelines([cfg, gen], { exclude: ['generated_dags'] });
    expect(r.length).toBe(1);
    expect(r[0].alsoIn).toBeUndefined();
  });
  it('is counted once as a trigger of a model', () => {
    const n: GNode = { id: 'model.p.m', name: 'm', type: 'model', tags: ['a'], fqn: ['p', 'm'], path: 'models/m.sql', pkg: 'p' };
    const g: Graph = { nodes: { [n.id]: n }, parents: { [n.id]: [] }, children: { [n.id]: [] }, selectors: {} };
    expect(new LineageIndex(g, [cfg, gen]).triggersFor(n.id).length).toBe(2);
    expect(new LineageIndex(g, preparePipelines([cfg, gen])).triggersFor(n.id).length).toBe(1);
  });
});
