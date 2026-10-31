// Runs in a forked process: the manifest can be hundreds of MB, so keep it out of the extension host.
import * as fs from 'fs';
import { slim } from './slim';

export { slim };

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
