# Ollama Local Workspace — Project Spec

A local, browser-based UI for chatting with your local Ollama models (`qfast`, `qthink`, `rson`) with workspace- and attachment-aware context — a sister app to `Codex_CLI_UI`, living at:

```
/Users/suvojitdutta/Documents/Rest/apps/apps/Codex-CLI-UI/Ollama_Local_UI
```

This spec is written in the same style as `Codex_CLI_UI`'s own `codex-local-ui-wrapper-project-spec.md` so it's a natural sibling document, but the two apps solve different problems — see "Why This Is Not a Port" below before reading further.

---

## 1. Why This Is Not a Port

`Codex_CLI_UI` is a thin browser client over `codex app-server` — a separate OpenAI-built binary that does all the hard agentic work: sandboxed command execution, file-write permission gating, structured multi-choice questions, turn/thread state, model orchestration. The controller (`server.ts`) mostly authenticates and proxies; the real complexity (`codexProcess.ts`, 1157 lines) is spawning that binary and speaking its JSON-RPC-over-stdio protocol.

Ollama has no equivalent server. It is a plain chat-completion API (`/api/chat`, OpenAI-compatible `/v1/chat/completions`). It has:
- No sandboxed file-write or command-execution runtime
- No approval/permission system
- No server-side thread/conversation storage — every call is stateless; the caller resends full message history
- No native concept of "workspace"

So this app is not a Codex UI with the child process swapped out. It's a new, much simpler app that borrows **patterns** (not code) from Codex UI where they genuinely transfer: the security posture, the workspace path-validation approach, the WebSocket event-sourcing shape, the prompt-template concept, the general UI shell. Everything that was Codex-app-server's job (approvals, sandboxed writes, diffing) is explicitly **out of scope** here, per your decision to keep these models out of autonomous file-editing/coding-agent territory.

## 2. Goals

- A local web app (bind to `127.0.0.1` only) that gives you a proper chat UI for `qfast`, `qthink`, and `rson` (or any other model you later pull into Ollama) — no more remembering shell aliases.
- **Workspaces**: attach one or more local folders to a conversation so the model has read access to their contents as context.
- **Attachments**: attach individual files to a conversation or a single message, independent of any workspace — a PDF from Downloads, a one-off doc, a screenshot for a vision-capable model.
- Conversation history persists across restarts, per workspace, like Codex UI's saved threads.
- PWA-installable in Chrome, matching Codex UI's install flow, so it lives in your Dock like a real app.

## 3. Non-Goals (v1)

- **No autonomous file editing.** The model can read what you give it access to; it never writes, renames, or deletes anything in your workspace.
- **No command/shell execution by the model.**
- **No approval-flow UI.** There's nothing to approve because there's nothing destructive happening.
- **Not a multi-agent orchestrator.** Your FlowMesh/claims-agent-stack work (custom Python agents, LangGraph evaluation) is a separate system. This app is a daily-driver chat/evaluation tool, not where that orchestration logic lives — though nothing stops you from pointing FlowMesh's agents at the same Ollama server this app also uses.

## 4. Tech Stack & Repo Layout

Same stack as `Codex_CLI_UI`: Node 20+, TypeScript, npm workspaces, Express + `ws` controller, React 19 + Vite web app, static build served by the controller, cookie-session auth, PWA-installable.

```
Ollama_Local_UI/
├── package.json                  (npm workspaces: apps/*, packages/*)
├── apps/
│   ├── controller/               local HTTP/WS server + Ollama client + persistence
│   │   └── src/
│   │       ├── main.ts
│   │       ├── server.ts             Express app, WS upgrade, session auth, CSP
│   │       └── services/
│   │           ├── ollamaClient.ts   talks to localhost:11434, streaming chat, tool loop
│   │           ├── workspace.ts      path validation/sandboxing (same approach as Codex UI)
│   │           ├── attachments.ts    file ingestion: text extraction, size/type limits
│   │           ├── conversationStore.ts   SQLite-backed persistence (see §8)
│   │           └── modelRegistry.ts  discovers installed models via GET /api/tags
│   └── web/                      React SPA
│       └── src/
│           ├── App.tsx
│           ├── main.tsx
│           └── styles.css
└── packages/
    ├── shared/                   browser-facing types + prompt templates (ported concept, new content)
    └── ui/                       shared UI bits (StatusPill, etc.)
```

