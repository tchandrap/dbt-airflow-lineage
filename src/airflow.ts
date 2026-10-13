import type { IngestRef, Pipeline, SelectionSite } from './types';

// ---------- tiny Python tokenizer → bracket tree (enough to read literals, kwargs, dict keys) ----------

type Tok =
  | { t: 'str'; v: string; f: boolean; line: number }
  | { t: 'name' | 'op' | 'num'; v: string; line: number }
  | { t: 'group'; open: string; items: Tok[]; line: number };

const CLOSE: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

export function tokenize(src: string): Tok[] {
  let i = 0, line = 1;
  const stack: { open: string; items: Tok[]; line: number }[] = [{ open: '', items: [], line: 1 }];
  const push = (t: Tok) => stack[stack.length - 1].items.push(t);
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (/\s/.test(c) || c === '\\') { i++; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    const sm = /^([rRbBuUfF]{0,2})("""|'''|"|')/.exec(src.slice(i, i + 6));
    if (sm) {
      const prefix = sm[1].toLowerCase(), q = sm[2], raw = prefix.includes('r');
      let j = i + sm[0].length, v = '';
      const startLine = line;
      while (j < src.length && !src.startsWith(q, j)) {
        if (src[j] === '\\' && !raw) { const n = src[j + 1]; v += n === 'n' ? '\n' : n === 't' ? '\t' : n; j += 2; continue; }
        if (src[j] === '\n') line++;
        v += src[j++];
      }
      push({ t: 'str', v, f: prefix.includes('f'), line: startLine });
      i = j + q.length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) { const m = /^[A-Za-z_]\w*/.exec(src.slice(i, i + 200))!; push({ t: 'name', v: m[0], line }); i += m[0].length; continue; }
    if (/\d/.test(c)) { const m = /^[\d._eE]+/.exec(src.slice(i, i + 40))!; push({ t: 'num', v: m[0], line }); i += m[0].length; continue; }
    if (c in CLOSE) { stack.push({ open: c, items: [], line }); i++; continue; }
    if (c === ')' || c === ']' || c === '}') {
      if (stack.length > 1) { const g = stack.pop()!; push({ t: 'group', open: g.open, items: g.items, line: g.line }); }
      i++; continue;
    }
    push({ t: 'op', v: c, line }); i++;
  }
  while (stack.length > 1) { const g = stack.pop()!; stack[stack.length - 1].items.push({ t: 'group', open: g.open, items: g.items, line: g.line }); }
  return stack[0].items;
}

const splitTop = (items: Tok[], sep = ','): Tok[][] => {
  const out: Tok[][] = [[]];
  for (const t of items) { if (t.t === 'op' && t.v === sep) out.push([]); else out[out.length - 1].push(t); }
  return out.filter((p) => p.length);
};

// ---------- expression evaluation (strings / lists / join / + / constants) ----------

type Val = { kind: 'str'; v: string } | { kind: 'list'; v: Val[] } | { kind: 'none' } | { kind: 'dyn' };
type Env = Map<string, Tok[]>;

function evalExpr(toks: Tok[], env: Env, depth = 0): Val {
  if (!toks.length || depth > 8) return { kind: 'dyn' };
  const plus = splitTop(toks, '+');
  if (plus.length > 1) {
    const parts = plus.map((p) => evalExpr(p, env, depth + 1));
    if (parts.some((p) => p.kind === 'dyn')) return { kind: 'dyn' };
    if (parts.every((p) => p.kind === 'str')) return { kind: 'str', v: parts.map((p) => (p as any).v).join('') };
    if (parts.every((p) => p.kind === 'list')) return { kind: 'list', v: parts.flatMap((p) => (p as any).v) };
    return { kind: 'dyn' };
  }
  if (toks.every((t) => t.t === 'str')) {
    if (toks.some((t) => (t as any).f && /\{/.test((t as any).v))) return { kind: 'dyn' };
    return { kind: 'str', v: toks.map((t) => (t as any).v).join('') };
  }
  const first = toks[0];
  if (toks.length === 1) {
    if (first.t === 'name' && first.v === 'None') return { kind: 'none' };
    if (first.t === 'name' && env.has(first.v)) return evalExpr(env.get(first.v)!, env, depth + 1);
    if (first.t === 'group' && (first.open === '[' || first.open === '(')) {
      const elems = splitTop(first.items);
      if (first.open === '(' && elems.length === 1 && !first.items.some((t) => t.t === 'op' && t.v === ',')) return evalExpr(elems[0], env, depth + 1);
      const vals = elems.map((e) => evalExpr(e, env, depth + 1));
      return { kind: 'list', v: vals };
    }
  }
  // "sep".join(list)   → str . join ( group )
  const j = toks.findIndex((t, i) => t.t === 'op' && t.v === '.' && toks[i + 1]?.t === 'name' && (toks[i + 1] as any).v === 'join');
  if (j > 0 && toks[j + 2]?.t === 'group') {
    const sep = evalExpr(toks.slice(0, j), env, depth + 1);
    const lst = evalExpr([toks[j + 2]], env, depth + 1);
    if (sep.kind === 'str' && lst.kind === 'list') {
      const flat = flatten(lst);
      if (flat === null) return { kind: 'dyn' };
      return { kind: 'str', v: flat.join(sep.v) };
    }
  }
  return { kind: 'dyn' };
}

function flatten(v: Val): string[] | null {
  if (v.kind === 'str') return [v.v];
  if (v.kind === 'none') return [];
  if (v.kind === 'list') { const out: string[] = []; for (const x of v.v) { const f = flatten(x); if (!f) return null; out.push(...f); } return out; }
  return null;
}

// ---------- pipeline discovery ----------

const SELECT_KEYS = ['dbt_selector', 'dbt_select', 'selector', 'select', 'selectors', 'dbt_selectors'];
const EXCLUDE_KEYS = ['dbt_exclude', 'exclude', 'excludes', 'dbt_excludes'];
const NAME_KEYS = ['name', 'dag_name_suffix', 'dag_id', 'dag_name', 'pipeline_name'];
const SCHEDULE_KEYS = ['schedule', 'schedule_interval'];
const NAMED_SELECTOR_KEYS = ['dbt_selector_name', 'selector_name'];
const INDIRECT_KEYS = ['dbt_indirect_selection', 'indirect_selection'];

interface KV { key: string; value: Tok[]; line: number }

function groupKVs(g: Extract<Tok, { t: 'group' }>): KV[] {
  const out: KV[] = [];
  for (const el of splitTop(g.items)) {
    if (g.open === '(' && el[0]?.t === 'name' && el[1]?.t === 'op' && el[1].v === '=' ) out.push({ key: el[0].v, value: el.slice(2), line: el[0].line });
    else if (g.open === '{') {
      const colon = el.findIndex((t) => t.t === 'op' && t.v === ':');
      if (colon === 1 && el[0].t === 'str') out.push({ key: el[0].v, value: el.slice(2), line: el[0].line });
    }
  }
  return out;
}

function buildEnv(top: Tok[]): Env {
  const env: Env = new Map();
  for (let i = 0; i + 2 < top.length; i++) {
    const a = top[i], b = top[i + 1];
    if (a.t === 'name' && b.t === 'op' && b.v === '=' && (i === 0 || top[i - 1].t !== 'op' || (top[i - 1] as any).v !== '.')) {
      // value runs until the next statement; approximate with single token or str-concat/join chain
      const val: Tok[] = [];
      let j = i + 2;
      while (j < top.length && !(top[j].t === 'name' && top[j + 1]?.t === 'op' && (top[j + 1] as any).v === '=' && val.length)) {
        val.push(top[j]); j++;
        if (val.length >= 12) break;
      }
      // trim to leading chunk that evaluates (str/list/join)
      for (let n = val.length; n > 0; n--) {
        if (evalExpr(val.slice(0, n), new Map()).kind !== 'dyn') { env.set(a.v, val.slice(0, n)); break; }
      }
    }
  }
  return env;
}

const asStr = (v: Val): { s: string | null; dyn: boolean } => {
  if (v.kind === 'none') return { s: null, dyn: false };
  const f = flatten(v);
  if (f === null) return { s: null, dyn: true };
  return { s: f.join(' ').trim() || null, dyn: false };
};

function siteFrom(kvs: KV[], ctx: KV[], env: Env, rawLine: number): SelectionSite | null {
  const find = (keys: string[]) => kvs.find((k) => keys.includes(k.key)) ?? ctx.find((k) => keys.includes(k.key));
  const sel = kvs.find((k) => SELECT_KEYS.includes(k.key));
  const named = find(NAMED_SELECTOR_KEYS);
  if (!sel && !named) return null;
  const sv = sel ? asStr(evalExpr(sel.value, env)) : { s: null, dyn: false };
  const ex = find(EXCLUDE_KEYS);
  const xv = ex ? asStr(evalExpr(ex.value, env)) : { s: null, dyn: false };
  const nm = named ? asStr(evalExpr(named.value, env)).s : null;
  const ind = find(INDIRECT_KEYS);
  const nameKv = kvs.find((k) => NAME_KEYS.includes(k.key));
  if (sv.s === null && !sv.dyn && !nm) return null; // explicit None / unset
  return {
    select: sv.s, exclude: xv.s, namedSelector: nm ?? undefined, dynamic: sv.dyn || xv.dyn,
    jobName: nameKv ? asStr(evalExpr(nameKv.value, env)).s ?? undefined : undefined,
    indirect: ind ? ind.value.map((t: any) => t.v ?? '').join('') : undefined,
    line: sel?.line ?? rawLine, raw: sel ? sel.value.map((t: any) => t.v ?? '…').join(' ').slice(0, 160) : '',
  };
}

/** Pull `dbt run --select a b --exclude c` / `--selector x` out of shell strings. */
export function parseShellDbt(cmd: string): { select: string | null; exclude: string | null; named?: string } | null {
  if (!/\bdbt\s+(run|build|test|seed|snapshot|ls|list)\b/.test(cmd)) return null;
  const toks = cmd.split(/\s+/).filter(Boolean);
  const grab = (flags: string[]) => {
    const vals: string[] = [];
    for (let i = 0; i < toks.length; i++) {
      const eq = flags.find((f) => toks[i].startsWith(f + '='));
      if (eq) { vals.push(toks[i].slice(eq.length + 1)); continue; }
      if (!flags.includes(toks[i])) continue;
      while (toks[i + 1] && !toks[i + 1].startsWith('-')) vals.push(toks[++i]);
    }
    return vals.length ? vals.join(' ') : null;
  };
  const named = grab(['--selector'])?.split(/\s+/)[0];
  return { select: grab(['--select', '--models', '--model', '-s', '-m']), exclude: grab(['--exclude']), named };
}

// ---------- ingestion targets: which BigQuery tables a DAG loads data into ----------

// Only keys that say "this is where the data is written". Generic `dataset` / `table` pairs are NOT enough: they are used by
// partition checks, validators and readers too (e.g. {"name": "partition_check__x", "dataset": "d", "table": "t"}).
const TABLE_KEYS_STRONG = ['bq_table', 'bq_table_name', 'bq_table_id', 'destination_table', 'target_table', 'target_table_name'];
const DATASET_KEYS = ['bq_dataset', 'bq_dataset_id', 'destination_dataset', 'target_dataset'];
const FULL_REF_KEY = /^(full_table_schema_reference|target_table_fullname|destination_table_fullname|destination_project_dataset_table)$/i;
// `project.dataset.table` (project may be an f-string placeholder) with literal dataset and table
const FULL_REF = /^`?(?:\{[^}]+\}|[\w-]+)\.([A-Za-z_][\w]*)\.([A-Za-z_][\w]*)`?$/;

/** Find the DAG definition (`DAG(...)`, `@dag(...)`) kwargs, used for the name/schedule of ingestion pipelines. */
function findDagKVs(items: Tok[]): KV[] | null {
  for (let i = 0; i < items.length; i++) {
    const t = items[i];
    if (t.t === 'name' && (t.v === 'DAG' || t.v === 'dag') && items[i + 1]?.t === 'group' && (items[i + 1] as any).open === '(' && (items[i - 1] as any)?.v !== 'def') {
      const kvs = groupKVs(items[i + 1] as Extract<Tok, { t: 'group' }>);
      if (kvs.length) return kvs;
    }
    if (t.t === 'group') { const r = findDagKVs(t.items); if (r) return r; }
  }
  return null;
}

function ingestFrom(kvs: KV[], ancestors: KV[], env: Env): IngestRef[] {
  const out: IngestRef[] = [];
  const strOf = (kv: KV | undefined) => { if (!kv) return null; const v = evalExpr(kv.value, env); return v.kind === 'str' && v.v.trim() ? v.v.trim() : null; };
  const dsKv = kvs.find((k) => DATASET_KEYS.includes(k.key)) ?? ancestors.find((k) => DATASET_KEYS.includes(k.key));
  const dataset = strOf(dsKv) ?? undefined;
  for (const kv of kvs) {
    if (TABLE_KEYS_STRONG.includes(kv.key)) {
      const table = strOf(kv);
      if (table && /^[A-Za-z_][\w]*$/.test(table)) out.push({ dataset, table, line: kv.line, via: kv.key });
    }
    if (FULL_REF_KEY.test(kv.key) && kv.value.length === 1 && kv.value[0].t === 'str') {
      const m = FULL_REF.exec((kv.value[0] as any).v.trim());
      if (m) out.push({ dataset: m[1], table: m[2], line: kv.line, via: kv.key });
    }
  }
  return out;
}

export function parseAirflowFile(file: string, src: string): Pipeline[] {
  const top = tokenize(src);
  const env = buildEnv(top);
  const pipelines = new Map<string, Pipeline>();
  const fileBase = file.split('/').pop()!.replace(/\.py$/, '');

  const getPipeline = (chain: KV[][], line: number): Pipeline => {
    const flat = chain.flat();
    const nameKv = flat.find((k) => NAME_KEYS.includes(k.key));
    const name = (nameKv && asStr(evalExpr(nameKv.value, env)).s) || fileBase;
    const sch = flat.find((k) => SCHEDULE_KEYS.includes(k.key));
    const id = `${file}::${name}`;
    let p = pipelines.get(id);
    if (!p) {
      p = { id, name, file, line: nameKv?.line ?? line, sites: [] };
      pipelines.set(id, p);
    }
    if (sch && !p.schedule) { const s = asStr(evalExpr(sch.value, env)); p.schedule = s.s ?? sch.value.map((t: any) => t.v ?? '…').join('').slice(0, 60); }
    return p;
  };

  const dagKVs = findDagKVs(top);
  const addIngest = (refs: IngestRef[], line: number) => {
    if (!refs.length) return;
    const p = getPipeline(dagKVs ? [dagKVs] : [], line); // ingestion dicts rarely sit inside the DAG call itself → attach to the file's DAG
    p.ingests ??= [];
    for (const r of refs) if (!p.ingests.some((x) => x.table === r.table && x.dataset === r.dataset)) p.ingests.push(r);
  };

  const visit = (items: Tok[], chain: KV[][], inDef: boolean) => {
    for (let i = 0; i < items.length; i++) {
      const t = items[i];
      if (t.t === 'str' && /\bdbt\s/.test(t.v)) {
        const sh = parseShellDbt(t.v);
        if (sh && (sh.select || sh.named || sh.exclude !== null)) {
          getPipeline(chain, t.line).sites.push({ select: sh.select, exclude: sh.exclude, namedSelector: sh.named, dynamic: /\{\{|\{\w/.test(t.v), line: t.line, raw: t.v.slice(0, 160) });
        }
      }
      if (t.t !== 'group') continue;
      const defCall = items[i - 2]?.t === 'name' && (items[i - 2] as any).v === 'def';
      const kvs = defCall ? [] : groupKVs(t);
      const next = kvs.length ? [...chain, kvs] : chain;
      if (kvs.length && t.open !== '[') {
        addIngest(ingestFrom(kvs, chain.flat(), env), t.line);
        const site = siteFrom(kvs, chain.flat(), env, t.line);
        if (site) getPipeline(next, t.line).sites.push(site);
      }
      // list-of-selectors in a dict value (e.g. "selector": [..]) is handled by evalExpr; still recurse for nested jobs
      visit(t.items, next, defCall || inDef);
    }
  };
  visit(top, [], false);
  return [...pipelines.values()].filter((p) => p.sites.length || p.ingests?.length);
}
