# Internet Access for Ollama Local Workspace — Design Document

Status: **Proposed, not yet implemented**
Scope: URL fetch only, explicit per-conversation opt-in

## 1. Background and goals

Every capability in Ollama Local Workspace has been strictly local so far: local models via Ollama, local file/workspace attachments, local SQLite storage. This document proposes the first capability that sends anything outside the user's machine — letting a model read the content of a specific web page or PDF when the user has explicitly allowed it for that conversation.

Deliberately out of scope: **web search**. This is not a "let the model search the internet" feature. The model can only fetch a URL it already has (one the user pasted, or one already present in prior context) — it cannot discover new URLs on its own. This avoids needing a third-party search API/key and keeps the feature's surface area to exactly what was asked for.

Design goals, in priority order:
1. **Off by default, everywhere.** No existing or new conversation reaches the internet unless the user explicitly turns it on for that conversation.
2. **No surprise network access.** The user can always see whether a conversation has internet access enabled, and every fetch shows up in the existing "Activity — this turn" panel exactly like file-tool calls do.
3. **Don't let the model touch the user's local network.** The controller process itself has full access to the user's LAN; a fetch tool without safeguards would let a manipulated prompt turn the controller into an SSRF (server-side request forgery) proxy against the user's own machine and network.
4. **Reuse existing patterns rather than inventing new ones.** This should look, to the model and to the code, like a fourth tool alongside `list_directory` / `read_file` / `search_files`, not a parallel subsystem.

## 2. User-facing behavior

- When starting a new conversation, the left rail gains a small toggle (near the Workspaces "Add" controls), off by default: **"Allow internet access for this conversation."**
- This choice is fixed at conversation creation time, the same way the attached workspace set is fixed at creation — it does not change mid-conversation. Starting a new conversation is the natural point to reconsider it.
- When enabled, the telemetry strip shows an explicit indicator (e.g. "Internet: on"), and the composer hint text notes that the model may fetch content from the internet — so the capability is never silently active without a visible cue.
- When the model fetches a page, it appears in the "Activity — this turn" panel just like a file read does, counted against the same per-turn tool-call budget (8 calls/turn) already in place.
- If the model tries to fetch a local/private address, the call is rejected with a clear error returned to the model (not a silent failure), and a diagnostics warning is logged — mirroring how workspace path-escape attempts are already handled.

## 3. What "fetch a URL" actually does

A new tool, `fetch_url(url)`, available to the model only when the current conversation has internet access enabled and the selected model supports tool calling.