Notably **absent** compared to Codex UI: `protocol-adapter` and `protocol-generated`. Those exist only to translate `codex app-server`'s experimental JSON-RPC protocol — there's no equivalent protocol to adapt here, since Ollama's HTTP API is the whole interface.

## 5. Core Domain Model (`packages/shared/src/types.ts`)

```ts
export type PermissionMode = "read-only"; // only mode that exists in v1 — no write mode to select

export type OllamaConnectionState = "starting" | "ready" | "unavailable" | "model-missing";

export type TurnStatus = "idle" | "running" | "interrupted" | "failed" | "completed";

export interface WorkspaceInfo {
  path: string;
  displayName: string;
  isGitRepository: boolean;
  fileCount: number;         // populated at validation time, capped (see §7)
  truncated: boolean;        // true if fileCount hit the cap
}

export interface WorkspaceSet {
  primary: WorkspaceInfo;
  linked: WorkspaceInfo[];   // up to 9, matching Codex UI's cap
}

export interface AttachmentInfo {
  id: string;
  fileName: string;
  sourcePath: string;        // original path on disk, for display/reveal-in-finder only
  mimeType: string;
  sizeBytes: number;
  kind: "text" | "image" | "unsupported";
  extractedText?: string;    // for text/pdf/docx — populated at attach time
  scope: "conversation" | "message"; // attached to whole conversation, or one message
}

export interface ModelOption {
  name: string;              // Ollama tag, e.g. "qwen3:30b-a3b-instruct-2507-q4_K_M"
  alias: string | null;      // "qfast" / "qthink" / "rson" if it matches a known alias
  supportsTools: boolean;    // whether we've verified/assume tool-calling works for this model
  sizeBytes: number;
  family: string;            // "qwen3", "deepseek-r1", etc., from `ollama show`
}

export type MessageRole = "user" | "assistant" | "system" | "tool";

export interface ConversationMessage {
  id: string;
  role: MessageRole;
  text: string;
  toolCalls?: ToolCallRecord[]; // populated on assistant messages that read files
  createdAt: number;
  streaming?: boolean;
}

export interface ToolCallRecord {
  id: string;
  name: "list_directory" | "read_file" | "search_files";
  args: Record<string, unknown>;
  result: string;             // truncated preview stored; full result not re-sent on reload
  workspacePath: string;      // which workspace root this touched
}

export interface Conversation {
  id: string;
  title: string;
  model: string;               // Ollama tag in use
  workspaceSet: WorkspaceSet | null;
  attachments: AttachmentInfo[]; // conversation-scoped attachments
  messages: ConversationMessage[];
  turnStatus: TurnStatus;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
}

export interface PromptTemplate {
  id: string;
  name: string;
  description: string;
  body: string;                 // {{variable}} interpolation, same as Codex UI
  variables: string[];
  builtIn: boolean;
}

// WebSocket event/command shapes, same discriminated-union approach as Codex UI:
export type ControllerEvent =
  | { type: "connection"; state: OllamaConnectionState; detail?: string }
  | { type: "conversation_created"; conversation: Conversation }
  | { type: "conversation_loaded"; conversation: Conversation }
  | { type: "turn_state"; conversationId: string; status: TurnStatus; detail?: string }
  | { type: "message_delta"; conversationId: string; messageId: string; delta: string }
  | { type: "message"; conversationId: string; message: ConversationMessage }
  | { type: "tool_call"; conversationId: string; call: ToolCallRecord }
  | { type: "diagnostic"; level: "info" | "warning" | "error"; message: string; detail?: string };

export type ClientCommand =
  | { type: "send_message"; conversationId: string; text: string; messageAttachmentIds?: string[] }
  | { type: "interrupt_turn"; conversationId: string }
  | { type: "new_conversation"; model: string; workspaceSet: WorkspaceSet | null };
```

## 6. Model Integration (`ollamaClient.ts`)

