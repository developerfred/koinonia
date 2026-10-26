---
title: "WebMCP in Koinonia"
description: "How Koinonia uses navigator.modelContext to expose studio controls as tools an agent can call, and the conventions every tool follows."
---

WebMCP lets a web page register tools that an in-browser agent can call. In Koinonia the **studio page is the MCP server**. There is no extra backend between the agent and the studio state.

:::note
WebMCP is an emerging web API. Its surface is still moving, so Koinonia feature-detects it and keeps the tool definitions in a registry that is independent of how they are exposed.
:::

## Registration

```js
if ('modelContext' in navigator) {
  navigator.modelContext.registerTool({
    name: 'switch_scene',
    description: 'Switch the active scene.',
    inputSchema: { type: 'object', required: ['scene'], properties: { scene: { type: 'string' } } },
    async execute({ scene }) {
      studio.switchScene(scene);
      return { content: [{ type: 'text', text: JSON.stringify({ scene }) }] };
    },
  });
}
```

The same registration pattern is used by this documentation site: see [docs-site tools](../../reference/docs-site-tools/).

## Conventions every tool follows

1. **One Promise per call.** No streaming responses. Long-running things return a handle or cursor.
2. **Deltas, not snapshots.** Feeds take a cursor and return only what is new.
3. **Compact by default.** Short keys where it is safe, `fields` and `verbosity` to widen.
4. **Small schemas.** Few parameters, defaults for everything that has one.
5. **Sensitive means confirmed.** Moderation and going live are designed to return a pending state until a human clicks in the studio (the gate is not implemented yet).
6. **Relevance-gated registration.** Register a tool only when it is useful (for example clipper tools only when the buffer is on), which shrinks the tool list the model must read.

## Tool groups

See the [tool reference](../../reference/tools/): [co-pilot](../../reference/tools/copilot/), [clipper](../../reference/tools/clipper/), [data panel](../../reference/tools/data/), [token economy](../../reference/tools/tokens/).
