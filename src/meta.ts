import { parseDocument, isAlias, isMap, isSeq, isScalar, YAMLMap, YAMLSeq, Pair } from 'yaml';

/**
 * Reads and surgically edits dbt properties YAML (description / tests) while leaving every untouched byte as-is.
 * We never re-serialise the document: edits are computed from node source ranges and spliced into the original text.
 */

export interface Target { section: 'models' | 'seeds' | 'snapshots' | 'sources'; name: string; sourceName?: string }
export interface TestView { index: number; label: string; args: string }
export interface ColumnView { name: string; description: string; tests: TestView[] }
export interface PropView { path: string[]; type: 'scalar' | 'list' | 'complex'; value: string; items: string[] }
export interface MetaView { found: boolean; line: number; description: string; columns: ColumnView[]; tests: TestView[]; props: PropView[] }
export interface TestSpec { name: string; args?: Record<string, unknown> }
export interface Edits {
  description?: string;
  columns?: Record<string, string>; // column name → new description
  removeTests?: { column?: string; index: number; label: string }[];
  addTests?: { column?: string; test: TestSpec }[];
  /** Other properties (config.*, meta.*, tags, group, access, …) addressed by key path. */
  setProps?: { path: string[]; value: string }[];
  removeProps?: { path: string[] }[];
  addListItems?: { path: string[]; value: string }[];
  removeListItems?: { path: string[]; index: number; label: string }[];
  addColumns?: { name: string; description?: string }[];
}

export class MetaError extends Error {}

const TEST_KEYS = ['tests', 'data_tests'];

const lineStart = (t: string, p: number) => t.lastIndexOf('\n', p - 1) + 1;
const lineEnd = (t: string, p: number) => { const i = t.indexOf('\n', p); return i < 0 ? t.length : i; };
const colOf = (t: string, p: number) => p - lineStart(t, p);
const sp = (n: number) => ' '.repeat(Math.max(0, n));
const keyName = (p: Pair) => (isScalar(p.key) ? String(p.key.value) : '');
const getPair = (m: YAMLMap, k: string) => m.items.find((p) => keyName(p as Pair) === k) as Pair | undefined;
/** Document being read/edited; needed to follow `<<: *anchor` merge keys. */
let CUR_DOC: any = null;
/** Like getPair, but also finds keys inherited through YAML merge keys (`<<: *shared`). Direct keys win. */
function lookupPair(m: YAMLMap, k: string, depth = 0): Pair | undefined {
  const direct = getPair(m, k);
  if (direct || depth > 5) return direct;
  for (const it of m.items) {
    const p = it as Pair;
    if (!isScalar(p.key) || p.key.value !== '<<') continue;
    const v: any = p.value;
    for (const t of isAlias(v) ? [v] : isSeq(v) ? v.items : []) {
      let r: any = t;
      try { r = isAlias(t) ? (t as any).resolve(CUR_DOC) : t; } catch { r = null; }
      if (isMap(r)) { const f = lookupPair(r, k, depth + 1); if (f) return f; }
    }
  }
  return undefined;
}
const scalarStr = (m: YAMLMap, k: string) => { const v = lookupPair(m, k)?.value; return isScalar(v) && v.value != null ? String(v.value) : ''; };
const rng = (n: any): [number, number] => [n.range[0], n.range[1]];

function findEntry(doc: any, t: Target): YAMLMap | null {
  const root = doc.contents;
  if (!isMap(root)) return null;
  const sec = getPair(root, t.section)?.value;
  if (!isSeq(sec)) return null;
  const byName = (s: YAMLSeq, n: string) => s.items.find((i) => isMap(i) && scalarStr(i, 'name') === n) as YAMLMap | undefined;
  if (t.section === 'sources') {
    const src = byName(sec, t.sourceName ?? '');
    const tables = src && getPair(src, 'tables')?.value;
    return (isSeq(tables) && byName(tables, t.name)) || null;
  }
  return byName(sec, t.name) ?? null;
}

const testKeyOf = (m: YAMLMap) => TEST_KEYS.find((k) => lookupPair(m, k)) ?? null;

