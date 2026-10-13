import { describe, it, expect } from 'vitest';
import { parseAirflowFile } from '../src/airflow';
import { LineageIndex } from '../src/index';
import type { Graph, GNode } from '../src/types';

const DAG = `
ALTO_REPORTS = [
    {
        "name": "tia",
        "bq_dataset": "regulatory_reports_external_sources",
        "bq_table": "antasena_M_tia01",
    },
    {
        "name": "pia",
        "bq_dataset": "regulatory_reports_external_sources",
        "bq_table": "antasena_M_pia01",
    },
]
SUBMITTED = {
    "bq_table": "antasena_m_tia01_submitted",
    "load": {"full_table_schema_reference": f"{GCP_PROJECT_ID}.regulatory_reports_external_sources.antasena_m_tia01_submitted", "dataset_outlet": "x__y"},
}
@dag(
    dag_id=get_dag_id(__file__),
    schedule="0 0 3 * *",
)
def regulatory_reports_ingest_alto_reports():
    pass
`;

describe('ingestion targets in DAG code', () => {
  const [p] = parseAirflowFile('/dags/regulatory_report/regulatory_reports_ingest_alto_reports.py', DAG);
  it('attaches them to the file DAG, with its schedule (not to the "tia"/"pia" dict names)', () => {
    expect(p.name).toBe('regulatory_reports_ingest_alto_reports');
    expect(p.schedule).toBe('0 0 3 * *');
    const refs = (p.ingests ?? []).map((r) => `${r.dataset ?? '?'}.${r.table}`).sort();
    expect(refs).toEqual([
      'regulatory_reports_external_sources.antasena_M_pia01',
      'regulatory_reports_external_sources.antasena_M_tia01',
      'regulatory_reports_external_sources.antasena_m_tia01_submitted',
      '?.antasena_m_tia01_submitted',
    ].sort());
  });
  it('does NOT treat partition checks / readers with generic dataset+table keys as ingestion', () => {
    const src = `TASKS = [
      {"name": "partition_check__one_reporting_views__term_deposit__non_aro_td", "dataset": "one_reporting_views", "table": "term_deposit", "date_column": "business_date"},
      {"name": "partition_check__dwh_core__fx", "dataset": "dwh_core", "table": "currency_exchange_rate_daily_snapshot", "partitioned_table": False},
    ]
    @dag(schedule="@daily")
    def f(): pass`;
    expect(parseAirflowFile('/d/mco_report/analysis_task_list.py', src)).toHaveLength(0);
  });
  it('ignores dynamic tables and unrelated keys', () => {
    const [q] = parseAirflowFile('/d/x.py', 'X = {"bq_dataset": ds, "bq_table": f"t_{n}", "table": "plain", "dag": 1}\n@dag(schedule="@daily")\ndef f(): pass');
    expect(q?.ingests ?? []).toHaveLength(0);
  });
});

const mk = (name: string, o: Partial<GNode>): GNode => ({ id: `${o.type ?? 'model'}.p.${name}`, name, type: 'model', tags: [], fqn: ['p', name], path: `x/${name}.yml`, pkg: 'p', ...o });
describe('matching ingestion to dbt nodes', () => {
  const src = mk('antasena_M_tia01', { type: 'source', sourceName: 'regulatory_reports_external_sources', schema: 'regulatory_reports_external_sources', table: 'antasena_M_tia01' });
  const lower = mk('antasena_m_tia01_submitted', { type: 'source', sourceName: 'regulatory_reports_external_sources', schema: 'regulatory_reports_external_sources', table: 'antasena_m_tia01_submitted' });
  const model = mk('regulatory_reports__antasena_m_tia01', { schema: 'regulatory_reports', table: 'antasena_m_tia01' });
  const g: Graph = { nodes: Object.fromEntries([src, lower, model].map((n) => [n.id, n])), parents: {}, children: {}, selectors: {} };
  [src, lower, model].forEach((n) => { g.parents[n.id] = []; g.children[n.id] = []; });
  const raw = parseAirflowFile('/dags/ingest.py', DAG);
  const idx = new LineageIndex(g, raw);

  it('finds the pipeline for the source by dataset + table, case-sensitively', () => {
    const a = idx.ingestorsFor(src.id);
    expect(a).toHaveLength(1);
    expect(a[0].pipeline.name).toBe('ingest');
    expect(a[0].refs[0]).toMatchObject({ match: 'exact', table: 'antasena_M_tia01' });
    // the lower-case sibling table is a different table: it must not be claimed by the M_tia01 entry
    expect(idx.ingestorsFor(lower.id)[0].refs.map((r) => r.table)).toEqual(['antasena_m_tia01_submitted', 'antasena_m_tia01_submitted']);
  });
  it('does not attribute ingestion to a dbt model that merely has a similar name', () => {
    expect(idx.ingestorsFor(model.id)).toHaveLength(0);
  });
  it('falls back to case-insensitive and unique-table-only matches, flagged as such', () => {
    const r1 = new LineageIndex(g, parseAirflowFile('/d/a.py', 'X={"bq_dataset":"regulatory_reports_external_sources","bq_table":"ANTASENA_M_TIA01"}\n@dag(schedule="@daily")\ndef f(): pass'));
    expect(r1.ingestorsFor(src.id)[0].refs[0].match).toBe('case-insensitive');
    const r2 = new LineageIndex(g, parseAirflowFile('/d/b.py', 'X={"bq_table":"antasena_M_tia01"}\n@dag(schedule="@daily")\ndef f(): pass'));
    expect(r2.ingestorsFor(src.id)[0].refs[0].match).toBe('table-only');
  });
});

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scanAirflow } from '../src/index';

describe('scanAirflow prefilter', () => {
  it('still reads ingestion DAGs that never mention dbt', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dags-'));
    fs.writeFileSync(path.join(dir, 'ingest_only.py'), 'T = [{"bq_dataset": "raw", "bq_table": "orders"}]\n@dag(dag_id="ingest_only", schedule="@hourly")\ndef f(): pass\n');
    fs.writeFileSync(path.join(dir, 'unrelated.py'), 'print("hello")\n');
    try {
      const found = scanAirflow([dir]);
      expect(found).toHaveLength(1);
      expect(found[0].ingests?.[0]).toMatchObject({ dataset: 'raw', table: 'orders' });
      expect(found[0].schedule).toBe('@hourly');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
