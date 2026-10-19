// Removes markdown copies the old sync-md-to-static.mjs left in static/.
// Docusaurus would copy them into build/docs/ (served at /docs/docs/), which
// check-llms rejects. Safe to run on every build and start.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const staticDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'static',
);

for (const entry of ['docs', 'intro', 'llms.txt', 'llms-full.txt']) {
  await fs.rm(path.join(staticDir, entry), {recursive: true, force: true});
}
