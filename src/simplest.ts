import { resolve } from './selector';
import type { GNode, Graph } from './types';

export interface SimplestInput {
  focus: string;
  scope: 'lineage' | 'project';
  up: number;
  down: number;
  expandUp: string[];
  expandDown: string[];
  select: string;
  exclude: string;
}

const refOf = (n: GNode) => (n.type === 'source' ? `source:${n.sourceName}.${n.name}` : n.type === 'exposure' ? `exposure:${n.name}` : n.name);
const MAX_LISTED = 30;

/**
 * The shortest dbt selector that, run with our own selector engine, gives exactly the nodes on screen
 * (`2+model+2`, `+model`, `model+1 1+other` once + buttons were used…). Falls back to listing the models.
 */
export function simplestSelector(g: Graph, shown: Iterable<string>, i: SimplestInput): { text: string; exact: boolean } {
  const want = new Set([...shown].filter((id) => g.nodes[id]?.type !== 'exposure')); // selectors list models, seeds, snapshots and sources
  const same = (sel: string, exclude = '') => {
    try {
      const got = resolve(g, sel, exclude);
      return got.size === want.size && [...got].every((id) => want.has(id));
    } catch { return false; }
  };
  const focus = g.nodes[i.focus];
  if (i.scope === 'lineage' && focus) {
    const ref = refOf(focus);
    const ups = [...new Set([i.up > 0 ? `${i.up}+` : '', '+'])], downs = [...new Set([i.down > 0 ? `+${i.down}` : '', '+'])];
    const bases = ups.flatMap((u) => downs.map((d) => `${u}${ref}${d}`)).sort((a, b) => a.length - b.length);
    const known = (n: string) => !!g.nodes[n];
    const extra = [...i.expandDown.filter(known).map((n) => `${refOf(g.nodes[n])}+1`), ...i.expandUp.filter(known).map((n) => `1+${refOf(g.nodes[n])}`)];
    for (const base of bases) {
      let terms = [...extra];
      if (!same([base, ...terms].join(' '))) continue;
      for (let k = terms.length - 1; k >= 0; k--) { // drop terms that add nothing
        const t = terms.filter((_, j) => j !== k);
        if (same([base, ...t].join(' '))) terms = t;
      }
      return { text: [base, ...terms].join(' '), exact: true };
    }
  } else if (i.select.trim() || i.exclude.trim()) {
    const known = (n: string) => !!g.nodes[n];
    let terms = [...i.expandDown.filter(known).map((n) => `${refOf(g.nodes[n])}+1`), ...i.expandUp.filter(known).map((n) => `1+${refOf(g.nodes[n])}`)];
    const make = (t: string[]) => [i.select.trim(), ...t].filter(Boolean).join(' ');
    if (same(make(terms), i.exclude)) {
      for (let k = terms.length - 1; k >= 0; k--) { const t = terms.filter((_, j) => j !== k); if (same(make(t), i.exclude)) terms = t; }
      return { text: i.exclude.trim() ? `${make(terms)} --exclude ${i.exclude.trim()}` : make(terms), exact: true };
    }
  }
  const list = [...want].map((id) => refOf(g.nodes[id])).sort();
  return list.length <= MAX_LISTED ? { text: list.join(' '), exact: true } : { text: `${list.slice(0, MAX_LISTED).join(' ')} … (+${list.length - MAX_LISTED} more)`, exact: false };
}
