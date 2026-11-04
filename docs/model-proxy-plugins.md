# Model proxy plugins

Proposed direction, 2026-11-04.

Buzz keeps Claude and Codex pointed at a host-owned loopback endpoint for the lifetime of each harness. With no participating plugin, it forwards to the harness's original upstream. Plugins contribute request transformations through the Agents service. Contributions are looked up for each request, so enabling, disabling or replacing a trimming plugin does not restart the harness. The host streams upstream responses without buffering or interpreting them.

The first consumer is an external context-proxy plugin with trimming enabled and hints, stubbing, model overrides, payload dumps and priority overrides disabled. Trimming policy belongs to that plugin, not Buzz. Trimming preserves retained instructions, tool-call dependencies and protocol ordering.

The native listener admits requests only through a private random path, rejects browser Origin headers and unexpected Host headers, and preserves upstream authentication without exposing credentials to transformation callbacks. A callback receives the request path and body, and may replace the body. Plugins declare access to the harnesses whose model requests they inspect. A callback failure fails that request instead of silently bypassing its policy. An already admitted callback can finish after its contribution unloads; the host owns the subsequent stream independently of plugin lifetime. Requests are never replayed by Buzz.

Claude retains its existing upstream from ANTHROPIC_BASE_URL, falling back to Anthropic. Codex preserves the selected provider and sign-in mode, overriding only that provider's model endpoint. API and ChatGPT routes require separate forwarding bases. Compaction suppression is a separate harness concern and is not established merely by successfully forwarding a request.

Acceptance requires direct passthrough, request transformation, plugin disposal/replacement during an active request, authentication/header preservation, streamed responses, cancellation and failure. Fixture servers can exercise harness configuration without live provider credentials. Live model acceptance and repeated truncation are separate requirements.