function viewTests(m: YAMLMap, doc: any): TestView[] {
  const k = testKeyOf(m);
  const seq = k && lookupPair(m, k)?.value;
  if (!isSeq(seq)) return [];
  return seq.items.map((it, index): TestView => {
    if (isAlias(it)) return { index, label: `*${(it as any).source}`, args: '(shared definition)' };
    if (isScalar(it)) return { index, label: String(it.value), args: '' };
    if (isMap(it) && it.items.length) {
      const p = it.items[0] as Pair;
      const label = isScalar(p.key) ? String(p.key.value) : '?';
      let args = '';
      try {
        if (isAlias(p.value)) args = '(shared definition)';
        else if (p.value && (p.value as any).toJS) {
          const v: any = (p.value as any).toJS(doc, { maxAliasCount: -1 });
          const a = v && typeof v === 'object' && !Array.isArray(v) ? (v.arguments ?? v) : v;
          args = a == null ? '' : JSON.stringify(a);
        }
      } catch { args = '(complex)'; }
      return { index, label, args };
    }
    return { index, label: '(unreadable test)', args: '' };
  });
}

const PROP_SKIP = new Set(['name', 'description', 'columns', 'tests', 'data_tests', 'tables']);
function flatten(v: unknown, path: string[], out: PropView[]) {
  if (Array.isArray(v)) {
    out.push(v.every((x) => x === null || typeof x !== 'object')
      ? { path, type: 'list', value: '', items: v.map((x) => String(x)) }
      : { path, type: 'complex', value: JSON.stringify(v), items: [] });
  } else if (v && typeof v === 'object') {
    const ks = Object.keys(v as object);
    if (!ks.length) out.push({ path, type: 'complex', value: '{}', items: [] });
    for (const k of ks) flatten((v as any)[k], [...path, k], out);
  } else out.push({ path, type: 'scalar', value: v == null ? '' : String(v), items: [] });
}
/** Every property of the entry except name/description/columns/tests, flattened to dotted key paths. */
function readProps(m: YAMLMap, doc: any): PropView[] {
  const out: PropView[] = [];
  let js: any;
  try { js = (m as any).toJS(doc, { maxAliasCount: -1 }); } catch { return out; }
  for (const k of Object.keys(js ?? {})) if (!PROP_SKIP.has(k)) flatten(js[k], [k], out);
  return out;
}

export function readMeta(text: string, t: Target): MetaView {
  const doc = parseDocument(text);
  CUR_DOC = doc;
  const m = findEntry(doc, t);
  if (!m) return { found: false, line: 0, description: '', columns: [], tests: [], props: [] };
  const cols = lookupPair(m, 'columns')?.value;
  return {
    found: true,
    line: text.slice(0, (m as any).range[0]).split('\n').length,
    description: scalarStr(m, 'description'),
    columns: isSeq(cols) ? cols.items.filter(isMap).map((c) => ({ name: scalarStr(c as YAMLMap, 'name'), description: scalarStr(c as YAMLMap, 'description'), tests: viewTests(c as YAMLMap, doc) })) : [],
    tests: viewTests(m, doc),
    props: readProps(m, doc),
  };
}

// ---------- emitters (match the repo's style: single-quoted flow lists, `arguments:` nesting) ----------

const RESERVED = /^(true|false|null|yes|no|on|off|~)$/i;
function scalarText(v: unknown, inFlow = false): string {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v === null || v === undefined) return 'null';
  const s = String(v);
  const plain = !inFlow && s !== '' && !RESERVED.test(s) && !/^[\d.+-]/.test(s) && !/^[\s'"\[\]{}#&*!|>%@`,?:-]/.test(s) && !/[:#]\s|\s#|[\[\]{},]|\s$/.test(s);
  return plain ? s : `'${s.replace(/'/g, "''")}'`;
}
function emitMap(o: Record<string, unknown>, col: number): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(o)) {
    if (Array.isArray(v)) out.push(`${sp(col)}${k}: [${v.map((x) => scalarText(x, true)).join(', ')}]`);
    else if (v && typeof v === 'object') { out.push(`${sp(col)}${k}:`); out.push(...emitMap(v as Record<string, unknown>, col + 2)); }
    else out.push(`${sp(col)}${k}: ${scalarText(v)}`);
  }
  return out;
}
export function emitTest(t: TestSpec, dashCol: number): string {
  const args = t.args && Object.keys(t.args).length ? t.args : null;
  if (!args) return `${sp(dashCol)}- ${t.name}`;
  return [`${sp(dashCol)}- ${t.name}:`, `${sp(dashCol + 4)}arguments:`, ...emitMap(args, dashCol + 6)].join('\n');
}
function scalarValue(text: string, keyCol: number): string {
  const s = text.replace(/\s+$/, '');
  if (!s.includes('\n')) return JSON.stringify(s);
  return '|-\n' + s.split('\n').map((l) => (l ? sp(keyCol + 2) + l : '')).join('\n');
}

