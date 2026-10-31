import type { LineageIndex } from './index';
import { resolve } from './selector';
import { neighborhood } from './graph';
import type { GNode, Graph } from './types';

/**
 * The questions an AI assistant (VS Code agent, Cursor agent, any MCP client) can ask about the project.
 * Pure: no `vscode` import, so the extension and an MCP server share it. Every tool returns short plain text.
 * Nothing here runs unless the optional AI feature is switched on and something calls it.
 */

/**
 * What counts as a report: a list of entries that are combined (union), minus an exclude list. An entry is one of
 *   exposures            every dbt exposure           exposure:weekly_*   exposures by name
 *   tag:report           models with a tag            folder:reporting    models under a folder (name or path)
 *   file:rpt_pnl.sql     one file (or model name)     path:models/marts   dbt path selector (folder or file)
 *   any dbt selector     e.g. tag:finance,config.materialized:view   or   rpt_*
 * A plain entry containing a "/" is read as a folder.
 */
/** `include`/`exclude` define the reports; `critical`/`criticalExclude` define the critical models (same entry syntax). A change "impacts" both. */
export interface ReportConfig { include: string[]; exclude: string[]; critical?: string[]; criticalExclude?: string[] }
export const defaultReportConfig = (): ReportConfig => ({ include: [], exclude: [] });

const CAP = 40;
const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
const clean = (l: readonly string[] | undefined) => (l ?? []).map((x) => String(x).trim()).filter(Boolean);
const globToRe = (g: string) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');

/** The early builds had a single `reports.mode` (exposures, tag or folder) and `reports.value`: the same thing as one entry of the new list. */
export function legacyReportEntry(mode: unknown, value: unknown): string | undefined {
  const v = typeof value === 'string' ? value.trim() : '';
  if (mode === 'exposures') return 'exposures';
  if (mode === 'tag' && v) return `tag:${v}`;
  if (mode === 'folder' && v) return `folder:${v}`;
  return undefined;
}

export const reportsConfigured = (cfg: ReportConfig) => clean(cfg.include).length > 0 || clean(cfg.critical).length > 0;
export const criticalIds = (g: Graph, cfg: ReportConfig): Set<string> => reportMatch(g, { include: cfg.critical ?? [], exclude: cfg.criticalExclude ?? [] }).ids;

/** The nodes one entry matches (sources never count as reports). */
function entryIds(g: Graph, entry: string): { ids: Set<string>; error?: string } {
  const ids = new Set<string>();
  const nodes = Object.values(g.nodes);
  const e = entry.trim();
  const lower = e.toLowerCase();
  const reportable = (n: GNode) => n.type !== 'source';
  try {
    if (lower === 'exposures') { for (const n of nodes) if (n.type === 'exposure') ids.add(n.id); }
    else if (lower.startsWith('exposure:')) { const re = globToRe(e.slice(9)); for (const n of nodes) if (n.type === 'exposure' && re.test(n.name)) ids.add(n.id); }
    else if (lower.startsWith('folder:') || (!e.includes(':') && e.includes('/'))) {
      const v = norm(e.replace(/^folder:/i, ''));
      if (v) for (const n of nodes) if (reportable(n) && n.type !== 'exposure') { const p = '/' + norm(n.path ?? ''); if (p.startsWith(`/${v}/`) || p.includes(`/${v}/`)) ids.add(n.id); }
    }
    else if (lower.startsWith('file:')) {
      const v = norm(e.slice(5)), bare = v.replace(/\.(sql|py|csv)$/i, '').split('/').pop()!.toLowerCase();
      for (const n of nodes) if (reportable(n) && n.type !== 'exposure') { const p = norm(n.path ?? ''); if (p === v || p.endsWith('/' + v) || (!v.includes('/') && n.name.toLowerCase() === bare)) ids.add(n.id); }
    }
    else for (const id of resolve(g, e)) if (reportable(g.nodes[id])) ids.add(id);
  } catch (err: any) { return { ids: new Set(), error: String(err?.message ?? err) }; }
  return { ids };
}

export interface ReportMatch { ids: Set<string>; include: { entry: string; count: number; error?: string }[]; exclude: { entry: string; count: number; error?: string }[] }

/** The report nodes for a definition, plus how many each entry matched (so a wrong entry is easy to spot). */
export function reportMatch(g: Graph, cfg: ReportConfig): ReportMatch {
  const ids = new Set<string>();
  const include = clean(cfg.include).map((entry) => { const r = entryIds(g, entry); r.ids.forEach((i) => ids.add(i)); return { entry, count: r.ids.size, error: r.error }; });
  const exclude = clean(cfg.exclude).map((entry) => { const r = entryIds(g, entry); r.ids.forEach((i) => ids.delete(i)); return { entry, count: r.ids.size, error: r.error }; });
  return { ids, include, exclude };
}

