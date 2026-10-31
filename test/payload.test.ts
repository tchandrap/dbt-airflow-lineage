import { describe, it, expect } from 'vitest';
import { buildPayload, defaultFilter, kindOf } from '../src/payload';
import { LineageIndex } from '../src/index';
import type { Graph, GNode } from '../src/types';

const mk = (name: string, o: Partial<GNode> = {}): GNode => ({ id: `${o.type ?? 'model'}.p.${name}`, name, type: 'model', tags: [], fqn: ['p', name], path: `models/${name}.sql`, pkg: 'p', ...o });
const nodes = [
  mk('src', { type: 'source', sourceName: 's' }), mk('a', { tags: ['daily'], materialized: 'view' }), mk('b', { tags: ['daily', 'old'], materialized: 'table' }),
  mk('c', { materialized: 'ephemeral' }), mk('d', { tags: ['weekly'], materialized: 'incremental' }),
];
const g: Graph = { nodes: Object.fromEntries(nodes.map((n) => [n.id, n])), parents: {}, children: {}, selectors: {} };
nodes.forEach((n) => { g.parents[n.id] = []; g.children[n.id] = []; });
([['src', 'a'], ['a', 'b'], ['b', 'c'], ['c', 'd']] as const).forEach(([x, y]) => { const i = (n: string) => nodes.find((q) => q.name === n)!.id; g.children[i(x)].push(i(y)); g.parents[i(y)].push(i(x)); });
const idx = new LineageIndex(g, []);
const id = (n: string) => nodes.find((x) => x.name === n)!.id;
const names = (ids: string[] | null | undefined) => (ids ?? []).map((i) => g.nodes[i].name).sort();

