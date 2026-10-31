import type { LineageIndex } from '../index';
import { ReportConfig, runTool, TOOLS } from '../tools';

/**
 * The Model Context Protocol, the small part this server needs: JSON-RPC 2.0 messages, one per line on stdio.
 * Pure (no I/O) so it can be unit tested; server.ts wires it to stdin and stdout.
 */

export interface McpDeps {
  /** The lineage index, or an error text when it cannot be built (no manifest, unreadable file…). Loaded lazily on the first tool call. */
  load: () => { index: LineageIndex } | { error: string };
  report: () => ReportConfig;
  version: string;
}

const DEFAULT_PROTOCOL = '2024-11-05';

export function handleMessage(msg: any, deps: McpDeps): object | undefined {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return undefined;
  const { id, method, params } = msg;
  const reply = (result: object) => ({ jsonrpc: '2.0', id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });
  if (id === undefined || id === null) return undefined; // notifications (initialized, cancelled…) get no reply
  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : DEFAULT_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: 'dbt-airflow-lineage', version: deps.version },
        instructions: 'Read-only questions about a dbt project\'s lineage and its Airflow pipelines. Start with find_models when you only have an approximate model name.',
      });
    case 'ping': return reply({});
    case 'tools/list': return reply({ tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
    case 'tools/call': {
      const name = params?.name;
      if (typeof name !== 'string' || !TOOLS.some((t) => t.name === name)) return fail(-32602, `Unknown tool: ${String(name)}`);
      const loaded = deps.load();
      if ('error' in loaded) return reply({ content: [{ type: 'text', text: loaded.error }], isError: true });
      return reply({ content: [{ type: 'text', text: runTool(loaded.index, deps.report(), name, params?.arguments ?? {}) }] });
    }
    default: return fail(-32601, `Method not found: ${String(method)}`);
  }
}
