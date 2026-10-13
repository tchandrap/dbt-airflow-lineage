import type { LineageIndex } from './index';
import { parseExpression, resolve, resolveSeeds } from './selector';
import type { GNode, Graph } from './types';

export function neighborhood(g: Graph, id: string, up: number, down: number = up) {
  const level = new Map<string, number>([[id, 0]]);
  const bfs = (map: Record<string, string[]>, sign: 1 | -1, depth: number) => {
    let fr = [id];
    for (let d = 1; d <= depth && fr.length; d++) {
      const nx: string[] = [];
      for (const n of fr) for (const m of map[n] ?? []) if (!level.has(m)) { level.set(m, d * sign); nx.push(m); }
      fr = nx;
    }
  };
  bfs(g.parents, -1, up); bfs(g.children, 1, down);
  return level;
}

/** Keep the nodes nearest to the searched model(s): breadth-first from the seeds, then the rest by name. */
function orderBySeeds(g: Graph, matched: Set<string>, seeds: string[]): string[] {
  const byName = (a: string, b: string) => g.nodes[a].name.localeCompare(g.nodes[b].name);
  const seen = new Set<string>();
  const out: string[] = [];
  let frontier = seeds.filter((i) => matched.has(i)).sort(byName);
  frontier.forEach((i) => seen.add(i));
  while (frontier.length) {
    out.push(...frontier);
    const next: string[] = [];
    for (const n of frontier) for (const m of [...(g.parents[n] ?? []), ...(g.children[n] ?? [])]) if (matched.has(m) && !seen.has(m)) { seen.add(m); next.push(m); }
    frontier = next.sort(byName);
  }
  out.push(...[...matched].filter((i) => !seen.has(i)).sort(byName));
  return out;
}

/**
 * A single selector atom with graph operators (`1+m+1`, `m+1`, `+m`) already defines its own lineage depth.
 * Returns the depths it asks for (Infinity = unlimited), or null when the selector is not a lone graph atom.
 */
export function selectorDepth(select: string): { up: number; down: number } | null {
  try {
    const expr = parseExpression(select);
    if (expr.length !== 1 || expr[0].length !== 1) return null;
    const a = expr[0][0];
    if (a.childrensParents || (!a.parents && !a.children)) return null;
    return { up: a.parents, down: a.children };
  } catch { return null; }
}

/**
 * Whole-project scope: grow the selection by `up` levels upstream / `down` levels downstream (breadth-first, all matched
 * nodes at once) so e.g. a bare model name still shows its lineage. Stops at the node cap.
 */
function addContext(g: Graph, ids: Set<string>, up: number, down: number) {
  const walk = (map: Record<string, string[]>, depth: number) => {
    let frontier = [...ids];
    for (let d = 0; d < depth && frontier.length && ids.size < MAX_PROJECT_NODES; d++) {
      const next: string[] = [];
      for (const n of frontier) for (const m of map[n] ?? []) if (!ids.has(m) && ids.size < MAX_PROJECT_NODES) { ids.add(m); next.push(m); }
      frontier = next;
    }
  };
  const seeds = new Set(ids);
  walk(g.parents, up);
  const afterUp = new Set(ids);
  ids.clear(); seeds.forEach((i) => ids.add(i));
  walk(g.children, down);
  afterUp.forEach((i) => ids.add(i));
}

export interface FilterState { select: string; exclude: string; tags: string[]; tagMode: 'any' | 'all'; kinds: string[]; scope: 'lineage' | 'project'; hide: boolean; context: boolean }
export const defaultFilter = (): FilterState => ({ select: '', exclude: '', tags: [], tagMode: 'any', kinds: [], scope: 'lineage', hide: false, context: true });
const MAX_PROJECT_NODES = 400;
const KINDS = ['table', 'view', 'incremental', 'ephemeral', 'materialized_view'];

/** Color/legend category: model materialisation, or the resource type for everything else. */
export const kindOf = (n: GNode) => (n.type === 'model' ? (n.materialized && KINDS.includes(n.materialized) ? n.materialized : 'model') : n.type);