describe('buildPayload', () => {
  it('kinds', () => {
    expect(nodes.map(kindOf)).toEqual(['source', 'view', 'table', 'ephemeral', 'incremental']);
  });
  it('no filter: neighbourhood only, matched null', () => {
    const p = buildPayload(idx, defaultFilter(), id('b'), 1);
    expect(names(p.nodes.map((n) => n.id))).toEqual(['a', 'b', 'c']);
    expect(p.matched).toBeNull();
  });
  it('upstream and downstream depth are independent', () => {
    const p = buildPayload(idx, defaultFilter(), id('b'), 1, 2);
    expect(names(p.nodes.map((n) => n.id))).toEqual(['a', 'b', 'c', 'd']);
    expect(p.depthUp).toBe(1); expect(p.depthDown).toBe(2);
    expect(names(buildPayload(idx, defaultFilter(), id('b'), 0, 1).nodes.map((n) => n.id))).toEqual(['b', 'c']);
    expect(names(buildPayload(idx, defaultFilter(), id('b'), 5, 0).nodes.map((n) => n.id))).toEqual(['a', 'b', 'src']);
  });
  it('+ buttons: edge nodes report hidden neighbours, expanding adds one level without changing the depths', () => {
    const base = buildPayload(idx, defaultFilter(), id('a'), 0, 1); // a -> b shown
    expect(base.more[id('b')]).toEqual({ up: 0, down: 1 });
    expect(base.more[id('a')]).toEqual({ up: 1, down: 0 });
    const ex = buildPayload(idx, defaultFilter(), id('a'), 0, 1, { up: [id('a')], down: [id('b')] });
    expect(names(ex.nodes.map((n) => n.id))).toEqual(['a', 'b', 'c', 'src']);
    expect(ex.depthUp).toBe(0); expect(ex.depthDown).toBe(1);
    expect(ex.more[id('c')]).toEqual({ up: 0, down: 1 });
    expect(ex.more[id('b')]).toBeUndefined();
  });
  it('+ button only where none of that side is shown yet', () => {
    const p = buildPayload(idx, defaultFilter(), id('b'), 1, 1); // a b c
    expect(p.more[id('c')]).toEqual({ up: 0, down: 1 });
    expect(p.more[id('a')]).toEqual({ up: 1, down: 0 });
    expect(p.more[id('b')]).toBeUndefined();
  });
  it('shows the simplest dbt selector for what is on screen', () => {
    const sel = (up: number, down: number, ex?: any) => buildPayload(idx, defaultFilter(), id('b'), up, down, ex).selector.text;
    expect(sel(1, 1)).toBe('1+b+1');
    expect(sel(0, 1)).toBe('b+1');
    expect(sel(1, 0)).toBe('1+b');
    expect(sel(0, 0)).toBe('b');
    expect(sel(5, 5)).toBe('+b+'); // everything is within reach, so the unlimited form is shorter
    expect(sel(1, 1, { up: [], down: [id('c')] })).toBe('1+b+'); // expanding c reaches d, the end of the chain
    expect(buildPayload(idx, defaultFilter(), id('a'), 1, 1).selector.text).toBe('+a+1'); // a has a single parent, so + is exact and shorter
  });
  it('Impact view: only the paths from the focused model to the reports it affects', () => {
    const tagged = { ...g, nodes: { ...g.nodes, [id('c')]: { ...g.nodes[id('c')], tags: ['report'] } } } as Graph;
    const ix = new LineageIndex(tagged, []);
    const p: any = buildPayload(ix, defaultFilter(), id('a'), 1, 1, undefined, { include: ['tag:report'], exclude: [] });
    expect(names(p.nodes.map((n: any) => n.id))).toEqual(['a', 'b', 'c']); // depth is ignored: c is two hops away
    expect(p.impact.reports.map((r: any) => [r.name, r.hops])).toEqual([['c', 2]]);
    expect(p.impact.pathEdges).toEqual([[id('a'), id('b')], [id('b'), id('c')]]);
    expect(p.impact.definition).toBe('reports: tag:report');
    expect(p.impact.entries).toEqual([{ entry: 'tag:report', count: 1, error: undefined }]);
    const none: any = buildPayload(ix, defaultFilter(), id('a'), 1, 1, undefined, { include: [], exclude: [] });
    expect(none.impact.configured).toBe(false);
    expect(names(none.nodes.map((n: any) => n.id))).toEqual(['a']);
    expect((buildPayload(ix, defaultFilter(), id('a'), 1, 1) as any).impact).toBeUndefined();
  });
  it('select + exclude + tags + kind within lineage dims via matched list', () => {
    const f = { ...defaultFilter(), select: 'tag:daily', exclude: 'tag:old' };
    expect(names(buildPayload(idx, f, id('b'), 3).matched)).toEqual(['a']);
    expect(names(buildPayload(idx, { ...defaultFilter(), exclude: 'c' }, id('b'), 3).matched)).toEqual(['a', 'b', 'd', 'src']);
    expect(names(buildPayload(idx, { ...defaultFilter(), tags: ['daily', 'weekly'], tagMode: 'any' }, id('b'), 3).matched)).toEqual(['a', 'b', 'd']);
    expect(names(buildPayload(idx, { ...defaultFilter(), tags: ['daily', 'old'], tagMode: 'all' }, id('b'), 3).matched)).toEqual(['b']);
    expect(names(buildPayload(idx, { ...defaultFilter(), kinds: ['ephemeral', 'source'] }, id('b'), 3).matched)).toEqual(['c', 'src']);
  });
  it('project scope shows the selection as its own graph', () => {
    const p = buildPayload(idx, { ...defaultFilter(), select: 'tag:daily', scope: 'project', context: false }, id('d'), 1);
    expect(names(p.nodes.map((n) => n.id))).toEqual(['a', 'b']);
    expect(p.edges).toHaveLength(1);
    expect(p.matched).toBeNull();
  });
  it('a bare model name selects only that model, like dbt (context is opt-in)', () => {
    const only = buildPayload(idx, { ...defaultFilter(), select: 'b', scope: 'project' as const }, id('b'), 2, 2);
    expect(names(only.nodes.map((n) => n.id))).toEqual(['b']);
    expect(only.selector.text).toBe('b');
    expect(only.depthUp).toBe(0); expect(only.depthDown).toBe(0); expect(only.contextOff).toBe(true);
  });
  it('a single selected model still gets + buttons, and expanding it extends the selector', () => {
    const f = { ...defaultFilter(), select: 'b', scope: 'project' as const };
    const p = buildPayload(idx, f, id('b'), 2, 2);
    expect(p.more[id('b')]).toEqual({ up: 1, down: 1 });
    const e = buildPayload(idx, f, id('b'), 2, 2, { up: [], down: [id('b')] });
    expect(names(e.nodes.map((n) => n.id))).toEqual(['b', 'c']);
    expect(e.selector.text).toBe('b b+1');
    expect(e.more[id('b')]).toEqual({ up: 1, down: 0 });
  });
  it('project scope adds upstream/downstream context around a bare model name when asked', () => {
    const f = { ...defaultFilter(), select: 'b', scope: 'project' as const, context: true };
    const p = buildPayload(idx, f, id('b'), 1, 1);
    expect(names(p.nodes.map((n) => n.id))).toEqual(['a', 'b', 'c']);
    expect(names(p.matched)).toEqual(['b']);
    expect(names(buildPayload(idx, f, id('b'), 0, 2).nodes.map((n) => n.id))).toEqual(['b', 'c', 'd']);
    const off = buildPayload(idx, { ...f, context: false }, id('b'), 2, 2);
    expect(names(off.nodes.map((n) => n.id))).toEqual(['b']);
    expect(off.matched).toBeNull();
  });
  it('graph operators in the selector set the depths (1+b+1, b+1, +b)', () => {
    const f = (select: string) => buildPayload(idx, { ...defaultFilter(), select, scope: 'project' as const }, id('b'), 2, 2);
    const a = f('1+b+1');
    expect(names(a.nodes.map((n) => n.id))).toEqual(['a', 'b', 'c']);
    expect([a.depthUp, a.depthDown, a.depthFromSelector]).toEqual([1, 1, true]);
    const d = f('b+1');
    expect(names(d.nodes.map((n) => n.id))).toEqual(['b', 'c']);
    expect([d.depthUp, d.depthDown]).toEqual([0, 1]);
    const u = f('+b');
    expect(names(u.nodes.map((n) => n.id))).toEqual(['a', 'b', 'src']);
    expect([u.depthUp, u.depthDown]).toEqual([-1, 0]);
    const plain = f('b');
    expect([plain.depthUp, plain.depthDown, plain.depthFromSelector]).toEqual([0, 0, false]);
    expect(f('tag:daily b+1').depthFromSelector).toBe(false);
  });
  it('bad selector reports an error and does not filter', () => {
    const p = buildPayload(idx, { ...defaultFilter(), select: 'state:modified' }, id('b'), 1);
    expect(p.filterError).toMatch(/not supported/);
    expect(p.matched).toBeNull();
  });
});

