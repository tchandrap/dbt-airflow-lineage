import * as fs from 'fs';
import * as path from 'path';
import { LineageIndex, scanAirflow } from '../index';
import { slim } from '../slim';
import type { ReportConfig } from '../tools';
import type { Graph } from '../types';

/**
 * Builds the lineage index for the MCP server from environment variables set by the extension (or by hand for Claude Code):
 *   DBT_AIRFLOW_GRAPH     slim graph cache written by the extension (fast; preferred)
 *   DBT_AIRFLOW_MANIFEST  path to manifest.json (used when there is no usable cache)
 *   DBT_AIRFLOW_DAGS      Airflow DAG folders, separated like PATH
 *   DBT_AIRFLOW_REPORT_INCLUDE / _EXCLUDE and DBT_AIRFLOW_CRITICAL_INCLUDE / _EXCLUDE   what counts as a report / a critical model (JSON arrays of entries, see tools.ts)
 * Loaded lazily and reloaded when the files change, so a long-running server does not go stale.
 */

const mtime = (p: string | undefined) => { try { return p ? fs.statSync(p).mtimeMs : 0; } catch { return 0; } };

const list = (v: string | undefined): string[] => { try { const x = JSON.parse(v ?? '[]'); return Array.isArray(x) ? x.map(String) : []; } catch { return []; } };

export function reportFromEnv(env: NodeJS.ProcessEnv): ReportConfig {
  return { include: list(env.DBT_AIRFLOW_REPORT_INCLUDE), exclude: list(env.DBT_AIRFLOW_REPORT_EXCLUDE), critical: list(env.DBT_AIRFLOW_CRITICAL_INCLUDE), criticalExclude: list(env.DBT_AIRFLOW_CRITICAL_EXCLUDE) };
}

export function makeLoader(env: NodeJS.ProcessEnv): () => { index: LineageIndex } | { error: string } {
  let cached: { key: string; index: LineageIndex } | undefined;
  return () => {
    const graphFile = env.DBT_AIRFLOW_GRAPH, manifest = env.DBT_AIRFLOW_MANIFEST;
    const dags = (env.DBT_AIRFLOW_DAGS ?? '').split(path.delimiter).filter(Boolean);
    const key = [mtime(graphFile), mtime(manifest), ...dags.map(mtime)].join('|');
    if (cached?.key === key) return { index: cached.index };
    try {
      let graph: Graph | undefined;
      if (graphFile && fs.existsSync(graphFile)) graph = JSON.parse(fs.readFileSync(graphFile, 'utf8'));
      else if (manifest && fs.existsSync(manifest)) graph = slim(JSON.parse(fs.readFileSync(manifest, 'utf8')));
      if (!graph) return { error: 'No dbt manifest found. Open the dbt project in the editor once, or run `dbt parse` so target/manifest.json exists (set DBT_AIRFLOW_MANIFEST for a standalone setup).' };
      const index = new LineageIndex(graph, dags.length ? scanAirflow(dags) : []);
      cached = { key, index };
      return { index };
    } catch (e: any) { return { error: `Could not load the dbt project: ${e?.message ?? e}` }; }
  };
}