/** dbt `--select/--exclude` semantics + tag chips + kind checkboxes → set of node ids (null = no filter active). */
export function computeMatched(g: Graph, filter: FilterState): { ids: Set<string> | null; error?: string } {
  const f = filter;
  if (!(f.select.trim() || f.exclude.trim() || f.tags.length || f.kinds.length)) return { ids: null };
  try {
    let ids = f.select.trim() || f.exclude.trim() ? resolve(g, f.select, f.exclude) : new Set(Object.keys(g.nodes));
    if (f.tags.length) {
      const sets = f.tags.map((t) => resolve(g, `tag:${t}`));
      const tagged = f.tagMode === 'all' ? sets.reduce((x, y) => new Set([...x].filter((i) => y.has(i)))) : new Set(sets.flatMap((x) => [...x]));
      ids = new Set([...ids].filter((i) => tagged.has(i)));
    }
    if (f.kinds.length) ids = new Set([...ids].filter((i) => f.kinds.includes(kindOf(g.nodes[i]))));
    return { ids };
  } catch (e: any) { return { ids: null, error: String(e.message) }; }
}

let allTagsCache: { g: Graph; tags: string[] } | undefined;
const allTags = (g: Graph) => (allTagsCache?.g === g ? allTagsCache.tags : (allTagsCache = { g, tags: [...new Set(Object.values(g.nodes).flatMap((n) => n.tags))].sort() }).tags);

export function buildPayload(index: LineageIndex, filter: FilterState, id: string, up: number, down: number = up) {
  const g = index.graph;
  const { ids: matchedIds, error } = computeMatched(g, filter);
  const sd = filter.scope === 'project' && filter.select.trim() ? selectorDepth(filter.select) : null;
  let ids: Set<string>;
  let truncated = 0;
  let seedIds: string[] = [];
  const level = new Map<string, number>();
  if (filter.scope === 'project' && matchedIds) {
    seedIds = filter.select.trim() ? [...resolveSeeds(g, filter.select)].filter((i) => matchedIds.has(i)) : [];
    const all = orderBySeeds(g, matchedIds, seedIds);
    truncated = Math.max(0, all.length - MAX_PROJECT_NODES);
    ids = new Set(all.slice(0, MAX_PROJECT_NODES));
    if (filter.context && !truncated && !sd) addContext(g, ids, up, down); // a selector with + operators already is the lineage
  } else {
    for (const [k, v] of neighborhood(g, id, up, down)) level.set(k, v);
    ids = new Set(level.keys());
  }
  const nodes = [...ids].map((n) => ({
    id: n, name: g.nodes[n].name, type: g.nodes[n].type, kind: kindOf(g.nodes[n]), tags: g.nodes[n].tags, path: g.nodes[n].path, sourceName: g.nodes[n].sourceName,
    ingest: index.ingestorsFor(n).map((i) => ({ pid: i.pipeline.id, refs: i.refs.map((r) => ({ dataset: r.dataset, table: r.table, line: r.line, match: r.match })) })),
    triggers: index.triggersFor(n).map((t) => ({
      pid: t.pipeline.id,
      sites: t.sites.map((s) => ({ select: s.namedSelector ? `--selector ${s.namedSelector}` : s.select ?? '(dynamic)', exclude: s.exclude ?? undefined, line: s.line })),
    })),
  }));
  const edges: [string, string][] = [];
  for (const n of ids) for (const c of g.children[n] ?? []) if (ids.has(c)) edges.push([n, c]);
  const touches = (p: (typeof index.pipelines)[number], id: string) => p.models.has(id) || index.ingestorsFor(id).some((i) => i.pipeline === p);
  const relevant = index.pipelines.filter((p) => nodes.some((n) => touches(p, n.id)));
  return {
    focus: id, nodes, edges, depthUp: sd ? (Number.isFinite(sd.up) ? sd.up : -1) : up, depthDown: sd ? (Number.isFinite(sd.down) ? sd.down : -1) : down, depthFromSelector: !!sd, filter, filterError: error, truncated,
    matched: matchedIds && (filter.scope === 'lineage' || filter.context) ? [...ids].filter((i) => matchedIds.has(i)) : null,
    matchedTotal: matchedIds?.size ?? null,
    seeds: seedIds.filter((i) => ids.has(i)),
    allTags: allTags(g),
    pipelines: relevant.map((p) => ({
      id: p.id, name: p.name, file: p.file, schedule: p.schedule, count: p.models.size,
      selected: nodes.filter((n) => touches(p, n.id)).map((n) => n.id),
    })),
  };
}

