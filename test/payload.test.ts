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
  it('project scope adds upstream/downstream context around a bare model name', () => {
    const f = { ...defaultFilter(), select: 'b', scope: 'project' as const };
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
    expect([plain.depthUp, plain.depthDown, plain.depthFromSelector]).toEqual([2, 2, false]);
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
