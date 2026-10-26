---
title: "Security model"
description: "How Koinonia treats stream keys, agent authority and sensitive actions: keys never logged, human confirmation for bans and going live, loopback-only daemon."
sidebar:
  order: 20
---

Koinonia gives software the ability to go live on your channels and moderate your chat. The model is built around one rule: **an agent can propose anything; a human approves anything irreversible.**

:::caution[Design commitments, not audited guarantees]
The studio and daemon are not complete. Items below are requirements the implementation must meet and that review should check; they are not claims about shipped behavior.
:::

## Stream keys

- Provided to the daemon through the **environment** or a config file kept outside the repository, never in the protocol.
- **Never logged.** The daemon redacts keys in every log and format path, per its protocol document.
- **Never sent to the browser.** The studio names destinations ("twitch", "youtube") in the `start` frame; it never carries a key.
- **Never exposed to agents.** No WebMCP tool returns, accepts or echoes a stream key.

## Human confirmation

The design: sensitive tools return a pending state (for example `awaiting_confirmation`) and do nothing until a human accepts in the studio UI. **This gate is not implemented yet**; today `start_stream` and `stop_stream` act directly.

| Action | Confirmation |
| --- | --- |
| `ban_user` | Always. Not configurable. |
| `start_stream`, `stop_stream` | On by default (proposed); configurable. |
| Everything else | None. These are reversible production actions. |

A confirmation is bound to its `confirm_id` and to the exact arguments, expires, and is single use. An agent cannot confirm its own request; confirmation arrives from a trusted user gesture in the page, not from a tool.

## Daemon exposure

The v1 protocol document (`daemon/PROTOCOL.md`) specifies, and the daemon code is written to implement:

- Listening on **loopback** only.
- An `Origin` check (localhost hosts only) and an optional shared secret in the URL (`KOINONIA_TOKEN`).
- One ingest session at a time.
- Stream keys only in the daemon environment or config, redacted (`****`) in every log and format path, never present in status frames.

These are documented behaviors that have not been independently reviewed or tested against live platforms.

## Agent authority

- Agents act only through the registered tools; there is no generic "evaluate" tool.
- Tool inputs are validated against the schema at the boundary. Overlay text is plain text, never HTML.
- Chat content is untrusted input. Tools return it as data, and the guide recommends agents treat it as such to resist prompt injection from chatters.
- Capture frames and chat are the only places viewer-controlled content enters the model context.

## Reporting a vulnerability

Please do not open a public issue. See `SECURITY.md` in the repository.
