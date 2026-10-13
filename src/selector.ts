import type { Graph, GNode, SelectorDef } from './types';

export class SelectorError extends Error {}

const INF = Number.POSITIVE_INFINITY;

interface Atom {
  method: string; // 'fqn' | 'tag' | ...
  value: string;
  parents: number; // 0 = none, INF = all
  children: number;
  childrensParents: boolean; // @
}

/** `--select "a b,c"` style string → union of intersections of atoms. */
export function parseExpression(expr: string): Atom[][] {
  return expr.trim().split(/\s+/).filter(Boolean).map((part) => part.split(',').filter(Boolean).map(parseAtom));
}

const METHODS = new Set([
  'tag', 'source', 'path', 'file', 'fqn', 'package', 'resource_type', 'type', 'config', 'group', 'access',
  'selector', 'exposure', 'test_type', 'test_name', 'state', 'result', 'metric', 'semantic_model', 'saved_query',
  'source_status', 'unit_test', 'version', 'wildcard', 'column', 'owner',
]);

export function parseAtom(raw: string): Atom {
  const m = /^(@)?(?:(\d*)\+)?(.*?)(?:\+(\d*))?$/.exec(raw)!;
  const rest = m[3];
  const up = m[2] !== undefined;
  const down = m[4] !== undefined;
  let method = '';
  let value = rest;
  const colon = rest.indexOf(':');
  if (colon > 0) {
    const mm = rest.slice(0, colon);
    const base = mm.split('.')[0];
    if (METHODS.has(base)) { method = mm; value = rest.slice(colon + 1); }
  }
  if (!method) method = value.includes('/') || /\.(sql|csv|py)$/.test(value) ? 'path' : 'fqn';
  const depth = (s: string | undefined, on: boolean) => (!on ? 0 : s ? parseInt(s, 10) : INF);
  return { method, value, parents: depth(m[2], up), children: depth(m[4], down), childrensParents: !!m[1] };
}