// ---------- edit computation ----------

interface Splice { start: number; end: number; text: string; order: number; depth: number }

/** End of the last line occupied by a node (position of its terminating newline). */
function endOfLastLine(text: string, valueEnd: number): number {
  let p = valueEnd;
  while (p > 0 && (text[p - 1] === '\n' || text[p - 1] === ' ')) p--;
  return lineEnd(text, p);
}
function mapEnd(text: string, m: YAMLMap): number {
  let end = rng(m)[0];
  for (const it of m.items) {
    const p = it as Pair;
    const v: any = p.value;
    end = Math.max(end, v?.range ? v.range[1] : (p.key as any).range[1]);
  }
  return endOfLastLine(text, end);
}

type Owner = { pairs: Pair[]; maps: YAMLMap[] };
type ItemEmitter = (dashCol: number) => string;

/** Follows `path` through nested maps. `rest` = keys that do not exist yet; `parent` = deepest existing map. */
function walkPath(entry: YAMLMap, path: string[]) {
  const pairs: Pair[] = [], maps: YAMLMap[] = [];
  let cur: YAMLMap = entry;
  for (let i = 0; i < path.length; i++) {
    const p = getPair(cur, path[i]);
    if (!p) return { pairs, maps, rest: path.slice(i), parent: cur };
    pairs.push(p); maps.push(cur);
    if (i === path.length - 1) break;
    if (!isMap(p.value)) throw new MetaError(`"${path.slice(0, i + 1).join('.')}" is not a map`);
    cur = p.value;
  }
  return { pairs, maps, rest: [] as string[], parent: cur };
}

