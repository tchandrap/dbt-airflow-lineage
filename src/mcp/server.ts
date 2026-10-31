import * as readline from 'readline';
import { handleMessage } from './protocol';
import { makeLoader, reportFromEnv } from './load';

/**
 * Local MCP server (stdio): lets an AI agent ask about the dbt lineage and the Airflow pipelines.
 * Started by the editor, which sets the DBT_AIRFLOW_* variables described in load.ts. Read-only; no network.
 * stdout is reserved for the protocol, so everything else goes to stderr.
 */

const deps = { load: makeLoader(process.env), report: () => reportFromEnv(process.env), version: process.env.DBT_AIRFLOW_VERSION ?? '0.0.0' };

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg: unknown;
  try { msg = JSON.parse(line); } catch { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n'); return; }
  try {
    const res = handleMessage(msg, deps);
    if (res) process.stdout.write(JSON.stringify(res) + '\n');
  } catch (e: any) {
    process.stderr.write(`dbt-airflow-lineage MCP: ${e?.stack ?? e}\n`);
    const id = (msg as any)?.id;
    if (id !== undefined && id !== null) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message: 'Internal error' } }) + '\n');
  }
});
rl.on('close', () => process.exit(0));