Request handling:
- Only `http:`/`https:` URLs are accepted.
- 10-second timeout (longer than the 2–5s used for local file tools, since network latency is inherently higher and outside the app's control).
- Raw response capped at ~5MB before any parsing is attempted.

Content-type dispatch:
- **`text/html`** → parsed with `jsdom` + `@mozilla/readability`, which extracts the actual article/main content and strips navigation, ads, and boilerplate. This gives the model meaningfully more useful text than a raw HTML-to-text dump would.
- **`application/pdf`** → reuses the PDF-extraction logic already built for attachment ingestion (`apps/controller/src/services/attachments.ts`, via `pdf-parse`), so a URL that points at a report or paper works the same way an uploaded PDF already does.
- **anything else** (images, video, binaries, etc.) → a clear "unsupported content type" result is returned rather than attempting to parse it, matching the binary-file guard already present in `read_file`.

Output shaping:
- Extracted text is capped (~1MB before truncation, then the existing 8KB per-tool-result truncation applies on top, same as file-tool results), with a truncation marker so the model knows content was cut.
- The result is returned in exactly the same shape as existing tool results, so the turn loop, the Activity panel, and message persistence need no changes to handle it.

## 4. Preventing SSRF (the one new security concern)

Because the controller process — not the browser — makes the outbound request, and the controller runs with the user's full local network access, an unguarded fetch tool would let a cleverly crafted prompt make the *controller* issue requests to:
- `http://127.0.0.1:<port>` or `localhost` — other services running on the user's machine
- `http://192.168.x.x`, `10.x.x.x`, `172.16-31.x.x` — devices on the user's LAN (routers, NAS boxes, IoT devices, etc.)
- `169.254.x.x` — link-local addresses, sometimes used for cloud-metadata-style endpoints

This is the same class of risk that path traversal was for file tools, and gets the same treatment: validated on **every call**, not just once at setup.

Mitigation:
1. Reject non-`http`/`https` schemes outright.
2. Resolve the hostname via DNS (`dns.promises.lookup`) and check the **resolved IP address** — not the literal hostname string — against the known private/loopback/link-local ranges (127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, `::1`, fc00::/7). Checking the resolved address (rather than just string-matching "localhost") closes the obvious DNS-rebinding bypass, where an attacker-controlled domain resolves to a private address.
3. On rejection, return a clear tool-error result to the model (so it doesn't silently retry or hang) and log a diagnostics warning, consistent with existing workspace-violation logging.

## 5. Data model changes

- `Conversation` gains `internetEnabled: boolean`, set once at creation and never mutated afterward (parallel to how the workspace set is fixed at creation).
- SQLite migration: `ALTER TABLE conversations ADD COLUMN internet_enabled INTEGER NOT NULL DEFAULT 0`. This is a purely additive column with a default — SQLite supports this directly with no table rebuild (unlike a constraint change on an existing column). Existing conversations transparently get `internet_enabled = 0`, i.e. no behavior change for anything created before this feature ships.
- `ClientCommand`'s `new_conversation` payload gains an optional `internetEnabled` field, carrying the user's toggle choice from the client into `createConversation`.
- `ToolCallRecord["name"]` gains `"fetch_url"` alongside the existing `"list_directory" | "read_file" | "search_files"`.

## 6. Where this plugs into the existing turn loop

Today, `wsHandler.ts` decides whether tools are enabled for a turn based on whether a workspace is attached (`toolsEnabled = namedRoots.length > 0 && modelSupportsTools`), and always sends the same fixed set of workspace tools when so. This changes to a union:

- Workspace tools (`list_directory`, `read_file`, `search_files`) are included when a workspace is attached, as today.
- `fetch_url` is included when the conversation's `internetEnabled` flag is set.
- Either, both, or neither can be true for a given conversation — no change to how the model is invoked when neither applies.
- A new system message is added (parallel to the existing workspace/attachment system messages) explaining the `fetch_url` tool's exact contract: it can only fetch a specific URL already known to it, and it is not a search capability — this phrasing is deliberate, to discourage a model from inventing a plausible-looking URL when it doesn't actually have one.

## 7. Files expected to change

| Area | File | Change |
|---|---|---|
| Shared types | `packages/shared/src/types.ts` | `internetEnabled` on `Conversation` and `new_conversation`; `"fetch_url"` added to `ToolCallRecord["name"]` |
| New service | `apps/controller/src/services/webFetch.ts` | SSRF-safe URL validation, HTTP GET with timeout/size cap, HTML/PDF extraction dispatch |
| Dependencies | `apps/controller/package.json` | add `jsdom`, `@mozilla/readability` |
| Tool loop | `apps/controller/src/services/toolLoop.ts` | new `FETCH_URL_TOOL_DEFINITION`, dispatch to `webFetch` |
| Turn orchestration | `apps/controller/src/wsHandler.ts` | conditional tool union, new system message, pass `internetEnabled` through to `createConversation` |
| Persistence | `apps/controller/src/services/conversationStore.ts` | additive column migration, read/write `internetEnabled` |
| Client UI | `apps/web/src/App.tsx` | staged toggle before conversation creation, telemetry indicator, composer hint text |

## 8. Verification plan

- Internet access **off**: ask a question requiring current web info; confirm the model has no fetch tool available and answers only from its own knowledge (or says it can't check).
- Internet access **on**: give the model a real public URL; confirm `fetch_url` appears in the Activity panel and the reply reflects that page's actual content.
- Attempt to get the model to fetch `http://127.0.0.1:4173` or a `192.168.x.x` address; confirm the SSRF guard rejects it with a clear tool error and a logged diagnostics warning, and that no such request is actually issued.
- Fetch a PDF URL; confirm real text comes back via the reused PDF pipeline. Fetch a non-HTML/PDF URL (e.g. an image); confirm a clear "unsupported" result rather than garbage.
- Confirm a conversation created before this change (`internet_enabled` defaulting to 0 via the migration) behaves exactly as before, with no regression to workspace-only or plain conversations.

## 9. Open questions for a future iteration (not blocking this design)

- Should there be a per-conversation allowlist/denylist of domains, for users who want more granular control than a single on/off toggle?
- Should fetched-page content be cached (keyed by URL) within a conversation to avoid re-fetching the same page across multiple turns?
- If demand emerges for actual web search later, that would be a separate, larger decision (choice of search provider, whether an API key is required, whether query text should ever leave the machine) — deliberately not addressed here.
