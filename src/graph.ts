import type { Graph } from './types';

export function neighborhood(g: Graph, id: string, up: number, down: number = up) {
  const level = new Map<string, number>([[id, 0]]);
  const bfs = (map: Record<string, string[]>, sign: 1 | -1, depth: number) => {
    let fr = [id];
    for (let d = 1; d <= depth && fr.length; d++) {
      const nx: string[] = [];
      for (const n of fr) for (const m of map[n] ?? []) if (!level.has(m)) { level.set(m, d * sign); nx.push(m); }
      fr = nx;
    }
  };
  bfs(g.parents, -1, up); bfs(g.children, 1, down);
  return level;
}
