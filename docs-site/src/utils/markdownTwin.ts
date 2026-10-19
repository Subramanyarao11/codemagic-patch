/**
 * URL path of a docs page's markdown twin, per the llmstxt.org rule: the page
 * URL with `.md` appended, or `index.md` when the URL ends in a slash.
 *
 *   /docs/install   → /docs/install.md
 *   /docs/          → /docs/index.md
 *   /docs/releases/ → /docs/releases/index.md
 *
 * Takes a Docusaurus permalink (which already includes `baseUrl`). The llms
 * plugin writes the files at these paths and the page head and Send to AI
 * menu link to them, so this is the only place the mapping lives.
 */
export function markdownTwinPath(permalink: string): string {
  return permalink.endsWith('/') ? `${permalink}index.md` : `${permalink}.md`;
}