describe('large selections keep the searched model', () => {
  it('trims by distance from the seed, not alphabetically', () => {
    const N = 450;
    const ns = Array.from({ length: N }, (_, i) => mk(`n${String(i).padStart(3, '0')}`));
    const gg: Graph = { nodes: Object.fromEntries(ns.map((n) => [n.id, n])), parents: {}, children: {}, selectors: {} };
    ns.forEach((n) => { gg.parents[n.id] = []; gg.children[n.id] = []; });
    for (let i = 0; i + 1 < N; i++) { gg.children[ns[i].id].push(ns[i + 1].id); gg.parents[ns[i + 1].id].push(ns[i].id); }
    const ix = new LineageIndex(gg, []);
    // "+n449" selects the whole chain (450 nodes); alphabetical trimming would drop n449 itself
    const p = buildPayload(ix, { ...defaultFilter(), select: '+n449', scope: 'project' }, ns[449].id, 2, 2);
    expect(p.nodes).toHaveLength(400);
    expect(p.nodes.some((n) => n.name === 'n449')).toBe(true);
    expect(p.nodes.some((n) => n.name === 'n050')).toBe(true);
    expect(p.nodes.some((n) => n.name === 'n049')).toBe(false);
    expect(p.truncated).toBe(50);
    expect(p.seeds).toEqual([ns[449].id]);
  });
});
