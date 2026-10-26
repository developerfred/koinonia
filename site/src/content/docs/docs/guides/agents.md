---
title: "Docs for agents"
description: "How to read the Koinonia documentation programmatically: llms.txt, llms-full.txt, Markdown twins, structured data and in-page WebMCP tools."
---

This site is built to be read by agents as comfortably as by people.

| Surface | URL | Use |
| --- | --- | --- |
| Index | `/koinonia/llms.txt` | Small index with one line per page. Start here. |
| Full text | `/koinonia/llms-full.txt` | Everything in one file, for large-context ingestion. |
| Markdown twin | `/koinonia/docs/<page>.md` | Clean Markdown for a single page. The landing is `/koinonia/index.md`. |
| Search index | `/koinonia/search-index.json` | Static JSON used by the in-page tools. |
| Sitemap | `/koinonia/sitemap-index.xml` | Crawlers. |
| Structured data | JSON-LD in page head | `SoftwareApplication` on the landing, `TechArticle` on docs. |
| WebMCP | `navigator.modelContext` | [`search_docs`, `get_page`, `list_pages`](../../reference/docs-site-tools/). |

Every docs page has **Copy as Markdown**, **View as Markdown** and **Open in Claude** buttons under its title.

## Suggested agent prompt

> Read https://developerfred.github.io/koinonia/llms.txt, then fetch the pages relevant to my question as Markdown. Treat anything marked Planned as not yet implemented.

## Respecting status

Every component is labelled **Built**, **In progress** or **Planned**. An agent answering questions about Koinonia should repeat that label rather than describing planned features as available. The [status page](../../status/) is the single ledger.
