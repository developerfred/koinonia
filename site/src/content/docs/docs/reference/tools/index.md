---
title: "WebMCP tools"
description: "Overview, conventions and index of every WebMCP tool the Koinonia studio will expose, with status for each."
sidebar:
  order: 1
---

The studio page will register these tools through `navigator.modelContext`. Names come from the project plan; input schemas are the proposed contract.

:::caution[Status]
14 of these tools are registered in `studio/src/tools/tools.ts` today, and their schemas below mirror that code. **Built** means registered and tested in the tool layer; **In progress** means registered but dependent on platform connectors or the daemon, which are unfinished. The human-confirmation gate for sensitive tools is **not implemented**.
:::

## How the examples read

Examples are written as `tools.call(name, args)`. That is shorthand for whatever your MCP client does: the call goes in as JSON arguments matching the input schema, and the result is delivered as a text content block containing the JSON shown.

## Conventions

- **Cursors**: feeds accept `since_cursor` and return the next cursor `c`. See [cursors and deltas](../../concepts/cursors-and-deltas/).
- **`fields` / `verbosity`**: ask for less. Defaults are minimal.
- **Errors** are a text block containing `{ "error": "message" }` with `isError: true`.
- **Sensitive tools** are designed to return a pending state and do nothing until a human confirms. Not implemented yet; see [Security](../../security/).

## Index

| Tool | Group | Status | Sensitive |
| --- | --- | --- | --- |
| `get_chat` | [Co-pilot](./copilot/) | Built | no |
| `create_poll` | [Co-pilot](./copilot/) | In progress | no |
| `pin_message` | [Co-pilot](./copilot/) | In progress | no |
| `switch_scene` | [Co-pilot](./copilot/) | Built | no |
| `set_layer` | [Co-pilot](./copilot/) | Built | no |
| `set_audio` | [Co-pilot](./copilot/) | Built | no |
| `set_overlay_text` | [Co-pilot](./copilot/) | Built | no |
| `start_stream` | [Co-pilot](./copilot/) | In progress | planned gate |
| `stop_stream` | [Co-pilot](./copilot/) | In progress | planned gate |
| `capture_frame` | [Co-pilot](./copilot/) | In progress | no |
| `ban_user` | [Co-pilot](./copilot/) | Planned | always (planned) |
| `mark_highlight` | [Clipper](./clipper/) | Built | no |
| `export_clip` | [Clipper](./clipper/) | In progress | no |
| `query_window` | [Data](./data/) | Built | no |
| `set_alert` | [Data](./data/) | Built | no |
| `get_token_report` | [Token economy](./tokens/) | Planned | no |

`ban_user` and `get_token_report` are proposed and not in the code. Alerts are read through `query_window`, which includes any alert that fired since the last call.

The whole contract is also included in [`/llms-full.txt`](/koinonia/llms-full.txt).
