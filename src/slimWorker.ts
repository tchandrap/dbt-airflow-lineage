// Runs in a forked process: the manifest can be hundreds of MB, so keep it out of the extension host.
import * as fs from 'fs';
import type { Graph, GNode } from './types';

const KEEP = new Set(['model', 'seed', 'snapshot']);

export function slim(manifest: any): Graph {
  const nodes: Record<string, GNode> = {};
  for (const [id, n] of Object.entries<any>(manifest.nodes ?? {})) {
    if (!KEEP.has(n.resource_type)) continue;
    nodes[id] = {
      id, name: n.name, type: n.resource_type, tags: n.tags ?? [], fqn: n.fqn ?? [],
      path: n.original_file_path, pkg: n.package_name, materialized: n.config?.materialized,
      group: n.group ?? null, access: n.access ?? null, patchPath: n.patch_path ?? undefined,
      schema: n.schema ?? undefined, table: n.alias ?? n.name,
    };
  }
  for (const [id, s] of Object.entries<any>(manifest.sources ?? {})) {
    nodes[id] = {
      id, name: s.name, type: 'source', tags: s.tags ?? [], fqn: s.fqn ?? [], path: s.original_file_path,
      pkg: s.package_name, sourceName: s.source_name, schema: s.schema ?? undefined, table: s.identifier ?? s.name,
    };
  }
  for (const [id, e] of Object.entries<any>(manifest.exposures ?? {})) {
    nodes[id] = { id, name: e.name, type: 'exposure', tags: e.tags ?? [], fqn: e.fqn ?? [], path: e.original_file_path, pkg: e.package_name };
  }
  const parents: Record<string, string[]> = {};
  const children: Record<string, string[]> = {};
  for (const id of Object.keys(nodes)) { parents[id] = []; children[id] = []; }
  for (const [id, ps] of Object.entries<string[]>(manifest.parent_map ?? {})) {
    if (!nodes[id]) continue;
    for (const p of ps) if (nodes[p]) { parents[id].push(p); children[p].push(id); }
  }
  return { nodes, parents, children, selectors: manifest.selectors ?? {}, generatedAt: manifest.metadata?.generated_at };
}

if (require.main === module) {
  const [manifestPath, outPath] = process.argv.slice(2);
  try {
    const g = slim(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
    fs.writeFileSync(outPath, JSON.stringify(g));
    process.send?.({ ok: true });
  } catch (e: any) {
    process.send?.({ ok: false, error: String(e?.message ?? e) });
  }
  process.exit(0);
}
