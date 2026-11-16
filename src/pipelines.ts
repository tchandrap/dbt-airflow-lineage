import type { Pipeline } from './types';

/**
 * Which Airflow pipelines the extension shows: an include / exclude filter from the settings, and one entry per DAG name.
 * Pure (no `vscode`), so it is shared with the MCP server and unit tested.
 */

const clean = (l: readonly string[] | undefined) => (l ?? []).map((x) => String(x).trim()).filter(Boolean);
const body = (glob: string) => glob.replace(/\\/g, '/').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');

/**
 * A pattern matches a pipeline by its DAG name (`my_dag`, `my_*`), by its file (`dags/my_dag.py`, `my_dag.py`) or by a
 * folder it sits in (`generated_dags`). `*` matches any text and `?` one character; letter case is ignored.
 */
export function matchesPattern(p: Pick<Pipeline, 'name' | 'file'>, pattern: string): boolean {
  const b = body(pattern.trim());
  if (!b) return false;
  const file = p.file.replace(/\\/g, '/');
  return new RegExp(`^${b}$`, 'i').test(p.name) || new RegExp(`(^|/)${b}$`, 'i').test(file) || new RegExp(`(^|/)${b}/`, 'i').test(file);
}

/** Keeps the pipelines that match `include` (all when it is empty) and do not match `exclude`. */
export function filterPipelines(list: Pipeline[], include: readonly string[] | undefined, exclude: readonly string[] | undefined): Pipeline[] {
  const inc = clean(include), exc = clean(exclude);
  return list.filter((p) => (!inc.length || inc.some((x) => matchesPattern(p, x))) && !exc.some((x) => matchesPattern(p, x)));
}

const GENERATED = /generated|autogen|auto_gen/i;
const siteKey = (s: Pipeline['sites'][number]) => `${s.select}\u0000${s.exclude}\u0000${s.namedSelector}\u0000${s.dynamic}`;

function mergeGroup(g: Pipeline[]): Pipeline {
  if (g.length === 1) return g[0];
  const primary = g.find((p) => !GENERATED.test(p.file)) ?? g[0]; // the hand-written definition, not the generated copy
  const others = g.filter((p) => p !== primary);
  const sites = [...primary.sites];
  const seen = new Set(sites.map(siteKey));
  for (const o of others) for (const s of o.sites) if (!seen.has(siteKey(s))) { seen.add(siteKey(s)); sites.push(s); }
  const ingests = [...(primary.ingests ?? [])];
  for (const o of others) for (const r of o.ingests ?? []) if (!ingests.some((x) => x.table === r.table && x.dataset === r.dataset)) ingests.push(r);
  const alsoIn: { file: string; line: number }[] = [];
  for (const o of others) if (o.file !== primary.file && !alsoIn.some((a) => a.file === o.file)) alsoIn.push({ file: o.file, line: o.line });
  return { ...primary, sites, ingests: ingests.length ? ingests : undefined, schedule: primary.schedule ?? others.find((o) => o.schedule)?.schedule, alsoIn: alsoIn.length ? alsoIn : undefined };
}

/**
 * A DAG id is unique in Airflow, so the same name found in several files (a config file and the DAG file generated from it, for example)
 * is one pipeline: its selections are combined and the other files are listed in `alsoIn`. Pipelines named only after their file are never merged.
 */
export function mergeByName(list: Pipeline[]): Pipeline[] {
  const groups = new Map<string, Pipeline[]>();
  const order: (Pipeline | string)[] = [];
  for (const p of list) {
    if (!p.explicitName) { order.push(p); continue; }
    const g = groups.get(p.name);
    if (g) g.push(p); else { groups.set(p.name, [p]); order.push(p.name); }
  }
  return order.map((x) => (typeof x === 'string' ? mergeGroup(groups.get(x)!) : x));
}

export interface PipelineFilter { include?: readonly string[]; exclude?: readonly string[] }

/** Filter first (so excluding the generated folder keeps the hand-written definition), then one entry per DAG name. */
export const preparePipelines = (raw: Pipeline[], f: PipelineFilter = {}): Pipeline[] => mergeByName(filterPipelines(raw, f.include, f.exclude));
