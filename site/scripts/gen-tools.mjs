// Generates the WebMCP tool reference pages from src/data/tools.mjs.
import { mkdirSync, writeFileSync } from 'node:fs';
import { GROUPS, TOOLS } from '../src/data/tools.mjs';
import { STATUS } from '../src/data/status.mjs';

const out = new URL('../src/content/docs/docs/reference/tools/', import.meta.url);
mkdirSync(out, { recursive: true });
const j = (o) => JSON.stringify(o, null, 2);
const order = Object.keys(GROUPS);

order.forEach((gid, idx) => {
  const g = GROUPS[gid];
  const tools = TOOLS.filter((t) => t.group === gid);
  let md = `---
title: "${g.title}"
description: "WebMCP tool reference for ${g.title.toLowerCase()}. ${g.blurb}"
sidebar:
  order: ${idx + 2}
---

${g.blurb} Every tool below follows the conventions in the [tools overview](../): compact JSON, cursors instead of snapshots, optional \`fields\`.

:::caution[Contract, not implementation]
Statuses are honest. **Planned** means no code yet; **In progress** means a building block exists in the repo but the tool is not registered with \`navigator.modelContext\` yet. Schemas are the proposed contract and can change before the first release.
:::

`;
  for (const t of tools) {
    md += `## \`${t.name}\`\n\n`;
    md += `**Status:** ${STATUS[t.status].label}${t.sensitive ? ' · **Sensitive:** designed to require human confirmation (gate not implemented yet)' : ''}\n\n`;
    md += `${t.description}\n\n`;
    if (t.notes) md += `${t.notes}\n\n`;
    md += `### Input schema\n\n\`\`\`json\n${j(t.input)}\n\`\`\`\n\n`;
    md += `### Example\n\n\`\`\`js\nconst result = await tools.call(${JSON.stringify(t.name)}, ${JSON.stringify(t.call)});\n\`\`\`\n\n`;
    md += `Response:\n\n\`\`\`json\n${j(t.result)}\n\`\`\`\n\n`;
    if (t.resultNote) md += `${t.resultNote}\n\n`;
  }
  writeFileSync(new URL(`${gid}.md`, out), md);
});
console.log(`gen-tools: wrote ${order.length} pages, ${TOOLS.length} tools`);
