/**
 * Setup text for AI clients other than the editor's own agent. Pure (no I/O): the extension decides what to write where.
 * All of them start the same local, read-only MCP server (dist/mcp.js) over stdio.
 */

export interface McpServerSpec { command: string; args: string[]; env: Record<string, string> }

export const MCP_SERVER_NAME = 'dbt-airflow-lineage';

const sh = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;

/** `claude mcp add …`: adds the server to Claude Code. */
export function claudeCodeCommand(s: McpServerSpec, name = MCP_SERVER_NAME): string {
  const env = Object.entries(s.env).filter(([, v]) => v).map(([k, v]) => `-e ${k}=${sh(v)}`).join(' ');
  return `claude mcp add ${name} ${env} -- ${sh(s.command)} ${s.args.map(sh).join(' ')}`.replace(/\s+/g, ' ').trim();
}

/** The entry most MCP clients (Claude Desktop, Gemini CLI, Windsurf, Zed…) take under "mcpServers". */
export function jsonEntry(s: McpServerSpec, name = MCP_SERVER_NAME): string {
  return JSON.stringify({ mcpServers: { [name]: { command: s.command, args: s.args, env: s.env } } }, null, 2);
}

/** OpenAI Codex CLI: an entry for ~/.codex/config.toml. */
export function codexToml(s: McpServerSpec, name = MCP_SERVER_NAME): string {
  const env = Object.entries(s.env).filter(([, v]) => v).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(', ');
  return `[mcp_servers.${name}]\ncommand = ${JSON.stringify(s.command)}\nargs = ${JSON.stringify(s.args)}\nenv = { ${env} }\n`;
}

/** Adds or replaces our server in the text of a Claude Desktop config, keeping everything else. Throws if the file is not valid JSON. */
export function mergeClaudeDesktopConfig(existing: string | undefined, s: McpServerSpec, name = MCP_SERVER_NAME): string {
  let cfg: any = {};
  if (existing && existing.trim()) {
    try { cfg = JSON.parse(existing); } catch { throw new Error('The Claude Desktop config is not valid JSON, so it was left untouched. Fix or remove it, then try again.'); }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('The Claude Desktop config is not a JSON object, so it was left untouched.');
  }
  if (cfg.mcpServers !== undefined && (typeof cfg.mcpServers !== 'object' || cfg.mcpServers === null || Array.isArray(cfg.mcpServers))) throw new Error('"mcpServers" in the Claude Desktop config is not an object, so it was left untouched.');
  cfg.mcpServers = { ...(cfg.mcpServers ?? {}), [name]: { command: s.command, args: s.args, env: s.env } };
  return JSON.stringify(cfg, null, 2) + '\n';
}

/** Where Claude Desktop keeps its config on each platform. */
export function claudeDesktopConfigPath(platform: string, home: string, appData?: string): string {
  if (platform === 'darwin') return `${home}/Library/Application Support/Claude/claude_desktop_config.json`;
  if (platform === 'win32') return `${appData ?? `${home}\\AppData\\Roaming`}\\Claude\\claude_desktop_config.json`;
  return `${home}/.config/Claude/claude_desktop_config.json`;
}