export const reportIds = (g: Graph, cfg: ReportConfig): Set<string> => reportMatch(g, cfg).ids;

export type Resolved = { ok: true; id: string } | { ok: false; error: string };

/** A model given by node id or name (case-insensitive). Unknown or ambiguous names come back with suggestions. */
export function resolveModel(g: Graph, ref: string): Resolved {
  const q = ref.trim();
  if (g.nodes[q]) return { ok: true, id: q };
  const lower = q.toLowerCase();
  const exact = Object.values(g.nodes).filter((n) => n.name.toLowerCase() === lower);
  if (exact.length === 1) return { ok: true, id: exact[0].id };
  if (exact.length > 1) return { ok: false, error: `"${q}" is ambiguous: ${exact.slice(0, 5).map((n) => `${n.type} ${n.id}`).join('; ')}. Use the full id.` };
  const near = Object.values(g.nodes).filter((n) => n.name.toLowerCase().includes(lower)).slice(0, 5).map((n) => n.name);
  return { ok: false, error: `No model named "${q}".${near.length ? ` Did you mean: ${near.join(', ')}?` : ' Try find_models.'}` };
}

const label = (n: GNode) => `${n.name} (${n.type === 'model' ? n.materialized ?? 'model' : n.type})`;
const more = (total: number, shown: number) => (total > shown ? `\n… and ${total - shown} more` : '');

export function findModels(idx: LineageIndex, query: string, limit = 20): string {
  const g = idx.graph, q = query.trim().toLowerCase();
  if (!q) return 'Give a name, part of a name, or tag:<name>.';
  const tag = q.startsWith('tag:') ? q.slice(4) : null;
  const hits = Object.values(g.nodes)
    .filter((n) => (tag !== null ? n.tags.some((t) => t.toLowerCase() === tag) : n.name.toLowerCase().includes(q) || (n.path ?? '').toLowerCase().includes(q)))
    .sort((a, b) => Number(b.name.toLowerCase().startsWith(q)) - Number(a.name.toLowerCase().startsWith(q)) || a.name.localeCompare(b.name));
  if (!hits.length) return `Nothing matches "${query}".`;
  const lim = Math.min(Math.max(1, limit), CAP);
  return hits.slice(0, lim).map((n) => `${label(n)}${n.tags.length ? ` [${n.tags.join(', ')}]` : ''} ${n.path ?? ''}`.trim()).join('\n') + more(hits.length, lim);
}

export function lineage(idx: LineageIndex, ref: string, up = 2, down = 2): string {
  const g = idx.graph, r = resolveModel(g, ref);
  if (!r.ok) return r.error;
  const level = neighborhood(g, r.id, Math.min(up, 10), Math.min(down, 10));
  const ids = [...level.keys()].sort((a, b) => level.get(a)! - level.get(b)! || g.nodes[a].name.localeCompare(g.nodes[b].name));
  const shown = ids.slice(0, CAP * 2), set = new Set(shown);
  const lines = shown.map((i) => `${level.get(i)! > 0 ? '+' : ''}${level.get(i)}  ${label(g.nodes[i])}`);
  const edges: string[] = [];
  for (const a of shown) for (const b of g.children[a] ?? []) if (set.has(b)) edges.push(`${g.nodes[a].name} -> ${g.nodes[b].name}`);
  return `${g.nodes[r.id].name}: ${ids.length} nodes within ${up} up / ${down} down (level: negative = upstream, positive = downstream)\n${lines.join('\n')}${more(ids.length, shown.length)}\nEdges:\n${edges.join('\n') || '(none)'}`;
}

export interface Impacted { id: string; name: string; kinds: ('report' | 'critical')[]; hops: number; path: string[]; pathIds: string[]; pipelines: string[] }

/** `daily_core (0 3 * * *)`: a pipeline with its schedule when the DAG code states one. */
const withSchedule = (p: { name: string; schedule?: string }) => (p.schedule ? `${p.name} (${p.schedule})` : p.name);

