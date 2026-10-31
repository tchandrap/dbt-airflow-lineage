import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { buildSync } from 'esbuild';
import { handleMessage } from '../src/mcp/protocol';
import { LineageIndex } from '../src/index';
import { TOOLS } from '../src/tools';
import { claudeCodeCommand, claudeDesktopConfigPath, codexToml, jsonEntry, mergeClaudeDesktopConfig } from '../src/mcp/clients';
import type { Graph } from '../src/types';

const node = (name: string, extra: object = {}) => ({ name, resource_type: 'model', package_name: 'p', original_file_path: `models/${name}.sql`, tags: [], fqn: ['p', name], config: { materialized: 'table' }, ...extra });
const manifest = {
  nodes: { 'model.p.stg': node('stg'), 'model.p.rpt': node('rpt', { tags: ['report'] }) },
  sources: {}, exposures: {}, selectors: {},
  parent_map: { 'model.p.stg': [], 'model.p.rpt': ['model.p.stg'] },
};
const idx = () => new LineageIndex({ nodes: {}, parents: {}, children: {}, selectors: {} } as Graph, []);
const deps = { load: () => ({ index: idx() }), report: () => ({ include: ['tag:report'], exclude: [] as string[] }), version: '9.9.9' };

describe('MCP protocol', () => {
  it('initializes, lists the tools and ignores notifications', () => {
    const init: any = handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, deps);
    expect(init.result.protocolVersion).toBe('2025-03-26');
    expect(init.result.serverInfo.version).toBe('9.9.9');
    expect(init.result.capabilities).toEqual({ tools: {} });
    expect(handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, deps)).toBeUndefined();
    const list: any = handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, deps);
    expect(list.result.tools.map((t: any) => t.name)).toEqual(TOOLS.map((t) => t.name));
  });
  it('answers calls as text and reports problems without crashing', () => {
    const ok: any = handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'find_models', arguments: { query: 'zzz' } } }, deps);
    expect(ok.result.content[0].text).toMatch(/Nothing matches/);
    const bad: any = handleMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope' } }, deps);
    expect(bad.error.code).toBe(-32602);
    const down: any = handleMessage({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'find_models', arguments: { query: 'x' } } }, { ...deps, load: () => ({ error: 'no manifest' }) });
    expect(down.result.isError).toBe(true);
    expect((handleMessage({ jsonrpc: '2.0', id: 6, method: 'what' }, deps) as any).error.code).toBe(-32601);
    expect((handleMessage({ jsonrpc: '2.0', id: 7, method: 'ping' }, deps) as any).result).toEqual({});
  });
});

describe('MCP server process', () => {
  it('answers a real stdio conversation from a manifest', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'));
    const bundle = path.join(dir, 'mcp.js');
    buildSync({ entryPoints: [path.join(__dirname, '../src/mcp/server.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'silent' });
    const manifestPath = path.join(dir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const child = spawn(process.execPath, [bundle], { env: { ...process.env, DBT_AIRFLOW_MANIFEST: manifestPath, DBT_AIRFLOW_REPORT_INCLUDE: JSON.stringify(['tag:report']) } });
    const replies: any[] = [];
    let buf = '';
    child.stdout.on('data', (d) => { buf += String(d); let i; while ((i = buf.indexOf('\n')) >= 0) { replies.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
    const send = (m: object) => child.stdin.write(JSON.stringify(m) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'impacted_reports', arguments: { model: 'stg' } } });
    await new Promise<void>((resolve, reject) => { const t = Date.now(); const timer = setInterval(() => { if (replies.length >= 2) { clearInterval(timer); resolve(); } else if (Date.now() - t > 8000) { clearInterval(timer); reject(new Error('no reply')); } }, 25); });
    child.stdin.end();
    expect(replies[1].result.content[0].text).toMatch(/stg impacts 1 report\(s\)[\s\S]*rpt \(1 hop\): stg -> rpt/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('AI client setup text', () => {
  const spec = { command: "/Apps/Code Helper/Code", args: ['--max-old-space-size=4096', '/s/mcp.js'], env: { ELECTRON_RUN_AS_NODE: '1', DBT_AIRFLOW_REPORT_VALUE: "it's" } };
  it('builds the Claude Code command with safe quoting', () => {
    const c = claudeCodeCommand(spec);
    expect(c.startsWith('claude mcp add dbt-airflow-lineage -e ELECTRON_RUN_AS_NODE=\'1\'')).toBe(true);
    expect(c).toContain(`-- '/Apps/Code Helper/Code' '--max-old-space-size=4096' '/s/mcp.js'`);
    expect(c).toContain(`DBT_AIRFLOW_REPORT_VALUE='it'\\''s'`);
  });
  it('builds the JSON and Codex entries', () => {
    expect(JSON.parse(jsonEntry(spec)).mcpServers['dbt-airflow-lineage'].args[1]).toBe('/s/mcp.js');
    const toml = codexToml(spec);
    expect(toml).toContain('[mcp_servers.dbt-airflow-lineage]');
    expect(toml).toContain('args = ["--max-old-space-size=4096","/s/mcp.js"]');
  });
  it('merges into a Claude Desktop config without touching other servers, and refuses broken files', () => {
    const before = JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'x' } } });
    const after = JSON.parse(mergeClaudeDesktopConfig(before, spec));
    expect(after.theme).toBe('dark');
    expect(after.mcpServers.other).toEqual({ command: 'x' });
    expect(after.mcpServers['dbt-airflow-lineage'].command).toBe(spec.command);
    expect(JSON.parse(mergeClaudeDesktopConfig(undefined, spec)).mcpServers['dbt-airflow-lineage']).toBeTruthy();
    expect(() => mergeClaudeDesktopConfig('{ nope', spec)).toThrow(/not valid JSON/);
    expect(() => mergeClaudeDesktopConfig('{"mcpServers": []}', spec)).toThrow(/not an object/);
  });
  it('knows where Claude Desktop keeps its config', () => {
    expect(claudeDesktopConfigPath('darwin', '/Users/a')).toBe('/Users/a/Library/Application Support/Claude/claude_desktop_config.json');
    expect(claudeDesktopConfigPath('win32', 'C:\\Users\\a', 'C:\\Users\\a\\AppData\\Roaming')).toContain('Claude\\claude_desktop_config.json');
  });
});
