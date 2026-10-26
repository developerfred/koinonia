---
title: "WebMCP tools on this site"
description: "This documentation site registers its own WebMCP tools (search_docs, get_page, list_pages) so an in-browser agent can read the docs directly."
---

If your browser exposes `navigator.modelContext`, every page of this site registers three read-only tools. Registration is feature-detected, so nothing happens in browsers without WebMCP.

| Tool | Input | Returns |
| --- | --- | --- |
| `search_docs` | `{ query: string, limit?: integer }` | Ranked list of `{ path, title, description, snippet }`. |
| `get_page` | `{ path: string }` | The page as Markdown. `path` is as returned by `search_docs`, for example `/docs/security/`. |
| `list_pages` | `{}` | Every page with title and description. |

All three read from `/koinonia/search-index.json`, a static file built with the site. They never send anything off the page.

## Not using WebMCP?

Use the plain-text routes instead:

- [`/llms.txt`](/koinonia/llms.txt): index of pages with descriptions.
- [`/llms-full.txt`](/koinonia/llms-full.txt): the whole documentation in one file.
- Append `.md` to any docs URL, for example `/koinonia/docs/security.md`.
