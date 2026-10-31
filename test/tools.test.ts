import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import { LineageIndex } from '../src/index';
import { criticalIds, legacyReportEntry, impactedReports, impactedReportsText, reportIds, reportMatch, reportsConfigured, resolveModel, runTool, TOOLS } from '../src/tools';
import type { Graph, GNode, Pipeline } from '../src/types';

const mk = (name: string, o: Partial<GNode> = {}): GNode => ({ id: `${o.type ?? 'model'}.p.${name}`, name, type: 'model', tags: [], fqn: ['p', name], path: `models/${name}.sql`, pkg: 'p', ...o });
const nodes = [
  mk('raw', { type: 'source', sourceName: 's' }),
  mk('stg_customer'),
  mk('dim_customer', { path: 'models/marts/dim_customer.sql' }),
  mk('fct_loan', { path: 'models/marts/fct_loan.sql' }),
  mk('rpt_kyc', { tags: ['report'], path: 'models/reporting/rpt_kyc.sql' }),
  mk('rpt_loans', { tags: ['report'], path: 'models/reporting/rpt_loans.sql' }),
  mk('dash', { type: 'exposure', path: 'models/exposures.yml' }),
];
const id = (n: string) => nodes.find((x) => x.name === n)!.id;
const g: Graph = { nodes: Object.fromEntries(nodes.map((n) => [n.id, n])), parents: {}, children: {}, selectors: {} };
nodes.forEach((n) => { g.parents[n.id] = []; g.children[n.id] = []; });
([['raw', 'stg_customer'], ['stg_customer', 'dim_customer'], ['stg_customer', 'fct_loan'], ['dim_customer', 'rpt_kyc'], ['fct_loan', 'rpt_loans'], ['rpt_kyc', 'dash']] as const)
  .forEach(([a, b]) => { g.children[id(a)].push(id(b)); g.parents[id(b)].push(id(a)); });
const raw: Pipeline[] = [{ id: 'dag_daily', name: 'dag_daily', file: 'dags/daily.py', line: 1, schedule: '0 3 * * *', sites: [{ select: 'tag:report', exclude: null, dynamic: false, line: 5, raw: '' }] }];
const idx = new LineageIndex(g, raw);
const tag = { include: ['tag:report'], exclude: [] as string[] };
const only = (...include: string[]) => ({ include, exclude: [] as string[] });

describe('report definition', () => {
  it('exposures, tag and folder', () => {
    expect([...reportIds(g, only('exposures'))]).toEqual([id('dash')]);
    expect([...reportIds(g, tag)].sort()).toEqual([id('rpt_kyc'), id('rpt_loans')].sort());
    expect([...reportIds(g, only('folder:reporting'))].sort()).toEqual([id('rpt_kyc'), id('rpt_loans')].sort());
    expect([...reportIds(g, only('folder:models/marts/'))].sort()).toEqual([id('dim_customer'), id('fct_loan')].sort());
    expect(reportIds(g, only()).size).toBe(0);
    expect([...reportIds(g, only('reporting/'))].sort()).toEqual([id('rpt_kyc'), id('rpt_loans')].sort()); // a plain entry with a slash is a folder
  });
});

describe('report definition: several sources combined', () => {
  it('unions folders, tags, files and selectors, and takes excluded ones out', () => {
    const many = reportIds(g, only('exposures', 'folder:marts', 'file:rpt_kyc.sql'));
    expect([...many].sort()).toEqual([id('dash'), id('dim_customer'), id('fct_loan'), id('rpt_kyc')].sort());
    expect([...reportIds(g, { include: ['tag:report', 'file:models/marts/fct_loan.sql'], exclude: ['rpt_loans'] })].sort()).toEqual([id('fct_loan'), id('rpt_kyc')].sort());
    expect([...reportIds(g, only('tag:report,rpt_k*'))]).toEqual([id('rpt_kyc')]); // a dbt selector (intersection)
    expect([...reportIds(g, only('path:models/reporting'))].sort()).toEqual([id('rpt_kyc'), id('rpt_loans')].sort());
    expect(reportIds(g, only('raw')).size).toBe(0); // sources are never reports
  });
  it('says how many each entry matched and flags a broken entry', () => {
    const m = reportMatch(g, { include: ['tag:report', 'tag:nope', 'state:modified'], exclude: ['rpt_loans'] });
    expect(m.include.map((x) => [x.entry, x.count, !!x.error])).toEqual([['tag:report', 2, false], ['tag:nope', 0, false], ['state:modified', 0, true]]);
    expect(m.exclude).toEqual([{ entry: 'rpt_loans', count: 1, error: undefined }]);
    expect(m.ids.size).toBe(1);
    expect(reportsConfigured(only())).toBe(false);
    expect(reportsConfigured(only(' '))).toBe(false);
    expect(reportsConfigured(only('exposures'))).toBe(true);
  });
});

