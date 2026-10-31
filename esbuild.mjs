import { build, context } from 'esbuild';
const watch = process.argv.includes('--watch');
const common = { bundle: true, sourcemap: true, logLevel: 'info' };
const configs = [
  { ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', platform: 'node', format: 'cjs', external: ['vscode'] },
  { ...common, entryPoints: ['src/mcp/server.ts'], outfile: 'dist/mcp.js', platform: 'node', format: 'cjs' },
  { ...common, entryPoints: ['src/slimWorker.ts'], outfile: 'dist/slimWorker.js', platform: 'node', format: 'cjs' },
  { ...common, entryPoints: ['src/webview/main.ts'], outfile: 'dist/webview.js', platform: 'browser', format: 'iife', loader: { '.svg': 'text' } },
];
for (const c of configs) { if (watch) (await context(c)).watch(); else await build(c); }