- Talks to `http://127.0.0.1:11434` — same host your `qfast`/`qthink`/`rson` aliases already point at, discovered rather than hardcoded (`GET /api/tags` lists what's installed, so if you `ollama pull` a fourth model later, it just shows up in the picker).
- Streams via `POST /api/chat` with `"stream": true`; each chunk becomes a `message_delta` event over the app's own WebSocket to the browser.
- **Tool-calling for read-only file access** (see §7) uses Ollama's `tools` parameter. This is verified reliable for Qwen3 models (`qfast`, `qthink`); DeepSeek-R1 distills have historically shaky tool-calling. Concretely:
  - `qfast` / `qthink`: tool-calling **enabled** — the model can autonomously call `list_directory`/`read_file`/`search_files` against the active workspace mid-conversation.
  - `rson`: tool-calling **disabled** by default in the model registry (`supportsTools: false`) — workspace files are made available only via explicit attachment or a "paste workspace file list" helper, not autonomous browsing. This is a flag in `modelRegistry.ts`, not a hardcoded rule, so it's a one-line change if DeepSeek's tool-calling turns out to work fine in practice — worth testing empirically once built rather than trusting this assumption blindly.

## 7. Workspaces (Full Parity with Codex UI)

Reuses the **approach**, not the code, from `workspace.ts`:
- One primary + up to 9 linked folders per conversation (`MAX_CONVERSATION_WORKSPACES = 10`, same cap).
- Every path is canonicalized (`realpath`) and validated as an existing directory before being accepted.
- Overlap check: no linked folder may contain or be contained by another selected root.
- All reads are sandboxed to the selected roots: any tool-call path is resolved and checked against every selected workspace root (`assertContained`-style logic) before the file is read — a `read_file` call for `../../../etc/passwd` is rejected the same way Codex UI rejects an out-of-workspace write.
- **Native macOS folder picker** via the same `osascript "choose folder"` trick `workspace.ts` uses — no reason to reinvent that.

New pieces Codex UI didn't need, because it never reads file *contents* into context itself (Codex's own sandboxed process does that):
- **File enumeration with limits**: walking a workspace to build a browsable tree, skipping `.git`, `node_modules`, `dist`, `build`, and other noise directories (same skip-list as `snapshot.ts`), capped at a file count (e.g. 2,000, matching `MAX_FILES` in Codex UI's snapshot logic) and per-file size (e.g. 1MB) before a file is considered "readable" rather than "too large, use targeted read."
- **Read-only file tools exposed to the model**:
  - `list_directory(path)` — lists entries under a workspace-relative path.
  - `read_file(path)` — returns file contents (truncated with a clear marker if it exceeds the size cap).
  - `search_files(query)` — simple substring/grep-style search across the workspace, returning matching file paths + line snippets (not a full index/embedding search — that's a possible v2 enhancement if workspaces turn out to be too large for this to be useful).
  
  Because these are pure reads with the same path-containment check as Codex UI's write-approval logic, **no approval UI is needed** — the sandboxing itself is the safety boundary, same principle Codex UI uses for auto-approving verified in-workspace requests, just applied to reads only.

## 8. Attachments (New Requirement)

Separate from workspaces — files attached directly, regardless of whether they're inside any selected workspace folder:

- **Conversation-scoped attachments**: attached once, available for the whole conversation (e.g., a spec doc you want the model to keep referencing).
- **Message-scoped attachments**: attached to a single message (e.g., "here's today's log file, what changed?").
- Ingestion pipeline (`attachments.ts`):
  - **Plain text / code / markdown**: read directly, included inline (with the same size cap as workspace files).
  - **PDF**: extract text via a PDF library (e.g. `pdf-parse`) at attach time; store extracted text, not the raw binary, in context.
  - **DOCX**: extract text similarly (e.g. `mammoth`), matching the fact that Codex UI's own live-test suite already exercises Word/PDF generation with `python-docx`/LibreOffice — text extraction here is a lighter lift than that generation pipeline.
  - **Images**: only relevant if a selected model is vision-capable — Ollama supports multimodal models, but none of `qfast`/`qthink`/`rson` are vision models, so v1 stores images as attachments (visible in the UI, revealable in Finder) without sending pixel data to a model that can't use it, and shows a clear "this model can't see images" notice rather than silently dropping them.
- The file picker uses the same native `osascript` approach as the folder picker (a "choose file" dialog instead of "choose folder").

## 9. Conversation Persistence (New Subsystem — Codex UI Doesn't Need This)

Worth calling out explicitly: Codex UI barely persists anything itself (`stateStore.ts` is 206 lines of preferences/recent-workspaces/diagnostics) because `codex app-server` already owns full thread storage (`thread/list`, `thread/resume`, `thread/read`). Ollama has none of that, so **this app has to build full conversation storage from scratch** — a meaningfully bigger piece of ground we have to cover ourselves that has no Codex UI equivalent to lean on.

Recommendation: **SQLite** (via `better-sqlite3`, synchronous, zero external service) rather than a single growing JSON file — a conversation with a long tool-call-heavy history shouldn't require rewriting one giant file on every message the way Codex UI's `StateStore.save()` rewrites its whole (small) state blob.

```
~/Library/Application Support/Ollama Local Workspace/
└── conversations.sqlite
    ├── conversations   (id, title, model, workspace_set_json, created_at, updated_at, archived)
    ├── messages        (id, conversation_id, role, text, tool_calls_json, created_at)
    └── attachments     (id, conversation_id, message_id nullable, file_name, extracted_text, ...)
```

Preferences (theme, default model, data dir override) stay in a small JSON file, same pattern as Codex UI's `defaultDataDir()`/`state.json`, just for the much smaller set of fields that still fit that shape.

## 10. UI Plan (`App.tsx`)

Same general shell as Codex UI — sidebar + main conversation view + settings — with these screens/components:

- **Sidebar**: recent workspaces, conversation list (grouped by workspace), "New conversation" with model picker.
- **Workspace panel**: primary + linked folder chips, "Add workspace" (native picker or manual path), a collapsible file tree for browsing what's in scope.
- **Attachments panel**: per-conversation attachment list + a "attach to this message" control in the composer, distinct from workspace files.
- **Chat view**: streaming markdown rendering (reuse `react-markdown` + `remark-gfm`, both already proven in Codex UI), model picker in the header (switch model mid-conversation, same idea as Codex UI's `ModelPicker`), a **tool-call activity trail** showing when the model called `read_file`/`list_directory`/`search_files` and on what path — the read-only equivalent of Codex UI's `ActivityDrawer`, so you can see what the model actually looked at.
- **Templates view**: same starter-template concept as Codex UI's `templates.ts` (`{{variable}}` interpolation), seeded with prompts suited to reasoning/analysis rather than "implement a change" (e.g. "Summarize this workspace", "Compare these attached documents", "Reason through this problem step by step").
- **Settings**: theme, default model, data directory, "open data folder in Finder."
- **Diagnostics**: connection state to the Ollama server, recent errors — mirrors Codex UI's `DiagnosticsView` but against `ollamaClient` instead of `codexProcess`.

## 11. Security Model (Directly Reused)

Everything in Codex UI's `AGENTS.md` security section that isn't about approvals/command-execution applies unchanged:
- Controller binds only to `127.0.0.1`.
- HttpOnly per-launch session cookie; WS upgrade validates origin + session.
- Same CSP headers as `server.ts`.
- All file tool paths canonicalized and checked against selected workspace roots before any read.
- The browser never talks to Ollama directly — same "browser never connects directly to the backing process" principle, just with `ollamaClient` in the controller instead of `codexProcess`.

## 12. Build Phases

1. **Scaffold**: npm workspaces, Express+WS controller, React shell, health/bootstrap endpoints, PWA manifest. Verify `qfast` responds end-to-end through the browser with no workspace/attachment features yet.
2. **Model registry + streaming chat**: model picker sourced from `GET /api/tags`, streaming responses, conversation persistence (SQLite) for simple no-context chats.
3. **Workspaces**: folder picker, primary+linked validation/sandboxing, file tree browser, `list_directory`/`read_file`/`search_files` tool-calling for `qfast`/`qthink`.
4. **Attachments**: file picker, text/PDF/DOCX extraction, conversation- and message-scoped attachment UI.
5. **Templates, settings, diagnostics, PWA polish** — parity with Codex UI's feature completeness for the pieces that carried over.

## 13. Open Risks (Stated Plainly)

- **Tool-calling reliability**: Qwen3's tool-calling is well-documented; whether it holds up specifically through Ollama's implementation (vs. a direct API) should be verified early in Phase 3, not assumed.
- **DeepSeek-R1 distill + tools**: assumed unreliable based on general reputation, not a benchmark run against this exact model/quant — worth a quick empirical check before locking `supportsTools: false` for `rson` into the registry.
- **Large workspaces**: `search_files` as simple substring search will degrade on very large codebases/document sets. If your workspaces turn out to be large, this is the first thing to revisit (e.g. an embedding index) — deliberately deferred rather than over-built up front.
- **Context window vs. attachment size**: a 256K nominal context window doesn't mean every attached file "fits comfortably" at good latency — very large attachments will slow prefill even before hitting a hard limit, matching the general M5 Pro prefill caveat from earlier in our conversation.