/** Reports downstream of a model (or the model itself when it is one), nearest first, with the shortest path and the pipelines that run them. */
export function impactedReports(idx: LineageIndex, ref: string, cfg: ReportConfig): { error: string } | { model: string; reports: Impacted[]; downstream: number } {
  const g = idx.graph, r = resolveModel(g, ref);
  if (!r.ok) return { error: r.error };
  const reports = reportIds(g, cfg);
  const critical = criticalIds(g, cfg);
  const prev = new Map<string, string | null>([[r.id, null]]);
  const depth = new Map<string, number>([[r.id, 0]]);
  for (let fr = [r.id]; fr.length;) {
    const next: string[] = [];
    for (const n of fr) for (const c of g.children[n] ?? []) if (!prev.has(c)) { prev.set(c, n); depth.set(c, depth.get(n)! + 1); next.push(c); }
    fr = next;
  }
  const out: Impacted[] = [];
  for (const id of prev.keys()) {
    if (!reports.has(id) && !critical.has(id)) continue;
    const pathIds: string[] = [];
    for (let c: string | null | undefined = id; c; c = prev.get(c)) pathIds.unshift(c);
    const path = pathIds.map((c) => g.nodes[c].name);
    out.push({ id, name: g.nodes[id].name, kinds: [...(reports.has(id) ? ['report' as const] : []), ...(critical.has(id) ? ['critical' as const] : [])], hops: depth.get(id)!, path, pathIds, pipelines: idx.triggersFor(id).map((t) => withSchedule(t.pipeline)) });
  }
  out.sort((a, b) => a.hops - b.hops || a.name.localeCompare(b.name));
  return { model: g.nodes[r.id].name, reports: out, downstream: prev.size - 1 };
}

export const reportDefinition = (cfg: ReportConfig) => `${[clean(cfg.include).length ? `reports: ${clean(cfg.include).join(' + ')}` : '', clean(cfg.critical).length ? `critical: ${clean(cfg.critical).join(' + ')}` : ''].filter(Boolean).join('; ') || '(none)'}${clean(cfg.exclude).length ? ` excluding ${clean(cfg.exclude).join(', ')}` : ''}`;

export function impactedReportsText(idx: LineageIndex, ref: string, cfg: ReportConfig): string {
  if (!reportsConfigured(cfg)) return 'No report or critical-model definition is configured. Set dbtAirflow.reports.include (for example ["exposures", "tag:report", "folder:reporting"]) and/or dbtAirflow.critical.include (for example ["tag:critical"]); entries are combined. Or click Impact in the lineage view to choose.';
  const res = impactedReports(idx, ref, cfg);
  if ('error' in res) return res.error;
  const total = reportIds(idx.graph, cfg).size + criticalIds(idx.graph, cfg).size;
  if (!total) return `Nothing matches the definition (${reportDefinition(cfg)}): no reports or critical models were found in this project.`;
  if (!res.reports.length) return `${res.model}: no reports or critical models (${reportDefinition(cfg)}) are downstream. ${res.downstream} downstream node(s) in total.`;
  const line = (x: Impacted) => `${x.name} (${x.hops} hop${x.hops === 1 ? '' : 's'}): ${x.path.join(' -> ')}${x.pipelines.length ? ` | run by ${x.pipelines.join(', ')}` : ''}`;
  const rep = res.reports.filter((x) => x.kinds.includes('report')), crit = res.reports.filter((x) => x.kinds.includes('critical'));
  const part = (title: string, l: Impacted[]) => (l.length ? `${title} (${l.length}):\n${l.slice(0, CAP).map(line).join('\n')}${more(l.length, Math.min(l.length, CAP))}` : '');
  return `${res.model} impacts ${rep.length} report(s) and ${crit.length} critical model(s), out of ${res.downstream} downstream node(s) (${reportDefinition(cfg)}):\n${[part('Critical models', crit), part('Reports', rep)].filter(Boolean).join('\n')}`;
}

export function pipelinesFor(idx: LineageIndex, ref: string): string {
  const g = idx.graph, r = resolveModel(g, ref);
  if (!r.ok) return r.error;
  const lines: string[] = [];
  for (const t of idx.triggersFor(r.id)) {
    const s = t.sites.map((x) => `${x.namedSelector ? `--selector ${x.namedSelector}` : x.select ?? '(dynamic)'}${x.exclude ? ` --exclude ${x.exclude}` : ''}`).join(' | ');
    lines.push(`runs: ${t.pipeline.name} (${t.pipeline.file}${t.pipeline.schedule ? `, schedule ${t.pipeline.schedule}` : ''}) via ${s}`);
  }
  for (const i of idx.ingestorsFor(r.id)) lines.push(`loads the table: ${i.pipeline.name} (${i.pipeline.file})`);
  return lines.length ? `${g.nodes[r.id].name}:\n${lines.join('\n')}` : `${g.nodes[r.id].name}: no Airflow pipeline runs or loads it.`;
}

