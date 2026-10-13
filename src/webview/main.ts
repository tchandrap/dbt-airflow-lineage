import dagre from '@dagrejs/dagre';
import airflowSvg from '../../assets/apache-airflow.svg';

declare function acquireVsCodeApi(): { postMessage(m: any): void };
const vscode = acquireVsCodeApi();

// ---------------------------------------------------------------- types
interface Trigger { pid: string; sites: { select: string; exclude?: string; line: number }[] }
interface IngestRef { dataset?: string; table: string; line: number; match: 'exact' | 'case-insensitive' | 'table-only' }
interface VNode { id: string; name: string; type: string; kind: string; tags: string[]; path: string; sourceName?: string; triggers: Trigger[]; ingest: { pid: string; refs: IngestRef[] }[] }
interface Pipe { id: string; name: string; file?: string; schedule?: string; selected: string[] }
interface Filter { select: string; exclude: string; tags: string[]; tagMode: 'any' | 'all'; kinds: string[]; scope: 'lineage' | 'project'; hide: boolean; context: boolean }
interface Payload {
  focus: string; nodes: VNode[]; edges: [string, string][]; pipelines: Pipe[]; depthUp: number; depthDown: number; depthFromSelector: boolean; seeds?: string[]; filter: Filter;
  filterError?: string; truncated: number; matched: string[] | null; matchedTotal: number | null; allTags: string[];
}
interface TestView { index: number; label: string; args: string }
interface PropView { path: string[]; type: 'scalar' | 'list' | 'complex'; value: string; items: string[] }
interface MetaMsg {
  id: string; error?: string; file?: string; saved?: string; saveError?: string;
  view?: { found: boolean; description: string; tests: TestView[]; props: PropView[]; columns: { name: string; description: string; tests: TestView[] }[] };
}
interface NewTest { column?: string; test: { name: string; args?: Record<string, unknown> } }

// ---------------------------------------------------------------- palette / legend
const KIND: Record<string, { label: string; color: string; dashed?: boolean }> = {
  source: { label: 'Source', color: '#2fbf9a' },
  seed: { label: 'Seed', color: '#b58cf0' },
  snapshot: { label: 'Snapshot', color: '#d9a21b' },
  exposure: { label: 'Exposure', color: '#ef6fa5' },
  table: { label: 'Model · table', color: '#4d8dff' },
  view: { label: 'Model · view', color: '#22b8cf' },
  incremental: { label: 'Model · incremental', color: '#8b7cf6' },
  ephemeral: { label: 'Model · ephemeral', color: '#8a94a6', dashed: true },
  materialized_view: { label: 'Model · materialized view', color: '#f0883e' },
  model: { label: 'Model · other', color: '#6b7a99' },
};
const KIND_ORDER = ['source', 'seed', 'snapshot', 'table', 'view', 'incremental', 'ephemeral', 'materialized_view', 'model', 'exposure'];
const colorOf = (k: string) => (KIND[k] ?? KIND.model).color;
/** Blend a #rrggbb color towards white (t = 0..1). */
function lighten(hex: string, t: number): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (c: number) => Math.round(c + (255 - c) * t).toString(16).padStart(2, '0');
  return `#${f(n >> 16)}${f((n >> 8) & 255)}${f(n & 255)}`;
}
/** Short code under the icon, and the tag shown under the name (materialization for models, schema for sources). */
const CODE: Record<string, string> = { source: 'SRC', seed: 'SED', snapshot: 'SNP', exposure: 'EXP' };
const codeOf = (k: string) => CODE[k] ?? 'MDL';
const MAT_LABEL: Record<string, string> = { table: 'Table', view: 'View', incremental: 'Incremental', ephemeral: 'Ephemeral', materialized_view: 'Materialized view', model: 'Model' };
const chipOf = (n: { kind: string; sourceName?: string }) => (n.kind === 'source' ? n.sourceName ?? '' : MAT_LABEL[n.kind] ?? '');
const NODE_H = 54, CAP_W = 40;

const NS = 'http://www.w3.org/2000/svg';
const AIRFLOW_INNER = airflowSvg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, ''); // logo viewBox 0 0 128 128

// ---------------------------------------------------------------- state
let data: Payload | null = null;
let activePipeline: string | null = null;
let selected: string | null = null;
let airflowFor: string | null = null;
let airflowFocus: 'run' | 'ingest' = 'run'; // which section of the Airflow dialog to show first
let left: 'model' | null = null;
let filterOpen = false;
let modelFor: string | null = null;
let meta: MetaMsg | null = null;
let showLegend = true;
let findQ = '';
let findIds: string[] = [];
let findIdx = -1;
let lastFilterKey: string | undefined;
let tx = 20, ty = 20, scale = 1;
const pos = new Map<string, { x: number; y: number; w: number; h: number }>();
const nodeEls = new Map<string, SVGGElement>();
let edgeEls: { a: string; b: string; el: SVGPathElement }[] = [];
let lastBox = { w: 0, h: 0 };

let flash: { kind: 'ok' | 'err'; text: string } | null = null;

const svg = document.getElementById('graph') as unknown as SVGSVGElement;
const dlg = document.getElementById('dlg')!;
const ldlg = document.getElementById('ldlg')!;
const fdlg = document.getElementById('fdlg')!;
const legend = document.getElementById('legend')!;
const selBar = document.getElementById('sel')!;

// The top bar wraps onto several lines in narrow panels: keep the graph area and dialogs below its real height
const barEl = document.getElementById('bar')!;
new ResizeObserver(() => document.documentElement.style.setProperty('--bar-h', `${barEl.offsetHeight}px`)).observe(barEl);

// ---------------------------------------------------------------- helpers
const el = (n: string, a: Record<string, string | number> = {}, txt?: string) => {
  const e = document.createElementNS(NS, n);
  for (const [k, v] of Object.entries(a)) e.setAttribute(k, String(v));
  if (txt !== undefined) e.textContent = txt;
  return e as SVGElement;
};
const h = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, any> = {}, ...kids: (string | Node)[]) => {
  const e = document.createElement(tag);
  Object.assign(e, props);
  kids.forEach((k) => e.append(k));
  return e;
};
const short = (s: string, n = 140) => (s.length > n ? s.slice(0, n) + '…' : s);
const fileOf = (f?: string) => (f ? f.split('/').slice(-2).join('/') : '');

const post = (m: any) => vscode.postMessage(m);