export function applyEdits(text: string, t: Target, edits: Edits): string {
  const doc = parseDocument(text);
  CUR_DOC = doc;
  const entry = findEntry(doc, t);
  if (!entry) throw new MetaError(`No YAML entry for ${t.name}`);
  const out: Splice[] = [];
  let order = 0;
  // `depth` (indent column) orders several insertions that land at the same position: deeper structures first
  const push = (start: number, end: number, s: string, depth = 0) => out.push({ start, end, text: s, order: order++, depth });

  const keyCol = (m: YAMLMap) => colOf(text, rng((m.items[0] as Pair).key)[0]);

  const setDescription = (m: YAMLMap, desc: string) => {
    const col = keyCol(m);
    const pair = getPair(m, 'description');
    const v: any = pair?.value;
    if (pair && v?.range) {
      let end = v.range[1];
      while (end > v.range[0] && text[end - 1] === '\n') end--;
      push(v.range[0], end, scalarValue(desc, col));
    } else if (pair) { // `description:` with empty value
      push((pair.key as any).range[1] + 1, (pair.key as any).range[1] + 1, ' ' + scalarValue(desc, col));
    } else {
      const namePair = getPair(m, 'name') ?? (m.items[0] as Pair);
      const nv: any = namePair.value;
      const at = lineEnd(text, nv?.range ? nv.range[1] : (namePair.key as any).range[1]);
      push(at, at, `\n${sp(col)}description: ${scalarValue(desc, col)}`, col);
    }
  };

  /** Delete the lines of a `key: value` pair (value may span many lines). */
  const deletePair = (pair: Pair) => {
    const ks = rng(pair.key)[0];
    const first = lineStart(text, ks);
    if (!/^\s*$/.test(text.slice(first, ks))) throw new MetaError('Cannot remove a property written inline');
    const v: any = pair.value;
    push(first, Math.min(text.length, endOfLastLine(text, v?.range ? v.range[1] : rng(pair.key)[1]) + 1), '');
  };
  /** Delete the pair; if that empties its parent map, delete the parent instead (never leave `config:` dangling). */
  const deleteClimbing = (o: Owner) => {
    let i = o.pairs.length - 1;
    while (i > 0 && o.maps[i].items.length === 1) i--;
    deletePair(o.pairs[i]);
  };

  /** Shared by tests, tags, other lists and columns: remove items by index (verified by label) and append new items. */
  const changeList = (m: YAMLMap, keys: string[], defKey: string, removes: { index: number; label: string }[], adds: ItemEmitter[],
    labelAt: (i: number) => string | undefined, owner?: Owner) => {
    if (!removes.length && !adds.length) return;
    const col = keyCol(m);
    const key = keys.find((k) => getPair(m, k)) ?? null;
    const pair = key ? getPair(m, key) : undefined;
    const seq: any = pair?.value;
    const isBlockSeq = isSeq(seq) && !(seq as any).flow;
    const items: any[] = isSeq(seq) ? seq.items : [];
    if (!pair) {
      const inherited = keys.find((k) => lookupPair(m, k));
      if (inherited) throw new MetaError(`"${inherited}" is inherited through a YAML merge (<<) — edit the shared definition instead, or the inherited entries would be overridden`);
    }

    for (const r of removes) {
      if (!items[r.index] || labelAt(r.index) !== r.label) throw new MetaError(`"${r.label}" changed on disk — reload and retry`);
    }
    const removeIdx = new Set(removes.map((r) => r.index));
    const remaining = items.length - removeIdx.size;

    if (pair && isBlockSeq && remaining === 0 && !adds.length && items.length) {
      if (owner) deleteClimbing(owner); else deletePair(pair);
      return;
    }
    if (pair && isSeq(seq) && !isBlockSeq) {
      // flow list (`tests: []` / `[unique]`): rewrite as a block list
      const kept = items.filter((_, i) => !removeIdx.has(i)).map((i) => `${sp(col)}- ${text.slice(rng(i)[0], rng(i)[1])}`);
      const block = [...kept, ...adds.map((a) => a(col))];
      push(rng(pair.key)[1] + 1, rng(seq)[1], block.length ? '\n' + block.join('\n') : ' []', col);
      return;
    }
    for (const i of removeIdx) {
      const dash = text.lastIndexOf('-', rng(items[i])[0]);
      push(lineStart(text, dash), Math.min(text.length, endOfLastLine(text, rng(items[i])[1]) + 1), '');
    }
    if (!adds.length) return;
    if (pair && isBlockSeq && items.length) {
      const dashCol = colOf(text, text.lastIndexOf('-', rng(items[0])[0]));
      const at = endOfLastLine(text, rng(items[items.length - 1])[1]);
      push(at, at, '\n' + adds.map((a) => a(dashCol)).join('\n'), dashCol);
    } else if (pair) { // `key:` with null value
      const at = lineEnd(text, rng(pair.key)[1]);
      push(at, at, '\n' + adds.map((a) => a(col)).join('\n'), col);
    } else {
      const at = mapEnd(text, m);
      push(at, at, `\n${sp(col)}${defKey}:\n` + adds.map((a) => a(col)).join('\n'), col);
    }
  };

  /** Insert keys that do not exist yet (`rest`) at the end of map `parent`, with `leaf` producing the innermost lines. */
  const insertChain = (parent: YAMLMap, rest: string[], leaf: (col: number, key: string) => string[]) => {
    const col = keyCol(parent);
    const lines: string[] = [];
    rest.slice(0, -1).forEach((k, i) => lines.push(`${sp(col + 2 * i)}${k}:`));
    lines.push(...leaf(col + 2 * (rest.length - 1), rest[rest.length - 1]));
    const at = mapEnd(text, parent);
    push(at, at, '\n' + lines.join('\n'), col);
  };
  const propScalar = (v: string) => (/^(true|false)$/i.test(v) ? v.toLowerCase() : /^-?\d+(\.\d+)?$/.test(v) ? v : scalarText(v));

  // ---------- description
  if (edits.description !== undefined) setDescription(entry, edits.description);

  const cols = getPair(entry, 'columns')?.value;
  const colMap = (name: string): YAMLMap => {
    const c = isSeq(cols) ? cols.items.find((i) => isMap(i) && scalarStr(i, 'name') === name) : undefined;
    if (!isMap(c)) throw new MetaError(`Column "${name}" is not declared in the YAML`);
    return c;
  };
  for (const [name, d] of Object.entries(edits.columns ?? {})) setDescription(colMap(name), d);

  // ---------- tests (model and column level)
  const scopes = new Set<string | undefined>([...(edits.removeTests ?? []).map((r) => r.column), ...(edits.addTests ?? []).map((a) => a.column)]);
  for (const c of scopes) {
    const m = c ? colMap(c) : entry;
    changeList(m, TEST_KEYS, 'tests',
      (edits.removeTests ?? []).filter((r) => r.column === c),
      (edits.addTests ?? []).filter((a) => a.column === c).map((a) => (dc: number) => emitTest(a.test, dc)),
      (i) => viewTests(m, doc)[i]?.label);
  }

  // ---------- new columns (after tests so they land below edits made to the previous last column, and before entry-level
  // properties that are appended at the same position)
  if (edits.addColumns?.length) {
    const existing = new Set(isSeq(cols) ? cols.items.filter(isMap).map((c) => scalarStr(c as YAMLMap, 'name').toLowerCase()) : []);
    for (const c of edits.addColumns) {
      const n = c.name.trim();
      if (!n) throw new MetaError('Column name is required');
      if (existing.has(n.toLowerCase())) throw new MetaError(`Column "${n}" already exists`);
      existing.add(n.toLowerCase());
    }
    changeList(entry, ['columns'], 'columns', [], edits.addColumns.map((c) => (dc: number) =>
      `${sp(dc)}- name: ${scalarText(c.name.trim())}` + (c.description?.trim() ? `\n${sp(dc + 2)}description: ${scalarValue(c.description, dc + 2)}` : '')),
      () => undefined);
  }

  // ---------- generic properties: config.*, meta.*, tags, group, access, …
  for (const sp0 of edits.setProps ?? []) {
    const w = walkPath(entry, sp0.path);
    const val = propScalar(sp0.value);
    if (w.rest.length) { insertChain(w.parent, w.rest, (c, k) => [`${sp(c)}${k}: ${val}`]); continue; }
    const pair = w.pairs[w.pairs.length - 1];
    const v: any = pair.value;
    if (!isScalar(v)) throw new MetaError(`"${sp0.path.join('.')}" is not a single value`);
    if (v.range && v.range[1] > v.range[0]) {
      let end = v.range[1];
      while (end > v.range[0] && text[end - 1] === '\n') end--;
      push(v.range[0], end, val);
    } else push(rng(pair.key)[1] + 1, rng(pair.key)[1] + 1, ' ' + val);
  }
  for (const rp of edits.removeProps ?? []) {
    const w = walkPath(entry, rp.path);
    if (w.rest.length) throw new MetaError(`"${rp.path.join('.')}" does not exist`);
    deleteClimbing(w);
  }
  const listPaths = new Map<string, string[]>();
  [...(edits.addListItems ?? []), ...(edits.removeListItems ?? [])].forEach((x) => listPaths.set(x.path.join('\u0000'), x.path));
  for (const path of listPaths.values()) {
    const same = (x: { path: string[] }) => x.path.join('\u0000') === path.join('\u0000');
    const adds = (edits.addListItems ?? []).filter(same);
    const removes = (edits.removeListItems ?? []).filter(same);
    const w = walkPath(entry, path);
    if (w.rest.length) {
      if (removes.length) throw new MetaError(`"${path.join('.')}" does not exist`);
      insertChain(w.parent, w.rest, (c, k) => [`${sp(c)}${k}:`, ...adds.map((a) => `${sp(c)}- ${scalarText(a.value)}`)]);
      continue;
    }
    const pair = w.pairs[w.pairs.length - 1];
    if (!isSeq(pair.value)) throw new MetaError(`"${path.join('.')}" is not a list`);
    const seq: any = pair.value;
    changeList(w.maps[w.maps.length - 1], [path[path.length - 1]], path[path.length - 1],
      removes.map((r) => ({ index: r.index, label: r.label })),
      adds.map((a) => (dc: number) => `${sp(dc)}- ${scalarText(a.value)}`),
      (i) => (isScalar(seq.items[i]) ? String((seq.items[i] as any).value) : undefined),
      { pairs: w.pairs, maps: w.maps });
  }

  let res = text;
  // Applied back-to-front. For equal positions the text order must be: deeper first, then push order — so apply the reverse.
  for (const s of [...out].sort((a, b) => b.start - a.start || a.depth - b.depth || b.order - a.order)) res = res.slice(0, s.start) + s.text + res.slice(s.end);
  return res;
}
