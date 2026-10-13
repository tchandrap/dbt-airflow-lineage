import { describe, it, expect } from 'vitest';
import { resolve } from '../src/selector';
import type { Graph, GNode } from '../src/types';

const mk = (name: string, o: Partial<GNode> = {}): GNode => ({
  id: `${o.type ?? 'model'}.p.${name}`, name, type: 'model', tags: [], fqn: ['p', 'mart', name], path: `models/mart/${name}.sql`, pkg: 'p', ...o,
});
// src.raw → stg_a → int_a → fct_a ; stg_b → fct_a ; fct_a → dim_x
const nodes = [
  mk('raw', { type: 'source', sourceName: 'src', fqn: ['p', 'src', 'raw'] }),
  mk('stg_a', { tags: ['daily'], fqn: ['p', 'staging', 'stg_a'], path: 'models/staging/stg_a.sql' }),
  mk('stg_b', { tags: ['daily', 'pii'], fqn: ['p', 'staging', 'stg_b'], path: 'models/staging/stg_b.sql' }),
  mk('int_a'), mk('fct_a', { tags: ['hourly'] }), mk('dim_x', { tags: ['daily'] }),
];
const edges: [string, string][] = [['raw', 'stg_a'], ['stg_a', 'int_a'], ['int_a', 'fct_a'], ['stg_b', 'fct_a'], ['fct_a', 'dim_x']];
const id = (n: string) => nodes.find((x) => x.name === n)!.id;
const g: Graph = { nodes: Object.fromEntries(nodes.map((n) => [n.id, n])), parents: {}, children: {}, selectors: {} };
nodes.forEach((n) => { g.parents[n.id] = []; g.children[n.id] = []; });
edges.forEach(([a, b]) => { g.children[id(a)].push(id(b)); g.parents[id(b)].push(id(a)); });
g.selectors = {
  daily_no_pii: { definition: { union: [{ method: 'tag', value: 'daily' }, { exclude: [{ method: 'tag', value: 'pii' }] }] } },
  fct_up: { definition: { method: 'fqn', value: 'fct_a', parents: true, parents_depth: 1 } },
};
const names = (s: Set<string>) => [...s].map((i) => g.nodes[i].name).sort();

describe('resolve', () => {
  it('tag', () => expect(names(resolve(g, 'tag:daily'))).toEqual(['dim_x', 'stg_a', 'stg_b']));
  it('union by space, tags comma = intersection', () => {
    expect(names(resolve(g, 'tag:hourly dim_x'))).toEqual(['dim_x', 'fct_a']);
    expect(names(resolve(g, 'tag:daily,tag:pii'))).toEqual(['stg_b']);
  });
  it('graph operators', () => {
    expect(names(resolve(g, 'fct_a+'))).toEqual(['dim_x', 'fct_a']);
    expect(names(resolve(g, '+int_a'))).toEqual(['int_a', 'raw', 'stg_a']);
    expect(names(resolve(g, '1+fct_a'))).toEqual(['fct_a', 'int_a', 'stg_b']);
    expect(names(resolve(g, 'stg_a+1'))).toEqual(['int_a', 'stg_a']);
  });
  it('@ selects descendants and their ancestors', () => {
    expect(names(resolve(g, '@stg_a'))).toEqual(['dim_x', 'fct_a', 'int_a', 'raw', 'stg_a', 'stg_b']);
  });
  it('exclude', () => {
    expect(names(resolve(g, 'tag:daily', 'stg_b'))).toEqual(['dim_x', 'stg_a']);
    expect(names(resolve(g, 'fct_a+', 'tag:daily'))).toEqual(['fct_a']);
    expect(names(resolve(g, '+fct_a', '+int_a'))).toEqual(['fct_a', 'stg_b']);
  });
  it('source / path / fqn folder / wildcard', () => {
    expect(names(resolve(g, 'source:src+'))).toContain('raw');
    expect(names(resolve(g, 'source:src.raw'))).toEqual(['raw']);
    expect(names(resolve(g, 'path:models/staging'))).toEqual(['stg_a', 'stg_b']);
    expect(names(resolve(g, 'staging.*'))).toEqual(['stg_a', 'stg_b']);
    expect(names(resolve(g, 'stg_*'))).toEqual(['stg_a', 'stg_b']);
  });
  it('named selectors incl. exclude and depth', () => {
    expect(names(resolve(g, null, null, 'daily_no_pii'))).toEqual(['dim_x', 'stg_a']);
    expect(names(resolve(g, 'selector:fct_up'))).toEqual(['fct_a', 'int_a', 'stg_b']);
  });
  it('empty select = everything; unknown method throws', () => {
    expect(resolve(g, null).size).toBe(nodes.length);
    expect(() => resolve(g, 'state:modified')).toThrow();
  });
});