// ---------------------------------------------------------------- icons (16px line icons) + hover tooltips
const ICONS: Record<string, string> = {
  cube: '<path d="M8 1.5l5.5 3v7L8 14.5l-5.5-3v-7z"/><path d="M2.5 4.5L8 8l5.5-3.5M8 8v6.5"/>',
  // table = solid cube · view = dotted cube · incremental = top piece popped out · ephemeral = dashed cube
  cube_dots: '<path stroke-width="1.9" stroke-dasharray="0.01 2.15" d="M8 1.5l5.5 3v7L8 14.5l-5.5-3v-7z"/><path stroke-width="1.9" stroke-dasharray="0.01 2.15" d="M2.5 4.5L8 8l5.5-3.5M8 8v6.5"/>',
  cube_inc: '<path d="M2.5 6.5v5L8 14.5l5.5-3v-5M8 9.5v5M2.5 6.5L8 9.5l5.5-3"/><path d="M8 1l5.5 3L8 7 2.5 4z"/>',
  cube_dash: '<path stroke-dasharray="2.2 1.7" d="M8 1.5l5.5 3v7L8 14.5l-5.5-3v-7z"/><path stroke-dasharray="2.2 1.7" d="M2.5 4.5L8 8l5.5-3.5M8 8v6.5"/>',
  ingest: '<ellipse cx="8" cy="3.6" rx="4.8" ry="1.9"/><path d="M3.2 3.6v3c0 1 2.1 1.9 4.8 1.9s4.8-.9 4.8-1.9v-3M8 15v-5.2M5.8 12.6L8 14.8l2.2-2.2"/>',
  db: '<ellipse cx="8" cy="4" rx="5" ry="2"/><path d="M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4M3 8c0 1.1 2.2 2 5 2s5-.9 5-2"/>',
  seed: '<path d="M8 14V8.5M8 8.5C8 5.5 6 4 3 4c0 3 2 4.5 5 4.5zM8 10.5c0-2.5 1.7-4 5-4 0 2.7-1.8 4-5 4z"/>',
  camera: '<path d="M2 5h2.5L6 3h4l1.5 2H14v8H2z"/><circle cx="8" cy="9" r="2"/>',
  trend: '<path d="M2 12l4-4 3 3 5-6M10 5h4v4"/>',
  filter: '<path d="M2 3h12l-4.5 5.5V13l-3 1.5V8.5z"/>',
  refresh: '<path d="M13 8a5 5 0 11-1.6-3.7M13 2.5v3h-3"/>',
  edit: '<path d="M11 2.5l2.5 2.5L5.5 13H3v-2.5z"/>',
  check: '<path d="M3 8.5l3.2 3L13 4.5"/>',
  x: '<path d="M4 4l8 8M12 4l-8 8"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  minus: '<path d="M3 8h10"/>',
  search: '<circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2L14 14"/>',
  info: '<circle cx="8" cy="8" r="6"/><path d="M8 7.2V11M8 5v.1"/>',
  chevron: '<path d="M6 3.5L10.5 8 6 12.5"/>',
  tag: '<path d="M2 8.2V2.5h5.7l6.3 6.3-5.2 5.2z"/><circle cx="5.3" cy="5.3" r=".6"/>',
  gear: '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v1.7M8 12.5v1.7M1.8 8h1.7M12.5 8h1.7M3.6 3.6l1.2 1.2M11.2 11.2l1.2 1.2M12.4 3.6l-1.2 1.2M4.8 11.2l-1.2 1.2"/>',
  expand: '<path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5L9 7M2.5 13.5L7 9"/>',
  file: '<path d="M4 1.5h5l3.5 3.5v9.5H4z"/><path d="M9 1.5V5h3.5"/>',
  yaml: '<path d="M3 3h10M3 6.5h6M3 10h10M3 13.5h6"/>',
};
const SVG_ATTR = 'fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"';
function ico(name: string, size = 14): HTMLElement {
  const w = document.createElement('span');
  w.className = 'ic';
  w.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 16 16" ${SVG_ATTR}>${ICONS[name] ?? ''}</svg>`;
  return w;
}
const KIND_ICON: Record<string, string> = { source: 'db', seed: 'seed', snapshot: 'camera', exposure: 'trend', view: 'cube_dots', incremental: 'cube_inc', ephemeral: 'cube_dash' };
const iconOfKind = (k: string) => KIND_ICON[k] ?? 'cube';
const swatch = (kind: string) => h('span', { className: 'swi', style: `color:${colorOf(kind)}` }, ico(iconOfKind(kind), 14));
/** Icon drawn inside the graph SVG (white, on the node's colored cap). */
function svgIcon(name: string, size: number, x: number, y: number): SVGElement {
  const g = el('g', { transform: `translate(${x},${y}) scale(${size / 16})`, fill: 'none', stroke: '#fff', 'stroke-width': 1.4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
  g.innerHTML = ICONS[name] ?? '';
  return g;
}

/** One floating tooltip for everything with a data-tip attribute (so they are never clipped by scrolling dialogs). */
const tipEl = document.createElement('div');
tipEl.className = 'tip';
document.body.append(tipEl);
document.addEventListener('mouseover', (e) => {
  const t = (e.target as Element).closest?.('[data-tip]');
  if (!t) { tipEl.style.display = 'none'; return; }
  tipEl.textContent = t.getAttribute('data-tip');
  tipEl.style.display = 'block';
  const r = t.getBoundingClientRect(), w = tipEl.offsetWidth, hh = tipEl.offsetHeight;
  let x = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
  let y = r.bottom + 6;
  if (y + hh > window.innerHeight - 8) y = Math.max(8, r.top - hh - 6);
  tipEl.style.left = `${x}px`; tipEl.style.top = `${y}px`;
});
const withTip = <T extends HTMLElement>(e: T, tip: string): T => { e.setAttribute('data-tip', tip); return e; };
const iconBtn = (name: string, tip: string, onclick: () => void, cls = ''): HTMLButtonElement => {
  const b = h('button', { className: `ibtn ${cls}`.trim(), onclick }, ico(name));
  b.setAttribute('data-tip', tip);
  return b;
};
const infoTip = (tip: string) => withTip(h('span', { className: 'info' }, ico('info', 13)), tip);

function airflowLogo(size: number, x = 0, y = 0): SVGElement {
  const g = el('g', { transform: `translate(${x},${y}) scale(${size / 128})` });
  g.innerHTML = AIRFLOW_INNER;
  return g;
}
function airflowLogoHtml(size: number): HTMLElement {
  const w = h('span', { style: 'display:inline-flex' });
  w.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 128 128">${AIRFLOW_INNER}</svg>`;
  return w;
}

const edgePath = (a: string, b: string) => {
  const p = pos.get(a)!, q = pos.get(b)!;
  const x1 = p.x + p.w / 2, y1 = p.y, x2 = q.x - q.w / 2, y2 = q.y, dx = Math.max(30, (x2 - x1) / 2);
  return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
};
const applyView = () => document.getElementById('root')?.setAttribute('transform', `translate(${tx},${ty}) scale(${scale})`);

function fit() {
  const r = svg.getBoundingClientRect();
  if (!lastBox.w || !r.width) return;
  // leave room for open dialogs (left: details/filter, right: Airflow) so the fitted graph is never hidden behind them
  const padL = left ? 410 : 20, padR = airflowFor ? 380 : 20;
  const availW = Math.max(200, r.width - padL - padR), availH = r.height - 70;
  scale = Math.min(availW / lastBox.w, availH / lastBox.h, 1);
  tx = padL + Math.max(0, (availW - lastBox.w * scale) / 2); ty = 20;
}

/** Pan (keeping the current zoom) so the node sits in the middle of the free area between the open dialogs. */
function centerOn(id: string, minScale = 0) {
  const p = pos.get(id);
  const r = svg.getBoundingClientRect();
  if (!p || !r.width) return;
  const padL = left ? 410 : 0, padR = airflowFor ? 380 : 0;
  if (scale < minScale) scale = minScale; // zoom in when the graph was fitted so small the node is unreadable
  tx = padL + (r.width - padL - padR) / 2 - p.x * scale;
  ty = r.height / 2 - p.y * scale;
  const root = document.getElementById('root');
  if (root) { root.style.transition = 'transform .35s ease'; setTimeout(() => { root.style.transition = ''; }, 400); }
  applyView();
}

function zoomBy(f: number) {
  const r = svg.getBoundingClientRect();
  const mx = r.width / 2, my = r.height / 2;
  tx = mx - (mx - tx) * f; ty = my - (my - ty) * f; scale *= f;
  applyView();
}

function layout() {
  if (!data) return;
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 14, ranksep: 80 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of data.nodes) g.setNode(n.id, { width: Math.max(190, Math.min(420, n.name.length * 7 + 74)), height: NODE_H });
  for (const [a, b] of data.edges) g.setEdge(a, b);
  dagre.layout(g);
  pos.clear();
  for (const n of data.nodes) { const p = g.node(n.id); pos.set(n.id, { x: p.x, y: p.y, w: p.width, h: p.height }); }
  lastBox = { w: g.graph().width ?? 0, h: g.graph().height ?? 0 };
}

// ---------------------------------------------------------------- graph drawing
function isHidden(n: VNode): boolean {
  return !!(data?.filter.hide && data.matched && !data.matched.includes(n.id) && n.id !== data.focus);
}

function draw() {
  if (!data) return;
  svg.replaceChildren();
  nodeEls.clear(); edgeEls = [];
  const defs = el('defs');
  for (const k of Object.keys(KIND)) {
    const g = el('linearGradient', { id: `kg-${k}`, x1: 0, y1: 0, x2: 0, y2: 1 });
    g.append(el('stop', { offset: 0, 'stop-color': lighten(colorOf(k), 0.18) }), el('stop', { offset: 1, 'stop-color': colorOf(k) }));
    defs.append(g);
  }
  svg.append(defs);
  const root = el('g', { id: 'root' });
  svg.append(root);
  const pHl = activePipeline ? new Set(data.pipelines.find((p) => p.id === activePipeline)?.selected ?? []) : null;
  const fHl = data.matched ? new Set(data.matched) : null;
  const hidden = new Set(data.nodes.filter(isHidden).map((n) => n.id));
  const findSet = findQ ? new Set(findIds) : null;
  const dimmed = (id: string) => (pHl && !pHl.has(id)) || (fHl && !fHl.has(id) && id !== data!.focus) || (findSet && !findSet.has(id));

  for (const [a, b] of data.edges) {
    if (hidden.has(a) || hidden.has(b)) continue;
    const cls = ['edge'];
    if (selected && b === selected) cls.push('hot-in');
    else if (selected && a === selected) cls.push('hot-out');
    else if (dimmed(a) || dimmed(b)) cls.push(findSet || pHl ? 'dim' : data.filter.scope === 'project' ? 'ctx' : 'dim');
    const path = el('path', { d: edgePath(a, b), class: cls.join(' ') }) as SVGPathElement;
    root.append(path);
    edgeEls.push({ a, b, el: path });
  }
  for (const n of data.nodes) {
    if (hidden.has(n.id)) continue;
    const p = pos.get(n.id)!;
    const cls = ['node'];
    if (dimmed(n.id) && n.id !== selected) cls.push(findSet || pHl ? 'dim' : data.filter.scope === 'project' ? 'ctx' : 'dim');
    if (n.id === data.focus) cls.push('focus');
    if (n.id === selected) cls.push('sel');
    if (KIND[n.kind]?.dashed) cls.push('eph');
    const grp = el('g', { class: cls.join(' '), 'data-id': n.id, transform: `translate(${p.x - p.w / 2},${p.y - p.h / 2})` }) as SVGGElement;
    const col = colorOf(n.kind);
    const R = 12;
    grp.append(el('rect', { class: 'body', width: p.w, height: p.h, rx: R, fill: 'var(--node-bg)', stroke: col }));
    grp.append(el('path', { d: `M${R},0 H${CAP_W} V${p.h} H${R} a${R},${R} 0 0 1 -${R},-${R} V${R} a${R},${R} 0 0 1 ${R},-${R} z`, fill: `url(#kg-${n.kind})` }));
    grp.append(svgIcon(iconOfKind(n.kind), 16, CAP_W / 2 - 8, 9));
    grp.append(el('text', { class: 'code', x: CAP_W / 2, y: p.h - 11, 'text-anchor': 'middle' }, codeOf(n.kind)));
    grp.append(el('text', { class: 'name', x: CAP_W + 10, y: 21 }, n.name.length > 44 ? n.name.slice(0, 43) + '…' : n.name));
    const chip = chipOf(n);
    if (chip) {
      const cw = Math.min(p.w - CAP_W - 18, chip.length * 6 + 16);
      grp.append(el('rect', { class: 'tagbg', x: CAP_W + 10, y: 30, width: cw, height: 16, rx: 8, style: `fill:${col};fill-opacity:.22` }));
      grp.append(el('text', { class: 'tagtx', x: CAP_W + 18, y: 41.5, style: `fill:${lighten(col, 0.6)}` }, chip));
    }
    const k = n.triggers.length;
    const ki = n.ingest.length;
    let rightEdge = p.w + 8;
    if (k) {
      const bw = 26 + String(k).length * 7;
      const b = el('g', { class: 'abadge' + (n.id === airflowFor && airflowFocus === 'run' ? ' open' : ''), 'data-badge': n.id, transform: `translate(${rightEdge - bw},-12)` });
      b.append(el('rect', { width: bw, height: 22, rx: 11 }));
      b.append(airflowLogo(16, 5, 3));
      b.append(el('text', { x: 24, y: 15.5 }, String(k)));
      b.append(el('title', {}, `Run by ${k} Airflow pipeline${k === 1 ? '' : 's'} (dbt selector) — click to view`));
      grp.append(b);
      rightEdge -= bw + 5;
    }
    if (ki) {
      const bw = 26 + String(ki).length * 7;
      const b = el('g', { class: 'ibadge' + (n.id === airflowFor && airflowFocus === 'ingest' ? ' open' : ''), 'data-ibadge': n.id, transform: `translate(${rightEdge - bw},-12)` });
      b.append(el('rect', { width: bw, height: 22, rx: 11 }));
      b.append(svgIcon('ingest', 14, 5, 4));
      b.append(el('text', { x: 24, y: 15.5 }, String(ki)));
      b.append(el('title', {}, `Loaded by ${ki} ingestion pipeline${ki === 1 ? '' : 's'} (writes this table) — click to view`));
      grp.append(b);
    }
    grp.append(el('title', {}, `${n.name}\n${KIND[n.kind]?.label ?? n.kind}${n.tags.length ? '\ntags: ' + n.tags.join(', ') : ''}`));
    nodeEls.set(n.id, grp);
    root.append(grp);
  }
  applyView();
  renderBar();
  renderLegend();
}

function renderBar() {
  selBar.replaceChildren();
  if (!data) return;
  const f = data.filter;
  const active = !!(f.select.trim() || f.exclude.trim() || f.tags.length || f.kinds.length);
  const fb = document.getElementById('fbtn')!;
  fb.replaceChildren(ico('filter', 15), ...(active ? [h('span', { className: 'cnt2' }, String(data.matchedTotal ?? 0))] : []));
  fb.className = filterOpen || active ? 'on' : '';
  document.getElementById('lbtn')!.className = 'sec' + (showLegend ? ' on' : '');
  if (activePipeline) {
    const p = data.pipelines.find((x) => x.id === activePipeline);
    if (p) selBar.append(h('span', { className: 'chip' }, airflowLogoHtml(12), `Highlighting ${p.name}`, h('a', { onclick: () => { activePipeline = null; draw(); renderAirflow(); } }, '✕')));
  }
  if (data.truncated) selBar.append(h('span', { className: 'chip' }, `Showing first 400 of ${data.truncated + 400} — narrow the filter`));
}

// ---------------------------------------------------------------- legend
function renderLegend() {
  legend.style.display = showLegend && data ? 'flex' : 'none';
  legend.replaceChildren();
  if (!data || !showLegend) return;
  const counts = new Map<string, number>();
  for (const n of data.nodes) counts.set(n.kind, (counts.get(n.kind) ?? 0) + 1);
  legend.append(h('b', {}, 'Nodes'));
  for (const k of KIND_ORDER) {
    if (!counts.has(k)) continue;
    const sel = selectedKinds(data.filter);
    const on = sel.has(k);
    const item = h('span', { className: 'li k' + (on ? '' : ' off'), 'data-tip': on ? 'Click to hide this type' : 'Click to show this type', onclick: () => {
      const next = new Set(sel);
      next.has(k) ? next.delete(k) : next.add(k);
      post({ type: 'setFilter', filter: { kinds: encodeKinds(next) } });
    } }, swatch(k), `${KIND[k].label} (${counts.get(k)})`);
    legend.append(item);
  }
  legend.append(h('span', { className: 'sep' }));
  const logo = h('span', { className: 'li', title: 'Number of Airflow pipelines that run this node. Click the badge on a node to see them.' }, airflowLogoHtml(14), 'Airflow pipelines (count) — click badge');
  legend.append(logo);
  legend.append(h('span', { className: 'li', 'data-tip': 'The pipeline whose DAG code loads data into this BigQuery table (e.g. an ingestion DAG for a source). Click the badge to see it.' }, ico('ingest', 14), 'Ingestion pipeline (count)'));
  const lineSample = (cls: string, label: string) => {
    const s = document.createElementNS(NS, 'svg'); s.setAttribute('width', '28'); s.setAttribute('height', '10');
    const p = el('path', { d: 'M1,5 L27,5', class: 'edge ' + cls }); s.append(p);
    return h('span', { className: 'li' }, s, label);
  };
  legend.append(h('span', { className: 'sep' }), lineSample('hot-in', 'feeds selected'), lineSample('hot-out', 'fed by selected'));
  legend.append(h('span', { className: 'li' }, h('span', { className: 'sw', style: 'outline:2px solid var(--vscode-focusBorder);background:transparent' }), 'current model'),
    h('span', { className: 'li' }, h('span', { className: 'sw', style: 'background:#888;opacity:.3' }), 'dimmed = outside filter / pipeline'));
}

// ---------------------------------------------------------------- Airflow dialog (right)
function renderAirflow() {
  dlg.replaceChildren();
  const n = data?.nodes.find((x) => x.id === airflowFor);
  if (!data || !n) { dlg.classList.remove('show'); return; }
  dlg.classList.add('show');
  const total = n.triggers.length + n.ingest.length;
  dlg.append(h('div', { className: 'dh' }, airflowLogoHtml(20), h('b', {}, `Airflow pipelines (${total})`), h('a', { className: 'x', onclick: () => { airflowFor = null; draw(); renderAirflow(); } }, '✕')));
  dlg.append(h('div', { className: 'muted dsub' }, n.name));
  const body = h('div', { className: 'db' });

  const row = (pid: string, lines: HTMLElement[], line: number | undefined) => {
    const p = data!.pipelines.find((x) => x.id === pid);
    if (!p) return;
    const r = h('div', { className: 'pl clickable' + (activePipeline === p.id ? ' on' : ''), title: activePipeline === p.id ? 'Click to remove the highlight' : 'Click to highlight everything this pipeline touches' });
    r.addEventListener('click', () => { activePipeline = activePipeline === p.id ? null : p.id; draw(); renderAirflow(); });
    r.append(h('div', {}, h('b', {}, p.name), h('span', { className: 'muted' }, p.schedule ? `  ${p.schedule}` : '')));
    r.append(h('div', { className: 'muted' }, fileOf(p.file)));
    lines.forEach((l) => r.append(l));
    r.append(h('div', { className: 'row' },
      h('button', { className: 'sec', onclick: (e: Event) => { e.stopPropagation(); post({ type: 'openPipeline', id: p.id, line }); } }, 'Open DAG'),
      ...(activePipeline === p.id ? [h('span', { className: 'muted' }, 'highlighted in graph')] : [])));
    body.append(r);
  };
  const section = (title: string, icon: Node, hint: string, rows: () => void, count: number) => {
    if (!count) return;
    body.append(h('div', { className: 'asec' }, icon, h('b', {}, `${title} (${count})`), withTip(h('span', { className: 'info' }, ico('info', 13)), hint)));
    rows();
  };
  const ingestSection = () => section('Ingests this table', ico('ingest', 14), 'DAG code that loads data into this BigQuery table (found via dataset + table names such as bq_dataset / bq_table).', () => {
    for (const i of n.ingest) {
      const lines = i.refs.map((r) => {
        const note = r.match === 'exact' ? '' : r.match === 'case-insensitive' ? '  · matched ignoring letter case' : '  · matched by table name only (no dataset in the DAG)';
        return h('div', { className: 'sel-expr' }, `→ ${r.dataset ? r.dataset + '.' : ''}${r.table}${note}`);
      });
      row(i.pid, lines, i.refs[0]?.line);
    }
  }, n.ingest.length);
  const runSection = () => section('Runs this model (dbt)', airflowLogoHtml(14), 'DAGs whose dbt --select / --exclude / tag selection includes this node.', () => {
    for (const t of n.triggers) {
      row(t.pid, t.sites.map((s) => h('div', { className: 'sel-expr' }, short(s.select) + (s.exclude ? `   ✕ ${short(s.exclude, 100)}` : ''))), t.sites[0]?.line);
    }
  }, n.triggers.length);
  if (airflowFocus === 'ingest') { ingestSection(); runSection(); } else { runSection(); ingestSection(); }
  if (!total) body.append(h('div', { className: 'muted pad' }, 'No scanned pipeline runs or loads this node.'));
  dlg.append(body);
}

// ---------------------------------------------------------------- model dialog (left): read first, edit on demand → writes the YAML
// pending edits (nothing is written until Submit)
let pDesc: string | undefined;
let pCols: Record<string, string> = {};
let pRemoved = new Set<string>();            // tests: `${column}#${index}`
let pAdded: NewTest[] = [];
let pProp = new Map<string, { path: string[]; value: string }>(); // scalar properties set / created
let pPropDel = new Set<string>();
let pListAdd: { path: string[]; value: string }[] = [];
let pListDel = new Set<string>();            // `${pathKey}#${index}`
let pNewCols: { name: string; description: string }[] = [];
const editing = new Set<string>();           // sections currently in edit mode: desc | props | tests | cols
const openCols = new Set<string>();
const editingCols = new Set<string>();   // columns currently in edit mode
let colQuery = '';

const SEP = '\u0001';
const pk = (path: string[]) => path.join(SEP);
const dotted = (path: string[]) => path.join('.');

function resetPending() {
  pDesc = undefined; pCols = {}; pRemoved = new Set(); pAdded = []; pProp = new Map(); pPropDel = new Set();
  pListAdd = []; pListDel = new Set(); pNewCols = []; editing.clear(); editingCols.clear(); colQuery = '';
}
const dirtyCount = () => (pDesc !== undefined ? 1 : 0) + Object.keys(pCols).length + pRemoved.size + pAdded.length + pProp.size + pPropDel.size + pListAdd.length + pListDel.size + pNewCols.length;

function openModel(id: string) {
  if (modelFor !== id) { resetPending(); meta = null; flash = null; openCols.clear(); }
  modelFor = id; left = 'model';
  post({ type: 'loadMeta', id });
  renderLeft(); renderBar();
}

const GENERIC = ['unique', 'not_null', 'accepted_values', 'relationships', 'custom…'];

/** `accepted_values: A, B, C` / `orders.id → id` style one-liners for the test pills. */
function testSummary(t: TestView): string {
  if (!t.args) return '';
  try {
    const a = JSON.parse(t.args);
    if (t.label === 'accepted_values' && Array.isArray(a.values)) return a.values.join(', ');
    if (t.label === 'relationships') return `${a.to ?? ''} → ${a.field ?? ''}`;
    if (a && typeof a === 'object') return Object.entries(a).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ');
    return String(a);
  } catch { return t.args; }
}

function editToggle(key: string): HTMLButtonElement {
  const on = editing.has(key);
  return iconBtn(on ? 'check' : 'edit', on ? 'Done editing' : 'Edit', () => { on ? editing.delete(key) : editing.add(key); renderLeft(); }, on ? 'on' : '');
}
function sectionHead(title: string, key: string, count?: number, ...extra: Node[]): HTMLElement {
  return h('div', { className: 'sh' }, h('span', { className: 'st' }, title, count !== undefined ? h('span', { className: 'cnt' }, String(count)) : ''), h('span', { className: 'grow' }), ...extra, editToggle(key));
}

/** Add-a-test control, only rendered in edit mode: pick the kind from the dropdown, then fill its inputs. */
function addTestForm(column: string | undefined): HTMLElement {
  const box = h('div', { className: 'addrow' });
  const kind = h('select', {}, ...GENERIC.map((g) => h('option', { value: g }, g)));
  const a = h('input', { type: 'text', placeholder: '' });
  const b = h('input', { type: 'text', placeholder: '' });
  const add = h('button', { className: 'sec' }, ico('plus', 12), 'Add');
  const sync = () => {
    const k = kind.value;
    a.style.display = b.style.display = 'none';
    if (k === 'accepted_values') { a.style.display = ''; a.placeholder = 'values, comma separated'; }
    if (k === 'relationships') { a.style.display = b.style.display = ''; a.placeholder = "to: ref('model')"; b.placeholder = 'field'; }
    if (k === 'custom…') { a.style.display = b.style.display = ''; a.placeholder = 'test name, e.g. dbt_utils.recency'; b.placeholder = 'arguments as JSON (optional)'; }
  };
  kind.addEventListener('change', sync); sync();
  add.addEventListener('click', () => {
    const k = kind.value;
    let test: NewTest['test'] | null = null;
    try {
      if (k === 'unique' || k === 'not_null') test = { name: k };
      else if (k === 'accepted_values') {
        const vals = a.value.split(',').map((x) => x.trim()).filter(Boolean).map((x) => (/^-?\d+(\.\d+)?$/.test(x) ? Number(x) : x));
        if (vals.length) test = { name: k, args: { values: vals } };
      } else if (k === 'relationships') {
        if (a.value.trim() && b.value.trim()) test = { name: k, args: { to: a.value.trim(), field: b.value.trim() } };
      } else if (a.value.trim()) test = { name: a.value.trim(), args: b.value.trim() ? JSON.parse(b.value) : undefined };
    } catch { flash = { kind: 'err', text: 'Arguments must be valid JSON' }; renderLeft(); return; }
    if (!test) return;
    pAdded.push({ column, test });
    flash = null;
    renderLeft();
  });
  box.append(kind, a, b, add);

  // copy a test that is already used somewhere in this model (model level, any column, or pending)
  const known: { label: string; args: string; where: string }[] = [];
  const v = meta?.view;
  if (v) {
    v.tests.forEach((t) => known.push({ label: t.label, args: t.args, where: 'model' }));
    v.columns.forEach((c) => c.tests.forEach((t) => known.push({ label: t.label, args: t.args, where: c.name })));
  }
  pAdded.forEach((t) => known.push({ label: t.test.name, args: t.test.args ? JSON.stringify(t.test.args) : '', where: t.column ?? 'model' }));
  const seen = new Set<string>();
  const options = known.filter((t) => !t.label.startsWith('*') && t.label !== '(unreadable test)' && !seen.has(t.label + t.args) && seen.add(t.label + t.args));
  if (options.length) {
    const copy = h('select', { className: 'copy' }, h('option', { value: '' }, 'Copy from an existing test…'),
      ...options.map((t, i) => h('option', { value: String(i) }, `${t.label}${t.args ? ' ' + short(testSummary({ index: 0, label: t.label, args: t.args }), 40) : ''}  ·  ${t.where}`)));
    copy.addEventListener('change', () => {
      const t = options[Number(copy.value)];
      if (!t) return;
      let args: Record<string, unknown> | undefined;
      try { const j = t.args ? JSON.parse(t.args) : undefined; args = j && typeof j === 'object' && !Array.isArray(j) ? j : undefined; } catch { args = undefined; }
      const dup = [...(column ? v?.columns.find((c) => c.name === column)?.tests : v?.tests) ?? []].some((x) => x.label === t.label && x.args === t.args && !pRemoved.has(`${column ?? ''}#${x.index}`))
        || pAdded.some((x) => x.column === column && x.test.name === t.label && JSON.stringify(x.test.args ?? '') === JSON.stringify(args ?? ''));
      if (dup) { flash = { kind: 'err', text: `"${t.label}" is already on ${column ?? 'this model'}` }; renderLeft(); return; }
      pAdded.push({ column, test: { name: t.label, args } });
      flash = null;
      renderLeft();
    });
    box.append(copy);
  }
  return box;
}

function testPills(tests: TestView[], column: string | undefined, edit: boolean): HTMLElement {
  const wrap = h('div', { className: 'pills' });
  for (const t of tests) {
    const key = `${column ?? ''}#${t.index}`;
    const rm = pRemoved.has(key);
    const sum = testSummary(t);
    const pill = h('span', { className: 'pill test' + (rm ? ' rm' : '') }, ico('check', 11), h('b', {}, t.label));
    if (sum) pill.append(h('span', { className: 'sub' }, short(sum, 60)));
    if (sum.length > 60) pill.setAttribute('data-tip', sum);
    if (edit) pill.append(h('a', { className: 'px', 'data-tip': rm ? 'Undo remove' : 'Remove test', onclick: () => { rm ? pRemoved.delete(key) : pRemoved.add(key); renderLeft(); } }, ico(rm ? 'refresh' : 'x', 11)));
    wrap.append(pill);
  }
  pAdded.forEach((a, i) => {
    if (a.column !== column) return;
    const sum = a.test.args ? Object.entries(a.test.args).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join(' · ') : '';
    const pill = h('span', { className: 'pill test new' }, ico('plus', 11), h('b', {}, a.test.name));
    if (sum) pill.append(h('span', { className: 'sub' }, short(sum, 60)));
    pill.append(h('a', { className: 'px', 'data-tip': 'Discard', onclick: () => { pAdded.splice(i, 1); renderLeft(); } }, ico('x', 11)));
    wrap.append(pill);
  });
  if (!wrap.childNodes.length) wrap.append(h('span', { className: 'muted' }, 'No tests'));
  return wrap;
}

// ---- properties (tags, config.*, meta.*, group, access, …)
function propGroup(p: PropView): 'tags' | 'config' | 'meta' | 'other' {
  const last = p.path[p.path.length - 1];
  if (p.type === 'list' && last === 'tags' && p.path.length <= 2) return 'tags';
  if (p.path[0] === 'config') return p.path.includes('meta') ? 'meta' : 'config';
  if (p.path[0] === 'meta') return 'meta';
  return 'other';
}
const propLabel = (p: PropView) => {
  const [a, b] = p.path;
  return (a === 'config' && b === 'meta' ? p.path.slice(2) : a === 'config' || a === 'meta' ? p.path.slice(1) : p.path).join('.');
};

function renderProps(props: PropView[], edit: boolean): HTMLElement {
  const box = h('div', { className: 'card' });
  const groups: Record<string, PropView[]> = { tags: [], config: [], meta: [], other: [] };
  props.forEach((p) => groups[propGroup(p)].push(p));
  const tagProp = groups.tags[0];
  const tagPath = tagProp?.path ?? ['config', 'tags'];

  const title = (t: string, icon: string) => h('div', { className: 'gt' }, ico(icon, 12), t);

  // tags
  const tagItems = tagProp?.items ?? [];
  if (tagItems.length || pListAdd.some((a) => pk(a.path) === pk(tagPath)) || edit) {
    box.append(title('Tags', 'tag'));
    const pills = h('div', { className: 'pills' });
    tagItems.forEach((t, i) => {
      const key = `${pk(tagPath)}#${i}`; const rm = pListDel.has(key);
      pills.append(h('span', { className: 'pill tag' + (rm ? ' rm' : '') }, t, edit ? h('a', { className: 'px', onclick: () => { rm ? pListDel.delete(key) : pListDel.add(key); renderLeft(); } }, ico(rm ? 'refresh' : 'x', 11)) : ''));
    });
    pListAdd.forEach((a, i) => { if (pk(a.path) === pk(tagPath)) pills.append(h('span', { className: 'pill tag new' }, a.value, h('a', { className: 'px', onclick: () => { pListAdd.splice(i, 1); renderLeft(); } }, ico('x', 11)))); });
    if (!pills.childNodes.length) pills.append(h('span', { className: 'muted' }, 'No tags'));
    box.append(pills);
  }

  const rows = (list: PropView[], group: string, icon: string, name: string) => {
    const added = [...pProp.values()].filter((v) => !props.some((p) => pk(p.path) === pk(v.path)) && propGroup({ path: v.path, type: 'scalar', value: '', items: [] }) === group);
    if (!list.length && !added.length) return;
    box.append(title(name, icon));
    const grid = h('div', { className: 'kv' });
    for (const p of list) {
      const key = pk(p.path); const rm = pPropDel.has(key);
      const k = h('span', { className: 'k' + (rm ? ' rm' : '') }, propLabel(p));
      let v: HTMLElement;
      if (p.type === 'scalar') {
        if (edit && !rm) {
          const inp = h('input', { type: 'text', value: pProp.get(key)?.value ?? p.value });
          inp.addEventListener('input', () => { inp.value === p.value ? pProp.delete(key) : pProp.set(key, { path: p.path, value: inp.value }); updateFoot(); });
          v = inp;
        } else v = h('span', { className: 'v' + (rm ? ' rm' : '') }, p.value || '—');
      } else if (p.type === 'list') {
        v = h('span', { className: 'pills' }, ...p.items.map((it, i) => {
          const lk = `${key}#${i}`; const lrm = pListDel.has(lk);
          return h('span', { className: 'pill tag' + (lrm ? ' rm' : '') }, it, edit ? h('a', { className: 'px', onclick: () => { lrm ? pListDel.delete(lk) : pListDel.add(lk); renderLeft(); } }, ico(lrm ? 'refresh' : 'x', 11)) : '');
        }));
      } else v = h('code', { className: 'v muted' }, short(p.value, 80));
      const row = h('div', { className: 'kvr' }, k, v);
      if (edit && p.type !== 'complex') row.append(h('a', { className: 'px', 'data-tip': rm ? 'Undo remove' : 'Remove property', onclick: () => { rm ? pPropDel.delete(key) : (pPropDel.add(key), pProp.delete(key)); renderLeft(); } }, ico(rm ? 'refresh' : 'x', 12)));
      grid.append(row);
    }
    for (const a of added) grid.append(h('div', { className: 'kvr' }, h('span', { className: 'k new' }, propLabel({ path: a.path, type: 'scalar', value: '', items: [] })), h('span', { className: 'v new' }, a.value),
      h('a', { className: 'px', onclick: () => { pProp.delete(pk(a.path)); renderLeft(); } }, ico('x', 12))));
    box.append(grid);
  };
  rows(groups.config, 'config', 'gear', 'Config');
  rows(groups.meta, 'meta', 'info', 'Meta');
  rows(groups.other, 'other', 'file', 'Other');
  if (!props.length && !edit && !pProp.size) box.append(h('span', { className: 'muted' }, 'No tags, config or meta defined'));

  if (edit) box.append(addPropForm(props, tagPath));
  return box;
}

function addPropForm(props: PropView[], tagPath: string[]): HTMLElement {
  const box = h('div', { className: 'addrow' });
  const kind = h('select', {}, h('option', { value: 'tag' }, 'Tag'), h('option', { value: 'config' }, 'Config property'), h('option', { value: 'meta' }, 'Meta property'), h('option', { value: 'other' }, 'Other property'));
  const a = h('input', { type: 'text', placeholder: 'tag name' });
  const b = h('input', { type: 'text', placeholder: 'value' });
  const add = h('button', { className: 'sec' }, ico('plus', 12), 'Add');
  const err = h('div', { className: 'err small' });
  const sync = () => {
    b.style.display = kind.value === 'tag' ? 'none' : '';
    a.placeholder = kind.value === 'tag' ? 'tag name' : kind.value === 'config' ? 'e.g. materialized' : kind.value === 'meta' ? 'e.g. owner' : 'e.g. group';
  };
  kind.addEventListener('change', () => { sync(); err.textContent = ''; }); sync();
  add.addEventListener('click', () => {
    const name = a.value.trim();
    if (!name || /\s/.test(name)) { err.textContent = 'Enter a name without spaces'; return; }
    if (kind.value === 'tag') {
      const existing = props.find((p) => pk(p.path) === pk(tagPath))?.items ?? [];
      if (existing.includes(name) || pListAdd.some((x) => x.value === name && pk(x.path) === pk(tagPath))) { err.textContent = `Tag "${name}" already exists`; return; }
      pListAdd.push({ path: tagPath, value: name });
    } else {
      const path = [...(kind.value === 'other' ? [] : [kind.value]), ...name.split('.')];
      if (props.some((p) => pk(p.path) === pk(path)) || pProp.has(pk(path))) { err.textContent = `"${dotted(path)}" already exists — edit it above`; return; }
      pProp.set(pk(path), { path, value: b.value.trim() });
    }
    renderLeft();
  });
  [a, b].forEach((i) => i.addEventListener('keydown', (e) => e.key === 'Enter' && add.click()));
  box.append(kind, a, b, add, err);
  return box;
}

// ---- columns
function columnRow(c: { name: string; description: string; tests: TestView[] }): HTMLElement {
  const edit = editingCols.has(c.name);
  const open = openCols.has(c.name);
  const pendingN = (pCols[c.name] !== undefined ? 1 : 0) + c.tests.filter((t) => pRemoved.has(`${c.name}#${t.index}`)).length + pAdded.filter((a) => a.column === c.name).length;
  const head = h('div', { className: 'chead', onclick: () => { open ? openCols.delete(c.name) : openCols.add(c.name); renderLeft(); } },
    h('span', { className: 'chev' + (open ? ' open' : '') }, ico('chevron', 12)), h('span', { className: 'cn' }, c.name),
    h('span', { className: 'cd' }, short(pCols[c.name] ?? c.description, 70) || ''),
    c.tests.length + pAdded.filter((a) => a.column === c.name).length ? h('span', { className: 'pill mini' }, ico('check', 10), String(c.tests.length + pAdded.filter((a) => a.column === c.name).length)) : '',
    pendingN ? h('span', { className: 'dot', 'data-tip': 'Unsaved changes' }) : '',
    iconBtn(edit ? 'check' : 'edit', edit ? 'Done editing this column' : 'Edit this column', () => { edit ? editingCols.delete(c.name) : (editingCols.add(c.name), openCols.add(c.name)); renderLeft(); }, edit ? 'on cedit' : 'cedit'));
  head.querySelector('.cedit')?.addEventListener('click', (e) => e.stopPropagation()); // after the button's own handler: keep the row from toggling
  const row = h('div', { className: 'crow' + (edit ? ' editing' : '') }, head);
  if (open) {
    const body = h('div', { className: 'cbody' });
    if (edit) {
      const ta = h('textarea', { value: pCols[c.name] ?? c.description, rows: 2, placeholder: 'Describe this column' });
      ta.addEventListener('input', () => { ta.value === c.description ? delete pCols[c.name] : (pCols[c.name] = ta.value); updateFoot(); });
      body.append(ta);
    } else body.append(h('div', { className: 'desc' + (c.description ? '' : ' muted') }, c.description || 'No description'));
    body.append(testPills(c.tests, c.name, edit));
    if (edit) body.append(addTestForm(c.name));
    row.append(body);
  }
  return row;
}

function addColumnForm(existing: string[]): HTMLElement {
  const box = h('div', { className: 'addrow col' });
  const name = h('input', { type: 'text', placeholder: 'new column name' });
  const desc = h('input', { type: 'text', placeholder: 'description (optional)' });
  const add = h('button', { className: 'sec' }, ico('plus', 12), 'Add column');
  const err = h('div', { className: 'err small' });
  const check = (): string => {
    const n = name.value.trim();
    if (!n) return '';
    if (/\s/.test(n)) return 'Column names cannot contain spaces';
    if ([...existing, ...pNewCols.map((c) => c.name)].some((e) => e.toLowerCase() === n.toLowerCase())) return `Column "${n}" already exists`;
    return '';
  };
  const refresh = () => { err.textContent = check(); add.disabled = !name.value.trim() || !!check(); };
  name.addEventListener('input', refresh); refresh();
  const submitCol = () => { if (add.disabled) return; pNewCols.push({ name: name.value.trim(), description: desc.value.trim() }); renderLeft(); };
  add.addEventListener('click', submitCol);
  [name, desc].forEach((i) => i.addEventListener('keydown', (e) => e.key === 'Enter' && submitCol()));
  box.append(name, desc, add, err);
  return box;
}

function submit() {
  if (!modelFor || !meta?.view) return;
  const v = meta.view;
  const edits: any = {};
  if (pDesc !== undefined && pDesc !== v.description) edits.description = pDesc;
  if (Object.keys(pCols).length) edits.columns = { ...pCols };
  const all = [{ col: undefined as string | undefined, tests: v.tests }, ...v.columns.map((c) => ({ col: c.name, tests: c.tests }))];
  edits.removeTests = all.flatMap(({ col, tests }) => tests.filter((t) => pRemoved.has(`${col ?? ''}#${t.index}`)).map((t) => ({ column: col, index: t.index, label: t.label })));
  edits.addTests = pAdded.map((a) => ({ column: a.column, test: a.test }));
  edits.setProps = [...pProp.entries()].filter(([k]) => !pPropDel.has(k)).map(([, x]) => x);
  edits.removeProps = [...pPropDel].map((k) => ({ path: k.split(SEP) }));
  edits.addListItems = pListAdd;
  edits.removeListItems = [...pListDel].map((k) => {
    const [pathKey, idx] = k.split('#');
    const prop = v.props.find((p) => pk(p.path) === pathKey);
    return { path: pathKey.split(SEP), index: Number(idx), label: prop?.items[Number(idx)] ?? '' };
  }).filter((r) => !pPropDel.has(r.path.join(SEP)));
  edits.addColumns = pNewCols;
  flash = null;
  post({ type: 'saveMeta', id: modelFor, edits });
}

function renderModel() {
  const n = data?.nodes.find((x) => x.id === modelFor);
  const keepScroll = ldlg.querySelector<HTMLElement>('.mbody')?.scrollTop ?? 0;
  ldlg.replaceChildren();
  if (!n) { ldlg.classList.remove('show'); return; }
  ldlg.classList.add('show');

  const badge = h('span', { className: 'kbadge', style: `background:${colorOf(n.kind)}` }, ico(iconOfKind(n.kind), 18));
  ldlg.append(h('div', { className: 'mh' }, badge,
    h('div', { className: 'mt' }, h('div', { className: 'mname' }, n.name), h('div', { className: 'msub' }, KIND[n.kind]?.label ?? n.kind)),
    iconBtn('x', 'Close', () => { left = null; modelFor = null; renderLeft(); renderBar(); })));

  const acts = h('div', { className: 'acts' });
  if (n.path) acts.append(h('button', { className: 'sec', onclick: () => post({ type: 'open', id: n.id }) }, ico('file', 13), n.type === 'source' ? 'Open YAML' : 'Open SQL'));
  if (n.type !== 'source') acts.append(h('button', { className: 'sec', onclick: () => post({ type: 'openYaml', id: n.id }) }, ico('yaml', 13), 'Open YAML'));
  const k = n.triggers.length;
  if (k) acts.append(h('button', { className: 'sec', onclick: () => { airflowFor = n.id; airflowFocus = 'run'; draw(); renderAirflow(); } }, airflowLogoHtml(13), `${k} run${k === 1 ? '' : 's'} it`));
  if (n.ingest.length) acts.append(h('button', { className: 'sec', onclick: () => { airflowFor = n.id; airflowFocus = 'ingest'; draw(); renderAirflow(); } }, ico('ingest', 13), `${n.ingest.length} ingest${n.ingest.length === 1 ? 's' : ''} it`));
  ldlg.append(acts);

  const body = h('div', { className: 'mbody' });
  ldlg.append(body);
  if (!meta || meta.id !== n.id) { body.append(h('div', { className: 'muted pad' }, 'Loading YAML…')); return; }
  if (meta.error || !meta.view) { body.append(h('div', { className: 'err pad' }, meta.error ?? 'No metadata')); return; }
  const v = meta.view;
  body.append(h('div', { className: 'muted src' }, ico('yaml', 12), meta.file ?? ''));

  // description
  const dEdit = editing.has('desc');
  body.append(sectionHead('Description', 'desc'));
  if (dEdit) {
    const ta = h('textarea', { value: pDesc ?? v.description, rows: 4, placeholder: 'What does this model contain? State the grain.' });
    ta.addEventListener('input', () => { ta.value === v.description ? (pDesc = undefined) : (pDesc = ta.value); updateFoot(); });
    body.append(ta);
  } else body.append(h('div', { className: 'desc' + ((pDesc ?? v.description) ? '' : ' muted') }, (pDesc ?? v.description) || 'No description yet — click the pencil to add one'));

  // properties
  body.append(sectionHead('Properties', 'props'));
  body.append(renderProps(v.props, editing.has('props')));

  // model-level tests
  const tEdit = editing.has('tests');
  body.append(sectionHead('Tests', 'tests', v.tests.length + pAdded.filter((a) => !a.column).length));
  body.append(testPills(v.tests, undefined, tEdit));
  if (tEdit) body.append(addTestForm(undefined));

  // columns
  const addingCol = editing.has('newcol');
  const q = h('input', { type: 'text', className: 'csearch', placeholder: 'Search columns', value: colQuery });
  q.addEventListener('input', () => { colQuery = q.value; renderLeft(true); });
  body.append(h('div', { className: 'sh' }, h('span', { className: 'st' }, 'Columns', h('span', { className: 'cnt' }, String(v.columns.length + pNewCols.length))), h('span', { className: 'grow' }),
    iconBtn(addingCol ? 'check' : 'plus', addingCol ? 'Done adding' : 'Add a column', () => { addingCol ? editing.delete('newcol') : editing.add('newcol'); renderLeft(); }, addingCol ? 'on' : '')));
  if (v.columns.length > 4) body.append(h('div', { className: 'search' }, ico('search', 13), q));
  const list = h('div', { className: 'clist' });
  for (const c of v.columns) if (!colQuery || c.name.toLowerCase().includes(colQuery.toLowerCase())) list.append(columnRow(c));
  pNewCols.forEach((c, i) => list.append(h('div', { className: 'crow new' }, h('div', { className: 'chead' }, h('span', { className: 'cn' }, c.name), h('span', { className: 'cd' }, c.description), h('span', { className: 'pill mini new' }, 'new'),
    h('a', { className: 'px', 'data-tip': 'Discard', onclick: () => { pNewCols.splice(i, 1); renderLeft(); } }, ico('x', 12))))));
  if (!list.childNodes.length) list.append(h('span', { className: 'muted pad' }, v.columns.length ? 'No matching columns' : 'No columns declared in the YAML'));
  body.append(list);
  if (addingCol) body.append(addColumnForm(v.columns.map((c) => c.name)));

  const foot = h('div', { className: 'foot' });
  foot.id = 'foot';
  ldlg.append(foot);
  updateFoot();
  body.scrollTop = keepScroll;
}

function updateFoot() {
  const foot = document.getElementById('foot');
  if (!foot) return;
  foot.replaceChildren();
  const n = dirtyCount();
  const m = meta?.saved ? { kind: 'ok' as const, text: meta.saved } : meta?.saveError ? { kind: 'err' as const, text: meta.saveError } : flash;
  if (m) foot.append(h('div', { className: m.kind + ' msg' }, m.text));
  foot.append(h('div', { className: 'row' },
    h('button', { disabled: n === 0, onclick: submit }, ico('check', 13), n ? `Submit ${n} change${n === 1 ? '' : 's'}` : 'Submit'),
    h('button', { className: 'sec', disabled: n === 0, onclick: () => { resetPending(); flash = null; renderLeft(); } }, 'Reset'),
    h('span', { className: 'muted small' }, 'writes to the YAML file')));
}

// ---------------------------------------------------------------- filter dialog (left)
/** Autocomplete for `tag:` tokens (and `source:`-style names are left to the user). Works on any selector text input. */
function attachSuggest(input: HTMLInputElement, tags: string[]) {
  const box = h('div', { className: 'suggest' });
  document.body.append(box);
  const hide = () => { box.style.display = 'none'; };
  const update = () => {
    const pos0 = input.selectionStart ?? input.value.length;
    const before = input.value.slice(0, pos0);
    const m = /(^|[\s,(])((?:@|\d*\+)?)tag:([^\s,]*)$/.exec(before);
    if (!m) return hide();
    const q = m[3].toLowerCase();
    const hits = tags.filter((t) => t.toLowerCase().includes(q)).sort((x, y) => Number(y.toLowerCase().startsWith(q)) - Number(x.toLowerCase().startsWith(q)) || x.length - y.length).slice(0, 8);
    if (!hits.length) return hide();
    box.replaceChildren(...hits.map((t) => h('div', { className: 'sg', onmousedown: (e: Event) => {
      e.preventDefault();
      const start = before.length - m[3].length;
      input.value = input.value.slice(0, start) + t + input.value.slice(pos0);
      const np = start + t.length;
      input.setSelectionRange(np, np);
      input.dispatchEvent(new Event('input'));
      hide();
    } }, t)));
    const r = input.getBoundingClientRect();
    box.style.display = 'block';
    box.style.left = `${Math.max(4, r.left)}px`;
    box.style.width = `${Math.max(180, Math.min(r.width, 360))}px`;
    if (r.top > window.innerHeight / 2) { box.style.top = 'auto'; box.style.bottom = `${window.innerHeight - r.top + 4}px`; }
    else { box.style.bottom = 'auto'; box.style.top = `${r.bottom + 4}px`; }
  };
  input.addEventListener('input', update);
  input.addEventListener('keyup', (e) => { if (!['Enter', 'Escape'].includes(e.key)) update(); });
  input.addEventListener('click', update);
  input.addEventListener('blur', () => setTimeout(hide, 120));
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
}

const RESOURCE_KINDS = ['source', 'seed', 'snapshot', 'exposure'];
const MODEL_KINDS = ['table', 'view', 'incremental', 'ephemeral', 'materialized_view', 'model'];
const ALL_KINDS = [...RESOURCE_KINDS, ...MODEL_KINDS];
/** filter.kinds = [] means "all types"; ['none'] means nothing selected. */
const selectedKinds = (f: Filter) => new Set(f.kinds.length ? f.kinds.filter((k) => ALL_KINDS.includes(k)) : ALL_KINDS);
const encodeKinds = (sel: Set<string>) => (sel.size === ALL_KINDS.length ? [] : sel.size === 0 ? ['none'] : ALL_KINDS.filter((k) => sel.has(k)));

function renderFilter() {
  fdlg.replaceChildren();
  if (!data || !filterOpen) { fdlg.classList.remove('show'); return; }
  fdlg.classList.add('show');
  const f = data.filter;
  const kinds = selectedKinds(f);

  fdlg.append(h('div', { className: 'mh slim' }, h('span', { className: 'kbadge flat' }, ico('filter', 15)), h('div', { className: 'mt' }, h('div', { className: 'mname' }, 'Filter')),
    iconBtn('x', 'Close', () => { filterOpen = false; renderFilter(); renderBar(); })));
  const body = h('div', { className: 'fbody' });

  // always searches the whole project; optionally pulls in lineage around the matches
  const ctxRow = h('label', { className: 'check first' });
  const ctx = h('input', { type: 'checkbox', checked: f.context });
  ctxRow.append(ctx, 'Include upstream / downstream lineage', infoTip('Adds the Upstream / Downstream depth levels around every match, so a single model still shows its lineage. Context nodes are dimmed. Selectors with + operators (1+model+1) set their own depth.'));
  body.append(ctxRow);

  // select / exclude
  body.append(h('div', { className: 'fl' }, 'Select', infoTip('Which nodes to include — same syntax as dbt --select.\nname · tag:daily · path:models/mart · source:crm+\nSpace = union (a b), comma = intersection (tag:a,tag:b).\n+name = with parents, name+ = with children, 2+name = two levels, @name = all related.')));
  const sel = h('input', { type: 'text', value: f.select, placeholder: 'tag:daily,tag:finance+   my_model   1+other', spellcheck: false });
  body.append(sel);
  body.append(h('div', { className: 'fl' }, 'Exclude', infoTip('Nodes to remove from the selection — same syntax as dbt --exclude.\nWith nothing selected, it means "everything except these".')));
  const exc = h('input', { type: 'text', value: f.exclude, placeholder: 'tag:deprecated   staging.*', spellcheck: false });
  body.append(exc);
  attachSuggest(sel, data.allTags);
  attachSuggest(exc, data.allTags);

  // type
  const typeHead = h('div', { className: 'fl' }, 'Type', infoTip('Untick a type to hide it. Everything ticked = all types.'), h('span', { className: 'grow' }));
  const toggleChips: Record<string, HTMLElement> = {};
  const refreshChips = () => {
    for (const k of ALL_KINDS) toggleChips[k]?.classList.toggle('off', !kinds.has(k));
    const n = MODEL_KINDS.filter((k) => kinds.has(k)).length;
    modelChip.classList.toggle('off', n === 0);
    modelChip.classList.toggle('part', n > 0 && n < MODEL_KINDS.length);
  };
  typeHead.append(h('a', { className: 'lnk', onclick: () => { ALL_KINDS.forEach((k) => kinds.add(k)); refreshChips(); } }, 'All'), h('a', { className: 'lnk', onclick: () => { kinds.clear(); refreshChips(); } }, 'None'));
  body.append(typeHead);
  const modelChip = h('button', { className: 'chip2', 'data-tip': 'All models — toggles every materialization below at once', onclick: () => {
    const all = MODEL_KINDS.every((k) => kinds.has(k));
    MODEL_KINDS.forEach((k) => (all ? kinds.delete(k) : kinds.add(k)));
    refreshChips();
  } }, h('span', { className: 'swi', style: 'color:#8aa4c8' }, ico('cube', 14)), 'Model');
  const group = (title: string, list: string[], first?: HTMLElement) => {
    body.append(h('div', { className: 'gl' }, title));
    const wrap = h('div', { className: 'chips' });
    if (first) wrap.append(first);
    for (const k of list) {
      const chip = h('button', { className: 'chip2', onclick: () => { kinds.has(k) ? kinds.delete(k) : kinds.add(k); refreshChips(); } }, swatch(k), (KIND[k]?.label ?? k).replace('Model · ', ''));
      toggleChips[k] = chip;
      wrap.append(chip);
    }
    body.append(wrap);
  };
  group('Resources', RESOURCE_KINDS, modelChip);
  group('Model materialization', MODEL_KINDS);
  refreshChips();

  const apply = () => post({ type: 'setFilter', filter: { select: sel.value, exclude: exc.value, kinds: encodeKinds(kinds), tags: [], scope: 'project', hide: false, context: ctx.checked } });
  [sel, exc].forEach((i) => i.addEventListener('keydown', (e) => e.key === 'Enter' && apply()));
  const foot = h('div', { className: 'ffoot' });
  foot.append(h('button', { onclick: apply }, ico('refresh', 13), 'Apply'),
    h('button', { className: 'sec', onclick: () => post({ type: 'setFilter', filter: { select: '', exclude: '', tags: [], kinds: [], scope: 'project', hide: false, context: true } }) }, 'Clear'));
  if (data.filterError) foot.append(h('span', { className: 'err small' }, data.filterError));
  else if (data.matchedTotal !== null) foot.append(h('span', { className: 'ok small' }, `${data.matchedTotal} match${data.matchedTotal === 1 ? '' : 'es'} in the project`));
  fdlg.append(body, foot);
}

function renderLeft(keepFocusInput = false) {
  const active = keepFocusInput ? (document.activeElement as HTMLInputElement | null) : null;
  const pos0 = active?.selectionStart ?? null;
  if (left === 'model') renderModel();
  else { ldlg.replaceChildren(); ldlg.classList.remove('show'); }
  if (active && pos0 !== null) { const q = ldlg.querySelector<HTMLInputElement>('input[placeholder="filter columns…"]'); q?.focus(); q?.setSelectionRange(pos0, pos0); }
}

// ---------------------------------------------------------------- interaction
let drag: { kind: 'pan' | 'node'; id?: string; sx: number; sy: number; ox: number; oy: number; moved: boolean; badge?: string; ing?: boolean; node?: string } | null = null;

svg.addEventListener('pointerdown', (e) => {
  const t = e.target as Element;
  const ingBadge = t.closest('[data-ibadge]')?.getAttribute('data-ibadge') ?? undefined;
  const badge = t.closest('[data-badge]')?.getAttribute('data-badge') ?? ingBadge;
  const nodeId = t.closest('.node')?.getAttribute('data-id') ?? undefined;
  const p = nodeId ? pos.get(nodeId) : undefined;
  drag = nodeId && p && !badge
    ? { kind: 'node', id: nodeId, sx: e.clientX, sy: e.clientY, ox: p.x, oy: p.y, moved: false, node: nodeId }
    : { kind: 'pan', sx: e.clientX, sy: e.clientY, ox: tx, oy: ty, moved: false, badge, ing: !!ingBadge, node: nodeId };
  svg.setPointerCapture(e.pointerId);
  svg.classList.add('grabbing');
});
svg.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
  if (!drag.moved && Math.hypot(dx, dy) < 4) return;
  drag.moved = true;
  if (drag.kind === 'pan') { tx = drag.ox + dx; ty = drag.oy + dy; applyView(); return; }
  const p = pos.get(drag.id!)!;
  p.x = drag.ox + dx / scale; p.y = drag.oy + dy / scale;
  nodeEls.get(drag.id!)?.setAttribute('transform', `translate(${p.x - p.w / 2},${p.y - p.h / 2})`);
  for (const ed of edgeEls) if (ed.a === drag.id || ed.b === drag.id) ed.el.setAttribute('d', edgePath(ed.a, ed.b));
});
const end = (e: PointerEvent) => {
  const d = drag; drag = null;
  svg.classList.remove('grabbing');
  try { svg.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
  if (!d || d.moved) return;
  if (d.badge) {
    const focus = d.ing ? 'ingest' : 'run';
    airflowFor = airflowFor === d.badge && airflowFocus === focus ? null : d.badge;
    airflowFocus = focus;
    selected = d.badge; draw(); renderAirflow();
  }
  else if (d.node) {
    selected = d.node;
    openModel(d.node); // opens the dialog first so centerOn() can account for it
    draw();
    centerOn(d.node);
  }
  else { // background click: clear selection and close dialogs
    selected = null; airflowFor = null;
    if (left === 'model') { left = null; modelFor = null; }
    draw(); renderAirflow(); renderLeft();
  }
};
svg.addEventListener('pointerup', end);
svg.addEventListener('pointercancel', end);
svg.addEventListener('dblclick', (e) => {
  const t = e.target as Element;
  const id = t.closest('.node')?.getAttribute('data-id');
  if (!id || t.closest('[data-badge],[data-ibadge]')) return;
  selected = id;
  openModel(id);                                       // details popup
  post({ type: 'open', id });                          // open the model's SQL file
  if (data && id !== data.focus) post({ type: 'refocus', id }); // recenter the lineage on it
});
svg.addEventListener('wheel', (e) => {
  e.preventDefault();
  const f = e.deltaY < 0 ? 1.1 : 0.9;
  const r = svg.getBoundingClientRect(); const mx = e.clientX - r.left, my = e.clientY - r.top;
  tx = mx - (mx - tx) * f; ty = my - (my - ty) * f; scale *= f;
  applyView();
}, { passive: false });

// find-in-graph (top right): dims everything but the matches; Enter jumps to the next match
const findIn = document.getElementById('find') as HTMLInputElement;
const findN = document.getElementById('findn')!;
function runFind(keepPos = false) {
  findQ = findIn.value.trim().toLowerCase();
  findIds = findQ && data ? data.nodes.filter((n) => n.name.toLowerCase().includes(findQ) || n.tags.some((t) => t.toLowerCase().includes(findQ))).map((n) => n.id) : [];
  if (!keepPos) findIdx = -1;
  findN.textContent = findQ ? (findIds.length ? `${Math.max(findIdx, 0) + (findIdx < 0 ? 0 : 1)}/${findIds.length}`.replace(/^0\//, '–/') : '0') : '';
  draw();
}
findIn.addEventListener('input', () => runFind());
findIn.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { findIn.value = ''; runFind(); return; }
  if (e.key !== 'Enter' || !findIds.length) return;
  findIdx = (findIdx + (e.shiftKey ? -1 : 1) + findIds.length) % findIds.length;
  selected = findIds[findIdx];
  runFind(true);
  centerOn(selected, 0.8);
});

// Airflow source button: set up (none) · rescan (local folder) · sync (GCS) — plus a gear to change the source
type SyncMsg = { state: string; text: string; at: number | null; source?: 'none' | 'local' | 'gcs' };
let airflowSrc: 'none' | 'local' | 'gcs' = 'none';
const syncBtn = document.getElementById('sync') as HTMLButtonElement;
const setupBtn = document.getElementById('asetup') as HTMLButtonElement;
setupBtn.replaceChildren(ico('gear', 14));
setupBtn.setAttribute('data-tip', 'Change where Airflow pipelines come from');
setupBtn.addEventListener('click', () => post({ type: 'setupAirflow' }));
syncBtn.addEventListener('click', () => post({ type: airflowSrc === 'gcs' ? 'syncDags' : airflowSrc === 'local' ? 'rescan' : 'setupAirflow' }));
function showSync(m: SyncMsg) {
  airflowSrc = m.source ?? airflowSrc;
  const label = airflowSrc === 'gcs' ? 'Sync DAGs' : airflowSrc === 'local' ? 'Rescan DAGs' : 'Set up Airflow';
  syncBtn.replaceChildren(airflowLogoHtml(14), h('span', {}, label));
  setupBtn.style.display = airflowSrc === 'none' ? 'none' : '';
  syncBtn.disabled = m.state === 'running';
  syncBtn.classList.toggle('spin', m.state === 'running');
  syncBtn.classList.toggle('bad', m.state === 'error');
  const when = m.at ? `last synced ${new Date(m.at).toLocaleString()}` : 'not synced yet';
  syncBtn.setAttribute('data-tip',
    m.state === 'error' ? `Sync failed: ${m.text}` : m.state === 'running' ? m.text
      : airflowSrc === 'gcs' ? `Refresh the Airflow DAGs from GCS\n${m.text ? m.text + ' · ' : ''}${when}`
      : airflowSrc === 'local' ? `Re-read the DAG folder(s)\n${m.text}`
      : 'Optional: show which Airflow pipelines run each model.\nPick a local folder or a Google Cloud Storage bucket.');
}
showSync({ state: 'idle', text: '', at: null, source: 'none' });

// floating bar icons + tooltips
const setIcon = (id: string, name: string, tip: string, size = 15) => { const b = document.getElementById(id)!; b.replaceChildren(ico(name, size)); b.setAttribute('data-tip', tip); b.removeAttribute('title'); };
setIcon('apply', 'refresh', 'Apply selector (Enter)');
setIcon('clr', 'x', 'Clear search', 13);
setIcon('fbtn', 'filter', 'Filter: select / exclude / types');
setIcon('lbtn', 'info', 'Show or hide the legend');
setIcon('zin', 'plus', 'Zoom in');
setIcon('zout', 'minus', 'Zoom out');
setIcon('fit', 'expand', 'Fit to view');
document.getElementById('findic')?.replaceChildren(ico('search', 14));
document.querySelector('#float .ic')?.replaceChildren(ico('search', 15));
document.getElementById('fit')!.addEventListener('click', () => { fit(); applyView(); });
document.getElementById('zin')!.addEventListener('click', () => zoomBy(1.25));
document.getElementById('zout')!.addEventListener('click', () => zoomBy(0.8));
document.getElementById('fbtn')!.addEventListener('click', () => { filterOpen = !filterOpen; renderFilter(); renderBar(); });
document.getElementById('lbtn')!.addEventListener('click', () => { showLegend = !showLegend; renderLegend(); renderBar(); });

const up = document.getElementById('up') as HTMLInputElement;
const down = document.getElementById('down') as HTMLInputElement;
const sendDepth = () => post({ type: 'depth', up: up.value, down: down.value });
up.addEventListener('change', sendDepth);
down.addEventListener('change', sendDepth);

// floating dbt-selector search: Enter shows that selection as its own graph; clearing restores the lineage
const q = document.getElementById('q') as HTMLInputElement;
const clr = document.getElementById('clr') as HTMLButtonElement;
q.addEventListener('input', () => { clr.style.display = q.value ? '' : 'none'; });
const applySearch = () => {
  const v = q.value.trim();
  post({ type: 'setFilter', filter: { select: v, scope: 'project' } });
};
q.addEventListener('keydown', (e) => { if (e.key === 'Enter') applySearch(); });
document.getElementById('apply')!.addEventListener('click', applySearch);
let suggestAttached = false;
clr.addEventListener('click', () => {
  q.value = ''; clr.style.display = 'none';
  post({ type: 'setFilter', filter: { select: '', scope: 'project' } });
});

window.addEventListener('message', (ev) => {
  const m = ev.data;
  if (m?.type === 'meta') {
    if (m.id !== modelFor) return;
    const wasSave = !!(m.saved || m.saveError);
    meta = m;
    if (m.saved) { resetPending(); flash = null; }
    if (left === 'model') renderLeft();
    if (wasSave) setTimeout(() => { if (meta === m) { meta = { ...m, saved: undefined, saveError: undefined }; updateFoot(); } }, 4000);
    return;
  }
  if (m?.type === 'sync') { showSync(m); return; }
  if (m?.type !== 'graph') return;
  const prev = data?.focus;
  const prevLayoutKey = data ? data.nodes.map((n) => n.id).join('|') : '';
  data = m.payload as Payload;
  if (activePipeline && !data.pipelines.some((p) => p.id === activePipeline)) activePipeline = null;
  if (airflowFor && !data.nodes.some((n) => n.id === airflowFor)) airflowFor = null;
  if (modelFor && !data.nodes.some((n) => n.id === modelFor)) { modelFor = null; if (left === 'model') left = null; }
  const refocused = prev !== data.focus;
  if (refocused) { // behave as if the user had clicked the new focus: selected (animated links), centered, details follow
    selected = data.focus;
    if (airflowFor !== data.focus) airflowFor = null;
    if (modelFor !== data.focus) modelFor = null;
  }
  const relayout = prevLayoutKey !== data.nodes.map((n) => n.id).join('|') || prev !== data.focus;
  if (relayout) { layout(); fit(); }
  if (findQ) runFind(true); else draw();
  renderAirflow();
  if (refocused && left === 'model') openModel(data.focus); // an open details dialog follows the focused model
  if (refocused) centerOn(data.focus);
  // a new search: select + center the model(s) you searched for (they may sit far from the middle of a big graph)
  const fkey = `${data.filter.select}|${data.filter.exclude}`;
  const searched = fkey !== lastFilterKey && !!data.seeds?.length && !refocused;
  lastFilterKey = fkey;
  if (searched) { selected = data.seeds![0]; draw(); centerOn(selected, 0.9); }
  if (left !== 'model') renderLeft(); // keep in-progress YAML edits untouched when only the filter/legend changed
  if (filterOpen) renderFilter();
  if (!suggestAttached) { suggestAttached = true; attachSuggest(q, data.allTags); }
  // a selector with + operators (1+m+1, m+1) sets the depths itself; -1 = unlimited
  for (const [inp, v] of [[up, data.depthUp], [down, data.depthDown]] as const) {
    inp.value = v < 0 ? '' : String(v);
    inp.placeholder = '∞';
    inp.disabled = data.depthFromSelector;
    inp.setAttribute('data-tip', data.depthFromSelector ? 'Set by the + operators in your selector' : 'Levels shown around the focused model');
    inp.removeAttribute('title');
  }
  if (document.activeElement !== q) { q.value = data.filter.select; clr.style.display = q.value ? '' : 'none'; }
  q.style.color = data.filterError ? 'var(--vscode-errorForeground)' : '';
  q.title = data.filterError ?? '';
});

post({ type: 'ready' });