export function modelsForPipeline(idx: LineageIndex, name: string, limit = 30): string {
  const q = name.trim().toLowerCase();
  const hit = idx.pipelines.find((p) => p.id.toLowerCase() === q || p.name.toLowerCase() === q) ?? idx.pipelines.filter((p) => p.name.toLowerCase().includes(q))[0];
  if (!hit) return `No pipeline named "${name}".${idx.pipelines.length ? ` Examples: ${idx.pipelines.slice(0, 5).map((p) => p.name).join(', ')}` : ' No Airflow pipelines are loaded.'}`;
  const names = [...hit.models].map((i) => idx.graph.nodes[i]?.name).filter(Boolean).sort();
  const lim = Math.min(Math.max(1, limit), CAP);
  return `${hit.name} (${hit.file}) selects ${names.length} node(s):\n${names.slice(0, lim).join('\n')}${more(names.length, lim)}`;
}

export function resolveSelectorText(idx: LineageIndex, select: string, exclude = '', limit = 30): string {
  try {
    const ids = [...resolve(idx.graph, select, exclude)];
    const names = ids.map((i) => idx.graph.nodes[i].name).sort();
    const lim = Math.min(Math.max(1, limit), CAP);
    return `${names.length} node(s) selected by "${select}"${exclude ? ` excluding "${exclude}"` : ''}:\n${names.slice(0, lim).join('\n')}${more(names.length, lim)}`;
  } catch (e: any) { return `Could not resolve the selector: ${e.message}`; }
}

export interface ToolDef { name: string; description: string; inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] } }
const str = (description: string) => ({ type: 'string', description });
const int = (description: string) => ({ type: 'integer', description });

export const TOOLS: ToolDef[] = [
  { name: 'find_models', description: 'Find dbt models, sources, seeds or snapshots by part of a name, path, or tag:<name>. Use it first when you only have an approximate name.', inputSchema: { type: 'object', properties: { query: str('Part of a name or path, or tag:<name>'), limit: int('Maximum results (default 20)') }, required: ['query'] } },
  { name: 'lineage', description: 'Upstream and downstream lineage of one model, limited to a number of levels.', inputSchema: { type: 'object', properties: { model: str('Model name or node id'), up: int('Levels upstream (default 2)'), down: int('Levels downstream (default 2)') }, required: ['model'] } },
  { name: 'impacted_reports', description: 'What is affected if this model changes: the reports and the critical models downstream of it, with the shortest path and the Airflow pipelines (and schedules) that run each. What counts as a report or a critical model depends on the project settings.', inputSchema: { type: 'object', properties: { model: str('Model name or node id') }, required: ['model'] } },
  { name: 'pipelines_for', description: 'Which Airflow pipelines run this model (via their dbt selectors) or load its table.', inputSchema: { type: 'object', properties: { model: str('Model name or node id') }, required: ['model'] } },
  { name: 'models_for_pipeline', description: 'Which dbt models an Airflow pipeline (DAG) selects.', inputSchema: { type: 'object', properties: { pipeline: str('Pipeline (DAG) name or id'), limit: int('Maximum models (default 30)') }, required: ['pipeline'] } },
  { name: 'resolve_selector', description: 'The models a dbt selector picks (like `dbt ls --select X --exclude Y`): names, tag:, path:, source:, + and N+ operators, unions and intersections.', inputSchema: { type: 'object', properties: { select: str('dbt --select expression'), exclude: str('dbt --exclude expression (optional)'), limit: int('Maximum models listed (default 30)') }, required: ['select'] } },
];

const asStr = (v: unknown) => (typeof v === 'string' ? v : '');
const asInt = (v: unknown, d: number) => (v !== '' && v !== null && v !== undefined && Number.isFinite(Number(v)) ? Math.round(Number(v)) : d);

/** Runs one tool by name. Never throws: a bad call comes back as text the model can act on. */
export function runTool(idx: LineageIndex, cfg: ReportConfig, name: string, args: Record<string, unknown> = {}): string {
  try {
    switch (name) {
      case 'find_models': return findModels(idx, asStr(args.query), asInt(args.limit, 20));
      case 'lineage': return lineage(idx, asStr(args.model), asInt(args.up, 2), asInt(args.down, 2));
      case 'impacted_reports': return impactedReportsText(idx, asStr(args.model), cfg);
      case 'pipelines_for': return pipelinesFor(idx, asStr(args.model));
      case 'models_for_pipeline': return modelsForPipeline(idx, asStr(args.pipeline), asInt(args.limit, 30));
      case 'resolve_selector': return resolveSelectorText(idx, asStr(args.select), asStr(args.exclude), asInt(args.limit, 30));
      default: return `Unknown tool "${name}". Available: ${TOOLS.map((t) => t.name).join(', ')}.`;
    }
  } catch (e: any) { return `The tool failed: ${e?.message ?? e}`; }
}
