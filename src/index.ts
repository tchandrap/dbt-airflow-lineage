import * as fs from 'fs';
import * as path from 'path';
import { parseAirflowFile } from './airflow';
import { resolve } from './selector';
import type { Graph, IngestRef, Pipeline, SelectionSite } from './types';

export interface ResolvedSite extends SelectionSite {
  models: string[]; // node ids
  error?: string;
}
export interface ResolvedPipeline extends Omit<Pipeline, 'sites'> {
  sites: ResolvedSite[];
  models: Set<string>;
}

export type IngestMatch = 'exact' | 'case-insensitive' | 'table-only';
export interface IngestInfo {
  pipeline: ResolvedPipeline;
  refs: (IngestRef & { match: IngestMatch })[];
}

export interface TriggerInfo {
  pipeline: ResolvedPipeline;
  sites: ResolvedSite[]; // which of the pipeline's selections picked the model
}

export class LineageIndex {
  readonly pipelines: ResolvedPipeline[] = [];
  private byModel = new Map<string, TriggerInfo[]>();
  private byIngest = new Map<string, IngestInfo[]>();

  constructor(readonly graph: Graph, raw: Pipeline[]) {
    const memo = new Map<string, { ids: string[]; error?: string }>();
    for (const p of raw) {
      const rp: ResolvedPipeline = { ...p, sites: [], models: new Set() };
      for (const s of p.sites) {
        const key = `${s.select}\u0000${s.exclude}\u0000${s.namedSelector}`;
        let r = memo.get(key);
        if (!r) {
          try { r = { ids: s.dynamic && s.select === null ? [] : [...resolve(graph, s.select, s.exclude, s.namedSelector)] }; }
          catch (e: any) { r = { ids: [], error: String(e.message) }; }
          memo.set(key, r);
        }
        rp.sites.push({ ...s, models: r.ids, error: r.error });
        r.ids.forEach((id) => rp.models.add(id));
      }
      this.pipelines.push(rp);
      this.indexIngestion(graph, rp, p.ingests ?? []);
      for (const id of rp.models) {
        const sites = rp.sites.filter((s) => s.models.includes(id));
        let arr = this.byModel.get(id);
        if (!arr) this.byModel.set(id, (arr = []));
        arr.push({ pipeline: rp, sites });
      }
    }
  }

  triggersFor(id: string): TriggerInfo[] { return this.byModel.get(id) ?? []; }

  /** Pipelines whose DAG code loads data into this node's BigQuery table (dataset + table, as in `bq_dataset` / `bq_table`). */
  ingestorsFor(id: string): IngestInfo[] { return this.byIngest.get(id) ?? []; }

  private rel?: { exact: Map<string, string[]>; lower: Map<string, string[]>; table: Map<string, string[]>; tableLower: Map<string, string[]> };
  private relIndex(graph: Graph) {
    if (this.rel) return this.rel;
    const exact = new Map<string, string[]>(), lower = new Map<string, string[]>(), table = new Map<string, string[]>(), tableLower = new Map<string, string[]>();
    const put = (m: Map<string, string[]>, k: string, id: string) => { const a = m.get(k); if (a) a.push(id); else m.set(k, [id]); };
    for (const n of Object.values(graph.nodes)) {
      if (!n.table || n.type === 'exposure') continue;
      if (n.schema) { put(exact, `${n.schema}.${n.table}`, n.id); put(lower, `${n.schema}.${n.table}`.toLowerCase(), n.id); }
      put(table, n.table, n.id); put(tableLower, n.table.toLowerCase(), n.id);
    }
    return (this.rel = { exact, lower, table, tableLower });
  }

  private indexIngestion(graph: Graph, rp: ResolvedPipeline, refs: IngestRef[]) {
    if (!refs.length) return;
    const r = this.relIndex(graph);
    const found = new Map<string, IngestInfo['refs']>();
    for (const ref of refs) {
      let ids: string[] | undefined; let match: IngestMatch = 'exact';
      if (ref.dataset) {
        ids = r.exact.get(`${ref.dataset}.${ref.table}`);
        if (!ids) { ids = r.lower.get(`${ref.dataset}.${ref.table}`.toLowerCase()); match = 'case-insensitive'; }
      } else {
        // no dataset in the DAG code: only trust a table name that is unique in the project
        const e = r.table.get(ref.table);
        if (e?.length === 1) { ids = e; match = 'table-only'; }
      }
      for (const id of ids ?? []) { const a = found.get(id) ?? []; a.push({ ...ref, match }); found.set(id, a); }
    }
    for (const [id, rs] of found) {
      const arr = this.byIngest.get(id) ?? [];
      arr.push({ pipeline: rp, refs: rs });
      this.byIngest.set(id, arr);
    }
  }

  findByPath(relPath: string): string | undefined {
    const norm = relPath.replace(/\\/g, '/');
    return Object.values(this.graph.nodes).find((n) => n.path && (norm === n.path || norm.endsWith('/' + n.path)))?.id;
  }
}

export function scanAirflow(dirs: string[]): Pipeline[] {
  const out: Pipeline[] = [];
  const skip = new Set(['__pycache__', 'node_modules', '.git', '.venv', 'venv']);
  const walk = (d: string) => {
    let ents: fs.Dirent[];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!skip.has(e.name)) walk(p); }
      else if (e.name.endsWith('.py')) {
        try {
          const src = fs.readFileSync(p, 'utf8');
          if (!/dbt|selector|bq_table|bq_dataset|destination_table|target_table|full_table_schema_reference|destination_project_dataset_table/i.test(src)) continue; // cheap prefilter
          out.push(...parseAirflowFile(p, src));
        } catch { /* unreadable file: ignore */ }
      }
    }
  };
  dirs.forEach(walk);
  return out;
}
