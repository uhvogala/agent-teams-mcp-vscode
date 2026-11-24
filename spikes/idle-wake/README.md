# Idle wake spike

The test is two separate Copilot SDK sessions. A posts a synthetic message through MCP. The probe records it before starting a new turn in idle B. B must read and acknowledge the exact ID through MCP; a response in chat alone does not count. The wake prompt carries only the ID and uses agent provenance, not human authority.

## Run

Use Node.js 20.19.x or 22.12+ and a supported Copilot SDK sign-in. See the [SDK authentication guide](https://github.com/github/copilot-sdk/blob/main/docs/auth/authenticate.md). The editor's signed-in session does not automatically sign in this separate SDK client.

```sh
npm ci
npm test
npm run probe          # 10 live trials
npm run probe -- 1     # one live trial
```

Set `AGENT_TEAMS_PROBE_MODEL` to pin the Copilot model instead of using `auto`. The live probe consumes Copilot usage. It creates a private temporary workspace and runtime directory, registers only the role-specific probe tools, disables ambient config discovery, and starts an authenticated loopback MCP endpoint for the duration of the run. The trace records `stored`, `dispatch`, the runtime's delivery classification, `turn_started`, `read`, and `acknowledged`. The trial fails if the runtime does not classify the new turn as `idle`, the turn does not start within 15 seconds, or B does not acknowledge the specific ID within 60 seconds. Keep the printed trace for comparison, then remove the temporary probe directory when no longer needed.

`npm test` uses real MCP transport and the real Copilot runtime with a local scripted model; no Copilot sign-in or model credits are needed. It checks access control, store-before-dispatch ordering, duplicate suppression, and ten end-to-end wake/read/acknowledge trials. This verifies runtime and tool plumbing, not how reliably a live model will choose to read and acknowledge. The mailbox index is in memory; the trace is not a restart/recovery implementation. Stop, busy queueing, disconnect, cold resume, and desktop extension integration are separate cases, not covered by this idle-only spike.

## Results and candidate routes

On November 21, 2026, the current VS Code Agent Host's session-layer `send_message` tool returned `started` on **10/10** queue sends to one idle disposable nested Copilot chat. Each new turn finished with the matching `ACK host-01` through `ACK host-10`, with no intervening human prompt to the receiver. This is host-level wake evidence, not proof of the latency target, cross-session MCP delivery, or a public extension API. The isolated SDK started but reported no signed-in Copilot account here.

| Route | What it can do | Standing |
|---|---|---|
| Current Agent Host `send_message` | Starts a new turn when idle; exposes queue and steer separately. | Confirmed above. Host tool availability is not an extension API contract. |
| [Copilot SDK session send](https://github.com/github/copilot-sdk/blob/main/nodejs/README.md) | Enqueues a turn for an app-owned worker, with agent provenance, a caller-supplied turn ID, and runtime events for delivery and activity. | Primary shipping candidate. The scripted-model test exercises this route; live authenticated MCP probe still required. |
| SDK `session.rpc.management.message` | Experimental opt-in peer delivery in SDK 2.0.1. Its contract explicitly says it wakes idle live peers, queues for busy peers, and does not imply completion. | Test separately on two opt-in sessions scoped to the same runtime; no evidence here of support in the desktop host. |
| [Agent Host Protocol](https://microsoft.github.io/agent-host-protocol/specification/chat-channel.html) | A client can start a turn or use host-managed queued input. The spec says the host should consume queued input immediately when the chat is idle. | Test on an authorized, explicitly configured standalone host. SDK `startAhpHost()` and `publishSession()` are possible ways to expose app-owned workers, not to take over the built-in desktop host. |
| [AHP automations](https://microsoft.github.io/agent-host-protocol/specification/automation-channel.html) | Event or scheduled triggers can launch a fresh session. | Not a wake for the existing role session. |
| [Copilot hooks](https://code.visualstudio.com/docs/agent-customization/hooks) and heartbeats | Report lifecycle or listener activity while an existing workflow runs. | Useful for observations, not an external source of new turns. |
| MCP waits, task/resource notifications, sampling | Bounded waits can unblock an active tool call. Task/resource notifications don't establish that an idle model starts a turn; [Copilot sampling](https://code.visualstudio.com/api/extension-guides/ai/mcp#_mcp-support-in-copilot) is limited to an active turn. | Keep wait/inbox as fallback, not the idle wake mechanism. |
| [DevOps tracked-terminal and runtime companion](../../../azure-devops-mcp-vscode/README.md#background-pipeline-completion) | Tracked terminal completion woke an idle chat in the tested macOS setup; the experimental client-task companion was not discovered in that host. | Useful prior art, not a production dependency or proof for the new integration. |

Do not use private workbench commands or credentials from VS Code's built-in host as a shipping dependency. A model reply is only best-effort: in production, keep addressed messages in the inbox until the recipient acknowledges them, and report a timeout separately from a successful wake.