function globToRegex(g: string): RegExp {
  return new RegExp('^' + g.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
}

interface Idx { byTag: Map<string, string[]>; byKey: Map<string, string[]> }
const idxCache = new WeakMap<Graph, Idx>();
function indexOf(g: Graph): Idx {
  let i = idxCache.get(g);
  if (i) return i;
  i = { byTag: new Map(), byKey: new Map() };
  const put = (m: Map<string, string[]>, k: string, id: string) => { const a = m.get(k); if (a) a.push(id); else m.set(k, [id]); };
  for (const n of Object.values(g.nodes)) {
    n.tags.forEach((t) => put(i!.byTag, t, n.id));
    if (n.type === 'exposure') continue;
    // bare selector value matches: model name, package, or first folder below the package
    new Set([n.name, n.fqn[0], n.type === 'source' ? undefined : n.fqn[1]]).forEach((k) => k && put(i!.byKey, k, n.id));
  }
  idxCache.set(g, i);
  return i;
}

function matchMethod(g: Graph, atom: Atom, depth = 0): Set<string> {
  const out = new Set<string>();
  const { method, value } = atom;
  const nodes = Object.values(g.nodes);
  const re = value.includes('*') || value.includes('?') ? globToRegex(value) : null;
  const eq = (s: string) => (re ? re.test(s) : s === value);
  const add = (n: GNode) => out.add(n.id);

  if (method === 'selector') {
    const def = g.selectors[value];
    if (!def) throw new SelectorError(`Named selector '${value}' not found`);
    if (depth > 20) throw new SelectorError(`Selector recursion at '${value}'`);
    return evalDefinition(g, def.definition ?? def, depth + 1);
  }
  const [base, ...subs] = method.split('.');
  // fast paths for the overwhelmingly common exact lookups
  if (!re && base === 'tag') return new Set(indexOf(g).byTag.get(value) ?? []);
  if (!re && method === 'fqn' && !value.includes('.')) return new Set(indexOf(g).byKey.get(value) ?? []);
  const parts = value.split('.');
  const rx = parts.map((p) => globToRegex(p));
  for (const n of nodes) {
    switch (base) {
      case 'tag': if (n.tags.some(eq)) add(n); break;
      case 'source': {
        if (n.type !== 'source') break;
        const [sn, tn] = value.split('.');
        if (tn === undefined || tn === '*') { if (sn === '*' || n.sourceName === sn || (re && re.test(n.sourceName ?? ''))) add(n); }
        else if (n.sourceName === sn && (tn === '*' || n.name === tn)) add(n);
        break;
      }
      case 'exposure': if (n.type === 'exposure' && eq(n.name)) add(n); break;
      case 'package': if (eq(n.pkg)) add(n); break;
      case 'resource_type': case 'type': if (eq(n.type)) add(n); break;
      case 'group': if (n.group && eq(n.group)) add(n); break;
      case 'access': if (n.access && eq(n.access)) add(n); break;
      case 'config':
        if (subs[0] === 'materialized' && n.materialized && eq(n.materialized)) add(n);
        else if (subs[0] === 'tags' && n.tags.some(eq)) add(n);
        break;
      case 'file': if (n.path && eq(n.path.split('/').pop()!.replace(/\.(sql|py|csv)$/, '')) ) add(n); break;
      case 'path': {
        if (!n.path) break;
        const v = value.replace(/\/$/, '');
        if (re ? re.test(n.path) : n.path === v || n.path.startsWith(v + '/') || n.path === v.replace(/\.sql$/, '') + '.sql') add(n);
        break;
      }
      case 'fqn': {
        if (n.type === 'exposure') break;
        // dbt: bare value matches model name, or an fqn prefix (folder / package), dotted allowed
        const fqn = n.fqn;
        if (re && !value.includes('.')) { if (re.test(n.name) || fqn.some((p, i) => i < fqn.length - 1 && re.test(p))) add(n); break; }
        const fits = (f: string[]) => f.length >= parts.length && rx.every((r, i) => r.test(f[i]));
        if (fits(fqn)) add(n);
        else if (parts.length === 1 && n.name === value) add(n);
        else if (n.type !== 'source' && fqn.length > 1 && fits(fqn.slice(1))) add(n); // omit package prefix
        break;
      }
      default:
        throw new SelectorError(`Selector method '${method}' is not supported statically`);
    }
  }
  return out;
}

function walk(map: Record<string, string[]>, seeds: Set<string>, depth: number): Set<string> {
  const seen = new Set<string>(seeds);
  let frontier = [...seeds];
  for (let d = 0; d < depth && frontier.length; d++) {
    const next: string[] = [];
    for (const id of frontier) for (const n of map[id] ?? []) if (!seen.has(n)) { seen.add(n); next.push(n); }
    frontier = next;
  }
  return seen;
}

function expand(g: Graph, atom: Atom, base: Set<string>): Set<string> {
  let res = base;
  if (atom.childrensParents) {
    const down = walk(g.children, base, INF);
    return walk(g.parents, down, INF);
  }
  if (atom.parents) res = new Set([...res, ...walk(g.parents, base, atom.parents)]);
  if (atom.children) res = new Set([...res, ...walk(g.children, base, atom.children)]);
  return res;
}

const intersect = (a: Set<string>, b: Set<string>) => new Set([...a].filter((x) => b.has(x)));
const minus = (a: Set<string>, b: Set<string>) => new Set([...a].filter((x) => !b.has(x)));

function evalAtoms(g: Graph, expr: Atom[][], depth = 0): Set<string> {
  const union = new Set<string>();
  for (const inter of expr) {
    let acc: Set<string> | null = null;
    for (const atom of inter) {
      const s = expand(g, atom, matchMethod(g, atom, depth));
      acc = acc ? intersect(acc, s) : s;
    }
    if (acc) acc.forEach((x) => union.add(x));
  }
  return union;
}

/** Evaluates a (parsed) named selector definition from manifest/selectors.yml */
function evalDefinition(g: Graph, def: SelectorDef, depth = 0): Set<string> {
  if (typeof def === 'string') return evalAtoms(g, parseExpression(def), depth);
  if (def.union || def.intersection) {
    const key = def.union ? 'union' : 'intersection';
    const items: any[] = def[key];
    const incl = items.filter((i) => !i.exclude);
    const excl = items.filter((i) => i.exclude).flatMap((i) => (Array.isArray(i.exclude) ? i.exclude : [i.exclude]));
    const sets = incl.map((i) => evalDefinition(g, i, depth));
    let res = key === 'union' ? new Set(sets.flatMap((s) => [...s])) : sets.reduce((a, b) => intersect(a, b));
    for (const e of excl) res = minus(res, evalDefinition(g, e, depth));
    return res;
  }
  if (def.method !== undefined) {
    const atom: Atom = {
      method: def.method, value: String(def.value),
      parents: def.parents ? (def.parents_depth ?? INF) : 0,
      children: def.children ? (def.children_depth ?? INF) : 0,
      childrensParents: !!def.childrens_parents,
    };
    let res = expand(g, atom, matchMethod(g, atom, depth));
    if (def.exclude) for (const e of def.exclude) res = minus(res, evalDefinition(g, e, depth));
    return res;
  }
  if (def.definition) return evalDefinition(g, def.definition, depth);
  throw new SelectorError('Unrecognised selector definition');
}

const SELECTABLE = new Set(['model', 'seed', 'snapshot', 'source']);

/**
 * Equivalent of `dbt ls --select <select> --exclude <exclude>` limited to models/seeds/snapshots/sources.
 * Empty select means "everything" (like dbt). `named` mirrors `--selector NAME`.
 */
export function resolve(g: Graph, select: string | null, exclude?: string | null, named?: string): Set<string> {
  let sel: Set<string>;
  if (named) sel = matchMethod(g, parseAtom(`selector:${named}`));
  else if (select && select.trim()) sel = evalAtoms(g, parseExpression(select));
  else sel = new Set(Object.keys(g.nodes));
  if (exclude && exclude.trim()) sel = minus(sel, evalAtoms(g, parseExpression(exclude)));
  return new Set([...sel].filter((id) => SELECTABLE.has(g.nodes[id]?.type)));
}

/**
 * The nodes a selector names *before* graph operators are applied (`+model+1` → `model`). Used to keep the searched
 * model in view when a large selection has to be trimmed, and to center on it.
 */
export function resolveSeeds(g: Graph, select: string): Set<string> {
  const out = new Set<string>();
  for (const inter of parseExpression(select)) {
    let acc: Set<string> | null = null;
    for (const atom of inter) { const s = matchMethod(g, atom); acc = acc ? intersect(acc, s) : s; }
    acc?.forEach((i) => out.add(i));
  }
  return new Set([...out].filter((i) => SELECTABLE.has(g.nodes[i]?.type)));
}
