# Architecture

```
 studio page (WebMCP tools)  <--WebMcpClient-->  Orchestrator
        ^   get_chat / query_window                |  EventBus  (chat.batch, chat.spike, health.alert,
        |                                          |             human.request, approval.requested, economy.*)
   ChatSensor / HealthSensor (no LLM) -------------+
                                                   +-- AgentRuntime x N  (allowlist, limits, loop guard, queue)
                                                   |        |  LlmProvider (Anthropic | Fake | Echo)
                                                   |        +--> TokenEconomist (route, budget, compact)
                                                   +-- ApprovalGate (+ AuditLog)   <-- human: approve / deny
```

## Modules (`src/`)

| file | role |
|------|------|
| `types.ts` | tool/LLM message types, `MODEL_IDS`, `Clock` |
| `eventbus.ts` | pub/sub, exact + `prefix.*` + `*` topics; handler errors isolated |
| `webmcp.ts` | `WebMcpClient` (list/call). `NavigatorModelContextClient` (in page), `BridgeClient` + `webSocketTransport` (Node), `MockWebMcp` / `studioLikeMock` (tests) |
| `agent.ts` | `AgentDefinition`, `Trigger`, limits, shared `SAFETY_PREAMBLE` |
| `runner.ts` | `AgentRuntime`: lifecycle state, serial queue, the tool-use loop, enforcement order for each tool call |
| `definitions.ts` | producer, moderator, clipper, analyst, token economist |
| `sensors.ts` | `ChatSensor` (cursor delta, EWMA baseline, spike detection), `HealthSensor` |
| `orchestrator.ts` | registry, start/stop/pause/resume, trigger wiring, `ask`, `trigger`, `AgentController` for throttling |
| `approval.ts`, `audit.ts` | approval gate with timeout/flood cap; redacting audit log |
| `economist.ts` | `TokenEconomist` over `../tokens` (`ModelRouter`, `BudgetTracker`, `UsageLedger`, `trimOutput`, `compactChat`) |
| `safety.ts` | sanitise/fence untrusted text, injection heuristics, secret redaction, `RateLimiter`, `LoopGuard` |
| `providers/` | `AnthropicProvider` (fetch, tool use, `cache_control` on system + last tool, retries), `FakeProvider`, `EchoProvider` (dry-run) |
| `cli.ts` | `list`, `dry-run`, `run` |

## Life of an event

1. A sensor (free) turns page state into a bus event, e.g. `chat.spike {rate, baseline, sample}`.
2. Trigger checks: agent running? `filter` (cheap pre-filter)? trigger `cooldownMs`? Then `AgentRuntime.handle` queues it (bounded; serial per agent).
3. Gate: state, throttle level, min gap (x2 per throttle level), runs/min token bucket.
4. `economist.checkpoint` picks the model (agent tier, lowered when the global or agent budget is in `degrade`) and refuses when the projected spend would hit a budget.
5. Provider call. Usage is booked in the ledger (including cache reads and routing savings).
6. For each `tool_use`, in order: allowlist -> tool exists on the page -> loop guard -> tool rate limit -> **sensitive? -> ApprovalGate (not executed)** -> `client.callTool` -> compact (`trimOutput`, blob stripping, truncation) -> fence if the tool echoes viewers (`get_chat`).
7. Loop until the model stops calling tools or `maxSteps`.

## Approval gate

`request()` returns a pending record and the model receives `pending_approval ... NOT executed`. `approve(id)` runs the originally requested args through the executor (the page); `deny` and timeout (`approvalTimeoutMs`, default 120 s, swept every second by the orchestrator) never execute. Identical pending requests from the same agent are de-duplicated; the queue is capped (20). The `approve/deny` API is not reachable from any agent tool, and an injected message cannot create approvals because approvals are not conversational.

## Token economy

* Consume: sensors poll by cursor and fold duplicates (page-side `dedupe`); events are batched by poll period; tool results go through `trimOutput`, blob stripping (`capture_frame`) and a per-result token cap; moderator pre-filter and clipper spike gating mean quiet streams cost 0 tokens.
* Spend: tier routing per agent, step-down on budget pressure, smaller `max_tokens` while degraded, stable prefix (system + tools) marked for prompt caching, per-agent and global hourly budgets, `economist` native agent throttles lowest-priority agents first (levels 0-3).
* Report: `orch.economist.report()` is the tokens-library `LedgerReport` (by tool=agent, task=event topic, model, savings by source).

## Assumed contracts / gaps

* **Bridge protocol** (`webSocketTransport`): JSON messages `{id, method: "tools/list"|"tools/call", params}` -> `{id, result|error}`. Nobody implements the server side yet (studio/daemon); only the in-page `navigator.modelContext` path matches existing code (`studio/src/tools/webmcp.ts` polyfill exposes `listTools`).
* **Missing page tools**: the studio currently has no `ban_user`, `timeout_user`, `delete_message`. The moderator is a no-op until they exist (`status()[].missingTools` lists them). Sensitive tool names are configurable (`sensitiveTools`).
* `get_chat` shape (`{c, m:[{i,u,t,x}]}`) is parsed per `studio/src/chat/ring.ts`; `query_window` per `studio/src/tools/tools.ts`.
* Injection heuristics are telemetry only; the guarantee comes from allowlists + approval gate. A model could still be talked into low-risk allowed actions (e.g. a poll) if a human prompt were forged; chat never reaches the producer by default.
* No persistence: audit log and approvals are in memory (use `AuditLog` `sink`). Budgets reset on restart.
* Price table is the tokens library placeholder; verify before trusting dollar figures.
* No response cache / rolling summary wiring yet (library has `ResponseCache`, `RollingSummary`); agents run single-shot per event with no conversation memory, which keeps cost flat.
* `run` CLI approves via stdin only; no UI integration (subscribe to `approval.requested`).
* The CLI is bundled on demand with esbuild (Node cannot strip the TS parameter properties or `.js` specifiers used in `../tokens`).
