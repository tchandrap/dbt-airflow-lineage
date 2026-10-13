import { describe, it, expect } from 'vitest';
import { parseAirflowFile, parseShellDbt } from '../src/airflow';

describe('parseAirflowFile', () => {
  it('reads DbtTransformationConfig kwargs, ignoring None and defs', () => {
    const src = `
def helper(dbt_selector=None, dbt_exclude=None): pass
def get():
    return [
        DbtTransformationConfig(
            name="dbt_gtm",
            schedule="57 9 * * *",
            dbt_selector="tag:gtm_1000WIB",
            dbt_exclude="tag:slow tag:flaky",
            dbt_indirect_selection=DbtIndirectSelection.CAUTIOUS,
        ),
        DbtTransformationConfig(name="noop", dbt_selector=None),
    ]`;
    const [p, ...rest] = parseAirflowFile('/x/core.py', src);
    expect(rest).toHaveLength(0);
    expect(p.name).toBe('dbt_gtm');
    expect(p.schedule).toBe('57 9 * * *');
    expect(p.sites[0]).toMatchObject({ select: 'tag:gtm_1000WIB', exclude: 'tag:slow tag:flaky' });
  });
  it('handles " ".join, string + list concat, constants', () => {
    const src = `
BASE = ["tag:a", "tag:b"]
X = Cfg(name="n", dbt_selector=" ".join(BASE + ["m1+"]), dbt_exclude=",".join(["tag:x", "tag:y"]))`;
    const [p] = parseAirflowFile('/x/a.py', src);
    expect(p.sites[0].select).toBe('tag:a tag:b m1+');
    expect(p.sites[0].exclude).toBe('tag:x,tag:y');
  });
  it('dag_definitions dicts: job selector inherits dag-level excludes + schedule', () => {
    const src = `
dag_definitions = [
  {"dag_name_suffix": "hourly", "schedule": "0 * * * *", "excludes": ["tag:skip"],
   "dbt_jobs": [{"selector": "tag:hourly"}, {"name": "j2", "selector": "1+m2"}]},
]`;
    const [p] = parseAirflowFile('/x/b.py', src);
    expect(p.name).toBe('hourly');
    expect(p.schedule).toBe('0 * * * *');
    expect(p.sites.map((s) => [s.select, s.exclude])).toEqual([['tag:hourly', 'tag:skip'], ['1+m2', 'tag:skip']]);
  });
  it('flags unresolvable selectors as dynamic', () => {
    const [p] = parseAirflowFile('/x/c.py', `X = Cfg(name="n", dbt_selector=f"tag:{team}")`);
    expect(p.sites[0]).toMatchObject({ select: null, dynamic: true });
  });
  it('picks up dbt CLI strings', () => {
    const [p] = parseAirflowFile('/x/d.py', `t = BashOperator(task_id="x", bash_command="dbt build --select tag:a +m1 --exclude m2 --target prod")`);
    expect(p.sites[0]).toMatchObject({ select: 'tag:a +m1', exclude: 'm2' });
  });
});

describe('parseShellDbt', () => {
  it('--selector and -s', () => {
    expect(parseShellDbt('dbt run --selector nightly')?.named).toBe('nightly');
    expect(parseShellDbt('dbt ls -s tag:a')?.select).toBe('tag:a');
    expect(parseShellDbt('echo hi')).toBeNull();
  });
});
