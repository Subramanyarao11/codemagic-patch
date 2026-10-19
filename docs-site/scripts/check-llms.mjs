// Fails the build when build/llms.txt links to a file the build did not
// produce, or when markdown lands under build/docs/ (served as /docs/docs/).
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const siteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = path.join(siteDir, 'build');

// Resolved site config from the build that just ran.
const {default: siteConfig} = await import(
  pathToFileURL(path.join(siteDir, '.docusaurus', 'docusaurus.config.mjs')).href
);
const siteRoot = `${siteConfig.url}${siteConfig.baseUrl}`;

const llmsTxt = await fs.readFile(path.join(buildDir, 'llms.txt'), 'utf8');
const links = [...llmsTxt.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]);
const errors = [];

if (links.length === 0) {
  errors.push('build/llms.txt has no links');
}

for (const link of links) {
  if (!link.startsWith(siteRoot)) {
    errors.push(`${link}: not an absolute URL under ${siteRoot}`);
    continue;
  }
  const file = path.join(buildDir, decodeURIComponent(link.slice(siteRoot.length)));
  try {
    await fs.access(file);
  } catch {
    errors.push(`${link}: build/${path.relative(buildDir, file)} does not exist`);
  }
}

try {
  await fs.access(path.join(buildDir, 'llms-full.txt'));
} catch {
  errors.push('build/llms-full.txt does not exist');
}

const strayDir = path.join(buildDir, 'docs');
const stray = await fs
  .readdir(strayDir, {recursive: true})
  .catch(() => [])
  .then((entries) => entries.filter((entry) => entry.endsWith('.md')));
for (const entry of stray) {
  errors.push(`build/docs/${entry}: markdown under build/docs/ is served at ${siteRoot}docs/`);
}

if (errors.length > 0) {
  console.error(`check-llms: ${errors.length} problem(s)\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  process.exit(1);
}

console.log(`check-llms: ${links.length} llms.txt links resolve to files in build/`);