describe('critical models', () => {
  const both = { include: ['tag:report'], exclude: [] as string[], critical: ['dim_customer', 'file:fct_loan.sql'], criticalExclude: [] as string[] };
  it('are impacted next to the reports, each with its kind', () => {
    const r = impactedReports(idx, 'stg_customer', both);
    if ('error' in r) throw new Error(r.error);
    expect(r.reports.map((x) => [x.name, x.kinds.join('+')]).sort()).toEqual([['dim_customer', 'critical'], ['fct_loan', 'critical'], ['rpt_kyc', 'report'], ['rpt_loans', 'report']]);
    expect(r.reports[0].hops).toBe(1); // nearest first
  });
  it('count as a definition on their own, and one node can be both', () => {
    expect(reportsConfigured({ include: [], exclude: [], critical: ['tag:report'] })).toBe(true);
    const r = impactedReports(idx, 'stg_customer', { include: ['tag:report'], exclude: [], critical: ['rpt_kyc'] });
    if ('error' in r) throw new Error(r.error);
    expect(r.reports.find((x) => x.name === 'rpt_kyc')!.kinds).toEqual(['report', 'critical']);
    expect(criticalIds(g, { include: [], exclude: [], critical: ['folder:marts'], criticalExclude: ['fct_loan'] }).size).toBe(1);
  });
  it('are named in the text answer', () => {
    const text = impactedReportsText(idx, 'stg_customer', both);
    expect(text).toMatch(/impacts 2 report\(s\) and 2 critical model\(s\)/);
    expect(text).toMatch(/Critical models \(2\):[\s\S]*Reports \(2\):/);
  });
});

describe('impacted reports', () => {
  it('lists reports with the shortest path and the pipelines that run them', () => {
    const r = impactedReports(idx, 'stg_customer', tag);
    if ('error' in r) throw new Error(r.error);
    expect(r.reports.map((x) => x.name)).toEqual(['rpt_kyc', 'rpt_loans']);
    expect(r.reports[0].path).toEqual(['stg_customer', 'dim_customer', 'rpt_kyc']);
    expect(r.reports[0].hops).toBe(2);
    expect(r.reports[0].pipelines).toEqual(['dag_daily (0 3 * * *)']); // with its schedule
  });
  it('exposures mode reaches the exposure through the model', () => {
    const r = impactedReports(idx, 'stg_customer', only('exposures'));
    if ('error' in r) throw new Error(r.error);
    expect(r.reports.map((x) => [x.name, x.hops])).toEqual([['dash', 3]]);
  });
  it('a report counts itself; a missing definition explains how to set it', () => {
    expect(impactedReportsText(idx, 'rpt_loans', tag)).toMatch(/impacts 1 report/);
    expect(impactedReportsText(idx, 'raw', only('tag:nope'))).toMatch(/Nothing matches the definition/);
    expect(impactedReportsText(idx, 'raw', only())).toMatch(/No report or critical-model definition is configured/);
  });
  it('unknown names get suggestions', () => {
    expect(resolveModel(g, 'stg_cust').ok).toBe(false);
    expect(runTool(idx, tag, 'impacted_reports', { model: 'stg_cust' })).toMatch(/Did you mean: stg_customer/);
  });
});

describe('runTool', () => {
  it('every declared tool runs and returns text; bad input never throws', () => {
    for (const t of TOOLS) expect(typeof runTool(idx, tag, t.name, {})).toBe('string');
    expect(runTool(idx, tag, 'nope')).toMatch(/Unknown tool/);
    expect(runTool(idx, tag, 'find_models', { query: 'customer' })).toMatch(/stg_customer/);
    expect(runTool(idx, tag, 'lineage', { model: 'stg_customer', up: 1, down: 1 })).toMatch(/dim_customer/);
    expect(runTool(idx, tag, 'pipelines_for', { model: 'rpt_kyc' })).toMatch(/runs: dag_daily/);
    expect(runTool(idx, tag, 'models_for_pipeline', { pipeline: 'dag_daily' })).toMatch(/rpt_kyc/);
    expect(runTool(idx, tag, 'resolve_selector', { select: 'tag:report' })).toMatch(/2 node/);
    expect(runTool(idx, tag, 'resolve_selector', { select: 'state:modified' })).toMatch(/Could not resolve/);
  });
});

describe('package.json', () => {
  it('declares exactly the tools the code serves, gated by the AI setting', () => {
    const pkg = JSON.parse(fs.readFileSync(__dirname + '/../package.json', 'utf8'));
    const declared = pkg.contributes.languageModelTools as { name: string; when: string; modelDescription: string; inputSchema: unknown }[];
    expect(declared.map((d) => d.name)).toEqual(TOOLS.map((t) => `dbtairflow_${t.name}`));
    declared.forEach((d, i) => { expect(d.when).toBe('config.dbtAirflow.ai.enabled'); expect(d.modelDescription).toBe(TOOLS[i].description); expect(d.inputSchema).toEqual(TOOLS[i].inputSchema); });
    expect(pkg.contributes.configuration.properties['dbtAirflow.ai.enabled'].default).toBe(false);
  });
});

describe('old report settings', () => {
  it('turns the early mode + value into one list entry', () => {
    expect(legacyReportEntry('folder', 'models/one_reporting_views')).toBe('folder:models/one_reporting_views');
    expect(legacyReportEntry('tag', ' report ')).toBe('tag:report');
    expect(legacyReportEntry('exposures', '')).toBe('exposures');
    expect(legacyReportEntry('tag', '')).toBeUndefined();
    expect(legacyReportEntry(undefined, 'x')).toBeUndefined();
  });
});
