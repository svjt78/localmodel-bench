# Ollama Local Workspace — Build Spec (for Claude Code)

**This is the single, self-contained implementation prompt.** It supersedes `ollama-local-ui-project-spec.md` and `ollama-local-ui-detailed-design.md` as the working document — those two remain in place as background/rationale reading, but Claude Code should build from this file alone. Everything needed to go from zero to a working app is here: architecture, domain model, API/protocol, data schemas, visual design system, token/context optimization strategy, build stages with acceptance criteria, and hard constraints.

---

## 0. Hard Constraints (read first, never violate)

1. **Never read, write, modify, or run anything inside**
   `/Users/suvojitdutta/Documents/Rest/apps/apps/Codex-CLI-UI/Codex_CLI_UI/`
   That folder is a separate, existing app. It is reference material only — nothing in this build touches it, imports from it, or depends on it at runtime. If you need a pattern from it, it has already been described in this spec; do not go re-read or copy files from that directory.
2. **This app never edits, deletes, or writes to files in any user workspace.** All workspace file access is read-only (`list_directory`, `read_file`, `search_files`). There is no write tool, no command-execution tool, and no approval-flow UI in v1 — because there is nothing destructive to approve.
3. **Loopback only.** The controller binds to `127.0.0.1` exclusively. No LAN/remote exposure, no multi-user auth — this is a single-user local app.
4. **New app lives at:**
   `/Users/suvojitdutta/Documents/Rest/apps/apps/Codex-CLI-UI/Ollama_Local_UI/`
   as a sibling to `Codex_CLI_UI/`, sharing only the parent folder.
5. **Talks to the user's existing local Ollama install** at `http://127.0.0.1:11434`, which already has four models pulled and aliased in the user's shell:
   - `qfast` → `qwen3:30b-a3b-instruct-2507-q4_K_M` (tool-calling enabled, fast, no visible reasoning trace)
   - `qthink` → `qwen3:30b-a3b-thinking-2507-q4_K_M` (tool-calling enabled, visible reasoning trace)
   - `rson` → `deepseek-r1:32b-qwen-distill-q4_K_M` (tool-calling disabled by default — see §7)
   - `goss` → `gpt-oss:20b` (tool-calling enabled, visible reasoning trace — see §7)
   Do not assume these are the only models ever available — discover installed models via `GET /api/tags` at runtime; treat the aliases above as known-good defaults, not a hardcoded list.

---

## 1. What This App Is (and isn't)

A local, browser-based chat UI for the user's local Ollama models, with **workspace** (folder) and **attachment** (file) context support — a sister app to `Codex_CLI_UI`, but **not a port of it**. `Codex_CLI_UI` is a thin client over `codex app-server`, a separate binary that does all the hard agentic work (sandboxed writes, approvals, thread storage). Ollama has none of that — it's a stateless chat-completion API. So this app borrows **patterns** from Codex UI's security/workspace model where they genuinely transfer, and builds conversation persistence, workspace sandboxing, and a read-only tool-calling loop from scratch.

**Goals:**
- Proper chat UI for `qfast` / `qthink` / `rson` (and any other installed model) — no more shell aliases.
- **Workspaces**: attach one or more local folders to a conversation for read-only context.
- **Attachments**: attach individual files (PDF, DOCX, text, images) to a conversation or a single message, independent of any workspace.
- Conversation history persists across restarts (SQLite).
- PWA-installable in Chrome.
- **Stays usable in long, tool-heavy conversations without silently blowing the context window or the model's RAM footprint** — see §11.

**Explicit non-goals (v1):**
- No autonomous file editing, no command/shell execution by the model, no approval-flow UI.
- Not a multi-agent orchestrator — this is a daily-driver chat/evaluation tool, not where any separate agentic-pipeline logic lives.

---

## 2. Tech Stack & Repo Layout

Node 20+, TypeScript, npm workspaces, Express + `ws` controller, React 19 + Vite web app, static build served by the controller, cookie-session auth, PWA-installable.

```
Ollama_Local_UI/
├── package.json                  (npm workspaces: apps/*, packages/*)
├── ollama-local-ui-project-spec.md        (background — do not build from this)
├── apps/
│   ├── controller/               local HTTP/WS server + Ollama client + persistence
│   │   └── src/
│   │       ├── main.ts
│   │       ├── server.ts             Express app, WS upgrade, session auth, CSP
│   │       └── services/
│   │           ├── ollamaClient.ts   talks to localhost:11434, streaming chat, tool loop
│   │           ├── workspace.ts      path validation/sandboxing
│   │           ├── attachments.ts    file ingestion: text extraction, size/type limits
│   │           ├── conversationStore.ts   SQLite-backed persistence
│   │           ├── contextBudget.ts   token estimation + context-window assembly (see §11)
│   │           ├── compaction.ts      mechanical pruning + LLM-summary compaction (see §11)
│   │           └── modelRegistry.ts  discovers installed models via GET /api/tags
│   └── web/                      React SPA
│       └── src/
│           ├── App.tsx
│           ├── main.tsx
│           └── styles.css            (design tokens — see §4)
└── packages/
    ├── shared/                   browser-facing types + prompt templates
    └── ui/                       shared UI bits (StatusPill, etc.)
```

There is no `protocol-adapter` / `protocol-generated` package — those exist in Codex UI only to translate `codex app-server`'s JSON-RPC protocol. There is no equivalent protocol here; Ollama's HTTP API is the whole interface.

---

## 3. Core Domain Model (`packages/shared/src/types.ts`)

```ts
export type PermissionMode = "read-only"; // only mode that exists in v1

export type OllamaConnectionState = "starting" | "ready" | "unavailable" | "model-missing";

export type TurnStatus = "idle" | "running" | "interrupted" | "failed" | "completed";

export interface WorkspaceInfo {
  path: string;
  displayName: string;
  isGitRepository: boolean;
  fileCount: number;         // populated at validation time, capped (see §8)
  truncated: boolean;        // true if fileCount hit the cap
}

export interface WorkspaceSet {
  primary: WorkspaceInfo;
  linked: WorkspaceInfo[];   // up to 9 (MAX_CONVERSATION_WORKSPACES = 10 total)
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
  supportsTools: boolean;    // whether tool-calling is enabled for this model
  supportsThinking: boolean; // whether this model emits a stripped-on-resend reasoning trace (see §11.3)
  defaultNumCtx: number;     // default configured context window for this model (see §7.1)
  sizeBytes: number;
  family: string;            // "qwen3", "deepseek-r1", etc., from `ollama show`
}

export type MessageRole = "user" | "assistant" | "system" | "tool";

export interface ConversationMessage {
  id: string;
  role: MessageRole;
  text: string;               // full, untouched text as generated/entered — always preserved
  thinkTrace?: string;         // full reasoning trace, stored separately from `text` (see §11.3)
  toolCalls?: ToolCallRecord[]; // populated on assistant messages that read files
  isSummary?: boolean;         // true for a synthetic message produced by compaction (see §11.4)
  createdAt: number;
  streaming?: boolean;
}

export interface ToolCallRecord {
  id: string;
  name: "list_directory" | "read_file" | "search_files";
  args: Record<string, unknown>;
  result: string;             // truncated preview stored; full result not re-sent on reload
  workspacePath: string;      // which workspace root this touched
  turnId: string;             // which turn produced this call — used to decide "current turn" vs "prior turn" at resend time (see §11.2)
}

export interface Conversation {
  id: string;
  title: string;
  model: string;               // Ollama tag in use
  numCtx: number;               // context window actually configured for this conversation (see §7.1)
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
  body: string;                 // {{variable}} interpolation
  variables: string[];
  builtIn: boolean;
}

export interface ContextBudget {
  numCtx: number;                // the num_ctx actually configured for this conversation
  estimatedTokens: number;       // heuristic estimate of what the NEXT request would send, after mechanical pruning
  usedRatio: number;             // estimatedTokens / numCtx, drives the UI meter
}

export interface CompactionEvent {
  id: string;
  conversationId: string;
  trigger: "auto" | "manual";
  method: "mechanical" | "llm_summary";
  beforeEstimatedTokens: number;
  afterEstimatedTokens: number;
  summaryText?: string;          // present when method === "llm_summary"
  createdAt: number;
}

export type ControllerEvent =
  | { type: "connection"; state: OllamaConnectionState; detail?: string }
  | { type: "conversation_created"; conversation: Conversation }
  | { type: "conversation_loaded"; conversation: Conversation }
  | { type: "turn_state"; conversationId: string; status: TurnStatus; detail?: string }
  | { type: "message_delta"; conversationId: string; messageId: string; delta: string }
  | { type: "message"; conversationId: string; message: ConversationMessage }
  | { type: "tool_call_started"; conversationId: string; call: Omit<ToolCallRecord, "result"> }
  | { type: "tool_call_completed"; conversationId: string; call: ToolCallRecord }
  | { type: "context_budget"; conversationId: string; budget: ContextBudget }
  | { type: "compaction"; conversationId: string; event: CompactionEvent }
  | { type: "diagnostic"; level: "info" | "warning" | "error"; message: string; detail?: string };

export type ClientCommand =
  | { type: "new_conversation"; model: string; workspaceSet: WorkspaceSet | null }
  | { type: "send_message"; conversationId: string; text: string; messageAttachmentIds?: string[] }
  | { type: "interrupt_turn"; conversationId: string }
  | { type: "switch_model"; conversationId: string; model: string }
  | { type: "compact_conversation"; conversationId: string };

export interface BootstrapPayload {
  appVersion: string;
  controllerHost: string;
  ollamaState: OllamaConnectionState;
  installedModels: ModelOption[];
  recentWorkspaces: WorkspaceInfo[];
  preferences: AppPreferences;
  templates: PromptTemplate[];
  diagnostics: DiagnosticsEntry[];
}

export interface AppPreferences {
  theme: "system" | "light" | "dark";
  defaultModel: string | null;
  dataDir: string;    // display-only; not user-editable without a restart
  autoCompactThreshold: number; // fraction of numCtx that triggers auto-compaction, default 0.75
}

export interface DiagnosticsEntry {
  level: "info" | "warning" | "error";
  message: string;
  detail?: string;
  at: number;
}
```

---

## 4. Visual Design System — "Bench" (implement exactly as specified)

The visual direction is a **sophisticated modern lab / instrument-console** aesthetic — explicitly not an "Apple software" look. A reference mockup was built and approved; the tokens, type system, and layout below are taken directly from it and must be implemented as the app's actual design system (`apps/web/src/styles.css`), not reinterpreted.

### 4.1 Typography

- UI text: **IBM Plex Sans** (400/500/600), fallback `-apple-system, BlinkMacSystemFont, sans-serif`
- Data/telemetry/code/paths: **IBM Plex Mono** (400/500/600), fallback `ui-monospace, monospace`
- Load via Google Fonts: `@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap');`
- Base body size 14px, line-height 1.5, `-webkit-font-smoothing: antialiased`
- Any column of numbers (token/sec, byte counts, timestamps, context-window usage) gets `.tabular { font-variant-numeric: tabular-nums; }`

### 4.2 Color tokens (CSS custom properties, three-state theming)

Bare `:root` = light (default). `@media (prefers-color-scheme: dark)` guarded by `:root:not([data-theme="light"])` for system dark mode. `:root[data-theme="dark"]` repeats the same values so an explicit in-app toggle also works. Theme follows system by default, with an explicit override available in Settings.

```css
:root {
  --bg: #eef0f1;
  --bg-grid: rgba(27,31,34,0.05);
  --surface: #ffffff;
  --surface-raised: #f6f7f8;
  --surface-sunken: #e6e8e9;
  --border: #d7dadc;
  --border-strong: #c2c6c8;
  --text: #1b1f22;
  --text-muted: #5b6268;
  --text-faint: #8b9297;
  --accent: #96702b;
  --accent-ink: #ffffff;
  --accent-soft: rgba(150,112,43,0.12);
  --success: #3f8760;
  --success-soft: rgba(63,135,96,0.14);
  --warning: #a97b1e;
  --warning-soft: rgba(169,123,30,0.14);
  --error: #a8493d;
  --error-soft: rgba(168,73,61,0.14);
  --shadow: 0 1px 2px rgba(20,23,26,0.06), 0 8px 24px rgba(20,23,26,0.06);
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #14171a;
    --bg-grid: rgba(232,234,237,0.04);
    --surface: #1c2024;
    --surface-raised: #23282d;
    --surface-sunken: #101315;
    --border: #33383d;
    --border-strong: #454b51;
    --text: #e8eaed;
    --text-muted: #9aa1a8;
    --text-faint: #6b7278;
    --accent: #c99a3d;
    --accent-ink: #1b1503;
    --accent-soft: rgba(201,154,61,0.16);
    --success: #6fbf8b;
    --success-soft: rgba(111,191,139,0.16);
    --warning: #e0b23a;
    --warning-soft: rgba(224,178,58,0.16);
    --error: #c96257;
    --error-soft: rgba(201,98,87,0.16);
    --shadow: 0 1px 2px rgba(0,0,0,0.3), 0 12px 32px rgba(0,0,0,0.35);
  }
}

:root[data-theme="dark"] {
  /* identical values to the dark block above */
}
```

`--accent` (brass/copper) is used for the active/running state, primary buttons, and the context-usage meter fill — nowhere else. `--success` / `--warning` / `--error` are semantic states (connection health, tool-call status, turn status) and are never used as decoration.

### 4.3 Layout

Three-pane grid shell: `grid-template-columns: 232px 1fr 292px` (left rail / center / right rail), `height: 100vh`.
- **Left rail** (`--surface`, right border): wordmark + mark icon, "Workspaces" section (active workspace highlighted with `--accent-soft` background and an accent dot), "Conversations" list (grouped/sorted by recency, each showing model alias + relative time), footer with an Ollama connection LED (green = ready, pulses only while a turn is running, respects `prefers-reduced-motion`).
- **Center**: a telemetry strip (model badge with running-state LED, tokens/sec, context-window-used meter with numeric readout, active workspace name) above the message stream; message stream shows user/assistant bubbles (user right-aligned on `--accent-soft`, assistant left-aligned on `--surface`), with an optional monospace "think trace" block above an assistant bubble for models with visible reasoning (`qthink`); composer at the bottom with an attach button, textarea, send button, and a hint row that always states whether the active model can write to the workspace (it never can — the hint text should say so plainly, e.g. "Read-only — this model cannot modify files in this workspace").
  - **The context-window-used meter's numerator is the live `ContextBudget.estimatedTokens` value (post mechanical-pruning), and its denominator is the conversation's actual configured `numCtx` — never the model's theoretical maximum.** A "Compact conversation" button sits next to it, enabled once there's anything to compact (see §11.5), and the telemetry strip surfaces a small badge whenever a `compaction` event fires ("compacted · freed ~18K tokens").
- **Right rail** (`--surface`, left border): "Activity — this turn" (tool-call log: function name, path, duration, result summary), "Attachments" (file chip: type badge, name, size, extraction status), "Turn" (current tool-call budget usage, e.g. "tool budget 3/8 used"). Compaction events also appear here as a distinct log-entry type (see §11.5) so pruning is never invisible.
- Responsive: right rail hides below 980px; left rail hides and columns stack below 700px (per the standard artifact responsive rules — no horizontal scroll on the page body, only wide/tabular sub-elements may scroll internally).

### 4.4 Component visual details worth preserving exactly
- Rounded corners are small and consistent (5–10px), never large/pill-shaped except icon buttons.
- Borders (`--border` / `--border-strong`) do most of the separation work; shadows (`--shadow`) are reserved for anything that visually floats above the shell (dropdowns, modals), not used on static panels.
- A subtle dot-grid background (`radial-gradient(var(--bg-grid) 1px, transparent 1px) 0 0 / 24px 24px` under `--bg`) gives the "instrument panel" texture — keep it, keep it faint.
- Tool-call activity entries, attachment chips, and conversation list items are the same repeated-object pattern throughout: same padding, same border-bottom rhythm, same right-aligned metadata.

A full working reference (`bench-mockup.html`) exists and can be inspected for exact spacing/markup if anything above is ambiguous — build the real component tree to match it, not to reinterpret it.

---

## 5. REST API Surface (`apps/controller/src/server.ts`)

All routes prefixed `/api`. All require the session cookie except `/api/bootstrap` (sets it) and `/api/health`. Standard hardening: HttpOnly per-launch session cookie, CSP (`connect-src 'self' ws://127.0.0.1:*` — the page never needs to fetch `11434` directly), loopback-only bind.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | `{ ok, appVersion, ollamaState }` — liveness probe, no session required |
| GET | `/api/bootstrap` | Sets session cookie; returns `BootstrapPayload` |
| GET | `/api/models` | Proxies `GET :11434/api/tags`, mapped to `ModelOption[]` |
| POST | `/api/workspaces/validate` | Body `{ path }` → canonicalizes, checks it's a directory, returns `WorkspaceInfo` |
| POST | `/api/workspaces/pick` | Native `osascript` folder picker → `{ cancelled } \| { cancelled: false, workspace }` |
| GET | `/api/workspaces/recent` | Recently used workspace paths (persisted) |
| DELETE | `/api/workspaces/recent` | Body `{ path }` → removes from recents (never touches the actual folder) |
| POST | `/api/workspace-sets/validate` | Body `{ primaryPath, linkedPaths[] }` → full validation (cap 10, no overlap) → `WorkspaceSet` |
| POST | `/api/attachments` | `multipart/form-data` upload → extracts text, returns `AttachmentInfo` (original stored under app data dir, not the workspace) |
| GET | `/api/attachments/:id/raw` | Streams the original file back (for "open"/"reveal" actions) |
| POST | `/api/files/open` | Body `{ workspacePath, path }` → validated, then `open` via `execFile`, no shell |
| POST | `/api/files/reveal` | Same validation → `open -R` |
| GET | `/api/conversations` | Query `?workspacePath=` → list from SQLite, newest first |
| GET | `/api/conversations/:id` | Full conversation incl. messages + attachments |
| DELETE | `/api/conversations/:id` | Soft delete (`archived = true`) — never a hard delete from the UI |
| PATCH | `/api/preferences` | Theme, default model, data dir display, `autoCompactThreshold` |
| GET | `/api/diagnostics/report` | Redacted recent errors + connection state + recent `CompactionEvent`s |

No write-mode/approval endpoints exist because there is no write-capable tool in v1. Workspace set is fixed at conversation creation (no mid-conversation workspace-set mutation endpoint). Compaction is triggered over the WebSocket (`compact_conversation`), not REST, matching `interrupt_turn`'s pattern as a live, in-turn-adjacent action.

---

## 6. WebSocket Protocol

One socket per browser tab, upgraded at `/ws`, with origin + session validation before accepting the upgrade.

**Client → Controller (`ClientCommand`):**
```ts
| { type: "new_conversation"; model: string; workspaceSet: WorkspaceSet | null }
| { type: "send_message"; conversationId: string; text: string; messageAttachmentIds?: string[] }
| { type: "interrupt_turn"; conversationId: string }
| { type: "switch_model"; conversationId: string; model: string }
| { type: "compact_conversation"; conversationId: string }
```

**Controller → Client (`ControllerEvent`):**
```ts
| { type: "connection"; state: OllamaConnectionState; detail?: string }
| { type: "conversation_created"; conversation: Conversation }
| { type: "turn_state"; conversationId: string; status: TurnStatus; detail?: string }
| { type: "message"; conversationId: string; message: ConversationMessage }
| { type: "message_delta"; conversationId: string; messageId: string; delta: string }
| { type: "tool_call_started"; conversationId: string; call: Omit<ToolCallRecord, "result"> }
| { type: "tool_call_completed"; conversationId: string; call: ToolCallRecord }
| { type: "context_budget"; conversationId: string; budget: ContextBudget }
| { type: "compaction"; conversationId: string; event: CompactionEvent }
| { type: "diagnostic"; level: "info" | "warning" | "error"; message: string; detail?: string }
```

No `approval_requested` / `approval_resolved` / `user_input_requested` events exist in v1 — there is nothing to approve. `context_budget` fires after every completed turn (and after every compaction) so the UI meter in §4.3 always reflects the true next-request size.

---

## 7. Model Integration (`ollamaClient.ts`)

- Talks to `http://127.0.0.1:11434`.
- Model list discovered via `GET /api/tags` at runtime — never hardcode the three aliases as the only options; map them to friendly names when they match, but any installed model must be selectable.
- Streams via `POST /api/chat` with `"stream": true`; each chunk becomes a `message_delta` event over the WebSocket.
- **Tool-calling for read-only file access** uses Ollama's `tools` parameter:
  - `qfast` / `qthink`: tool-calling **enabled** in `modelRegistry.ts` (`supportsTools: true`).
  - `rson`: tool-calling **disabled by default** (`supportsTools: false`) — this is a registry flag, not a hardcoded rule, so it's a one-line change if empirical testing shows DeepSeek-R1's tool-calling works fine through Ollama. Test this early in Stage C rather than trusting the assumption.
  - `goss` (`gpt-oss:20b`): tool-calling **enabled** (`supportsTools: true`) — OpenAI's gpt-oss models are specifically built around structured tool use (part of the "harmony" response format they're trained on), so this is a reasonable default rather than a guess, but it still goes through the same Stage C empirical check as the others before being trusted.
  - When `supportsTools` is false for the active model, the `tools` field is omitted entirely from the request — workspace files are then only available via explicit attachment.
- **Reasoning/"thinking" content** (`supportsThinking: true`) applies to `qthink` and `goss` alike — gpt-oss models emit their chain-of-thought as a distinct "analysis" channel in the harmony format, which Ollama surfaces similarly to Qwen3's `<think>` blocks. Treat it identically to `qthink`'s trace for display (§4.3) and for stripping on resend (§11.3) — one code path, not a model-specific special case.

**Ollama chat request shape actually sent:**
```ts
// POST http://127.0.0.1:11434/api/chat
{
  model: string,                 // e.g. "qwen3:30b-a3b-instruct-2507-q4_K_M"
  messages: Array<{
    role: "system" | "user" | "assistant" | "tool",
    content: string,
    tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>
  }>,
  tools?: Array<{               // omitted entirely for models with supportsTools=false
    type: "function",
    function: {
      name: "list_directory" | "read_file" | "search_files",
      description: string,
      parameters: { /* JSON Schema */ }
    }
  }>,
  options: {
    num_ctx: number             // ALWAYS set explicitly — never rely on Ollama's own default (see §7.1)
  },
  stream: true
}
```

### 7.1 `num_ctx` must always be set explicitly

Ollama does not automatically serve a model at its full trained context length — unless `options.num_ctx` is set on every request, Ollama falls back to its own much smaller default window, silently, regardless of what the model is actually capable of. This app must never rely on that default:

- Every model in `modelRegistry.ts` carries a `defaultNumCtx` — a deliberately conservative starting point, **not** the model's theoretical maximum, chosen to leave RAM headroom on the user's 48GB machine (raising `num_ctx` grows the KV cache on top of the ~18–20GB the model weights already occupy). Suggested starting defaults: `qfast`/`qthink` at 32,768 (well under their 256K architectural max), `rson` at 16,384 (well under its ~128K max) — tune these empirically once Stage B is running against the real hardware; they are a starting point, not a promise.
- `Conversation.numCtx` is set from the model's `defaultNumCtx` at conversation creation and is editable per-conversation in the UI (Settings or a per-conversation control), so a user who wants a much bigger window for one long research session can opt into the RAM cost deliberately, instead of the app silently deciding for them.
- The context-used meter (§4.3) and all compaction thresholds (§11) are measured against this configured `numCtx`, never against the model's architectural maximum — the two numbers are allowed to be very different, and the UI must never conflate them.

---

## 8. Workspaces

- One primary + up to 9 linked folders per conversation (`MAX_CONVERSATION_WORKSPACES = 10`).
- Every path canonicalized (`realpath`) and validated as an existing directory before acceptance.
- Overlap check: no linked folder may contain or be contained by another selected root.
- All reads sandboxed to selected roots: every tool-call path resolved and checked against every selected workspace root before the file is read. A `read_file` call for a path that escapes every root (e.g. `../../../etc/passwd`) is rejected — this containment check re-runs on **every single tool call**, not cached from the first (a model could try a valid path once and a traversal attempt on the next call in the same turn).
- **Native macOS folder picker** via `osascript "choose folder"` + `execFile` (never shell string interpolation).
- **File enumeration with limits**: walk a workspace to build a browsable tree, skipping `.git`, `node_modules`, `dist`, `build`, and similar noise directories, capped at 2,000 files and 1MB per file before a file is "readable" vs. "too large, use targeted read."
- **Read-only tools exposed to the model:**
  - `list_directory(path)` — entries under a workspace-relative path.
  - `read_file(path)` — file contents, truncated with a clear marker if over the size cap.
  - `search_files(query)` — substring/grep-style search across the workspace, returning matching paths + line snippets (not embedding/semantic search — deliberately deferred, see §19).
  - No approval UI is needed for any of these — path-containment validation *is* the safety boundary, since every available tool is read-only. Because reads are cheap and idempotent, a pruned/collapsed tool result (§11.2) can always be re-fetched by the model with no correctness cost, only a small latency cost.

---

## 9. Attachments

Separate from workspaces — files attached directly, regardless of whether they're inside any selected workspace folder.

- **Conversation-scoped**: attached once, available for the whole conversation.
- **Message-scoped**: attached to a single message.
- Ingestion (`attachments.ts`):

| Type | Detection | Extraction | Size cap |
|---|---|---|---|
| Plain text / code / markdown | extension allowlist + UTF-8 byte-sampling sniff | read directly | 1MB, truncate with a marker beyond that |
| PDF | mime `application/pdf` | `pdf-parse` → plain text | 20MB source file; extracted text itself capped at 1MB |
| DOCX | mime or `.docx` extension | `mammoth` → plain text | same as PDF |
| Image | mime `image/*` | none — stored, not extracted | 10MB |
| Anything else | — | marked `kind: "unsupported"`, shown in UI, never sent to the model | n/a |

None of `qfast`/`qthink`/`rson` are vision-capable, so images are stored (visible in UI, revealable in Finder) without sending pixel data, with a clear "this model can't see images" notice — never silently dropped. The file picker uses the same native `osascript "choose file"` approach as the folder picker. Conversation-scoped attachment text is included once per request, not duplicated per message, regardless of how many messages reference it.

---

## 10. Conversation Persistence

Ollama has no server-side thread storage — this app owns all of it. Use **SQLite** via `better-sqlite3` (synchronous, zero external service, no growing-JSON-file problem for tool-call-heavy histories).

```
~/Library/Application Support/Ollama Local Workspace/
└── conversations.sqlite
```

```sql
CREATE TABLE conversations (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  model         TEXT NOT NULL,
  num_ctx       INTEGER NOT NULL,            -- configured context window for this conversation (see §7.1)
  workspace_set_json TEXT,          -- nullable; JSON-serialized WorkspaceSet
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  archived      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user','assistant','system','tool')),
  text            TEXT NOT NULL,             -- full text, always preserved as originally generated/entered
  think_trace     TEXT,                      -- full reasoning trace if the model emitted one (see §11.3); NEVER resent, display-only
  tool_calls_json TEXT,             -- nullable; JSON array of ToolCallRecord
  turn_id         TEXT,                      -- groups messages produced by the same turn (see §11.2)
  is_summary      INTEGER NOT NULL DEFAULT 0, -- 1 for a synthetic message produced by compaction (see §11.4)
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at);

CREATE TABLE attachments (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id      TEXT REFERENCES messages(id) ON DELETE CASCADE,  -- null = conversation-scoped
  file_name       TEXT NOT NULL,
  source_path     TEXT NOT NULL,
  mime_type       TEXT NOT NULL,
  size_bytes      INTEGER NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('text','image','unsupported')),
  extracted_text  TEXT,
  stored_path     TEXT NOT NULL,    -- where the app copied the original bytes, under the data dir
  created_at      INTEGER NOT NULL
);

CREATE TABLE compaction_events (
  id                       TEXT PRIMARY KEY,
  conversation_id          TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  trigger                  TEXT NOT NULL CHECK (trigger IN ('auto','manual')),
  method                   TEXT NOT NULL CHECK (method IN ('mechanical','llm_summary')),
  before_estimated_tokens  INTEGER NOT NULL,
  after_estimated_tokens   INTEGER NOT NULL,
  summary_text             TEXT,             -- present when method = 'llm_summary'
  created_at               INTEGER NOT NULL
);
CREATE INDEX idx_compaction_conversation ON compaction_events(conversation_id, created_at);
```

**Critical invariant: the raw tables above are never mutated to save tokens.** `messages.text`, `messages.think_trace`, and `tool_calls_json.result` always hold the complete, original content — this is the durable, honest record the UI's transcript and activity log are built from. Everything token-optimization does (§11) happens only in a derived, in-memory "resend view" assembled fresh for each Ollama request; nothing is ever destructively rewritten in SQLite to save context space. Compaction's LLM-generated summary is stored as an *additional* row (`is_summary = 1`), never as a replacement for the turns it summarizes.

Preferences (theme, default model, data dir display, `autoCompactThreshold`) stay in a small flat `preferences.json` file — nothing about them needs querying.

---

## 11. Token Budget & Context Compaction Strategy

Ollama's `/api/chat` is stateless — the controller resends the *entire* message history on every single call. Left unmanaged, this means (a) a long conversation eventually exceeds the configured `num_ctx` and starts failing or degrading, and (b) every file a model has ever read via a tool call keeps getting re-sent, verbatim, on every subsequent turn, forever — by far the fastest way a workspace-heavy conversation exhausts its context window. This section is the mitigation strategy, layered from cheapest to smartest, decided as follows:

- **Trigger**: automatic, with a manual override always available (§11.5).
- **Method**: mechanical pruning runs continuously and for free; an LLM-generated summary is the backstop only when mechanical pruning alone isn't enough (§11.1–§11.4).
- **Tool-call results**: pruned to a pointer once "used" — the model re-calls the (cheap, local, read-only) tool if it needs the file again (§11.2).
- **Reasoning traces**: `qthink`'s visible chain-of-thought is stripped from every resend, kept only for display (§11.3).

The controller assembles a fresh **"resend view"** of the conversation for every Ollama request. This view is *derived* from the SQLite rows at request time — it is never what gets persisted. The persisted rows (§10) always keep the full original content; only the resend view is optimized.

### 11.1 Token estimation

Ollama does not expose a pre-flight tokenizer, so the controller uses a cheap heuristic — roughly 1 token per 4 characters of assembled request text (system + messages + tool schema) — to compute `ContextBudget.estimatedTokens` before every send, and reconciles it against the real count Ollama returns after the fact (`prompt_eval_count` in the response) to keep the heuristic reasonably calibrated over the life of a conversation. This does not need to be exact; it needs to reliably trigger compaction *before* a request would actually fail, with margin to spare.

### 11.2 Mechanical pruning — tool-call result collapsing

Every `ToolCallRecord` carries the `turnId` of the turn that produced it. When assembling the resend view:
- Tool messages belonging to the **current, still-in-flight turn** are included in full — the model needs the real file content to answer the question that triggered the read.
- Tool messages belonging to **any completed prior turn** are collapsed to a one-line pointer in the resend view only, e.g.
  `[tool result collapsed — read_file("backlog-notes.md") in an earlier turn, 4.1KB, not resent; call the tool again if you need this file's contents]`
  The full original result stays in SQLite untouched, and stays visible in the "Activity — this turn" log's history for that earlier turn — only what gets sent back to the model shrinks.
- If the model calls the same tool for the same path again later in the conversation, it executes normally (workspace files are read-only, so re-reading is always safe and produces the same result modulo the file having changed on disk — expected, since this is *live* local workspace context).

### 11.3 Mechanical pruning — reasoning-trace stripping

For any model with `supportsThinking: true` (`qthink`), the assistant's reasoning content is captured into `ConversationMessage.thinkTrace` (shown once, live, in the UI as the "think trace" block per §4.3) and is **never included in the resend view for any turn, including the immediately preceding one** — only `text` (the final answer) is resent. Chain-of-thought does not need to be replayed for the model to continue a conversation coherently, and stripping it is a pure, free token saving with no quality cost.

### 11.4 LLM-summarized compaction (the backstop)

If, after mechanical pruning, `ContextBudget.usedRatio` still exceeds `AppPreferences.autoCompactThreshold` (default 0.75), the controller runs a compaction pass:
1. Select the oldest contiguous block of turns, always leaving a protected tail of the most recent turns (e.g. the last 6 messages) untouched so immediate conversational continuity is never lost.
2. Make one extra, non-streaming call to `qfast` (the fast, no-reasoning-overhead model, regardless of which model the conversation is actually using) with a fixed summarization prompt: condense the selected turns into a compact narrative summary that preserves decisions, facts, file paths referenced, and open questions — not a transcript, a working summary.
3. Persist the summary as a new message row (`role: "system"`, `is_summary: 1`) and record a `CompactionEvent` (`method: "llm_summary"`) with before/after estimated token counts.
4. In the resend view (only), the summarized turns' original messages are replaced by this single summary message; in SQLite and in the UI transcript, the original messages remain fully visible and readable — compaction only changes what gets resent to the model, never what the user can scroll back and read.

If mechanical pruning alone is enough to bring `usedRatio` back under threshold (common early in a conversation, once old tool results start collapsing), no LLM call happens at all — the summarization step is a backstop, not a default action.

### 11.5 Manual control and visibility

- A **"Compact conversation"** control is always available in the center telemetry strip (§4.3), enabled whenever there's anything prunable. Clicking it runs the same pipeline as an automatic trigger (`trigger: "manual"` instead of `"auto"` on the resulting `CompactionEvent`), so a user can proactively clear headroom before starting a large workspace-read-heavy question.
- Every `CompactionEvent` — automatic or manual — appears as its own entry in the right rail's activity log (§4.3), distinguishable from tool-call entries, showing the trigger, the method, and the tokens freed (e.g. "Compacted · auto · freed ~18,400 tokens").
- `context_budget` events fire after every completed turn and after every compaction, so the meter's numerator is always current.
- Nothing about compaction is ever silent: the goal is that a user reading the activity log can always reconstruct why the model might not remember something from many turns back, rather than the app quietly degrading behavior with no visible cause.

---

## 12. Sequence Flows

### 12.1 Sending a message (no tool calls, e.g. `rson`)
```
Browser --send_message--> Controller
Controller: load conversation from SQLite, append user message, persist
Controller --turn_state: running--> Browser
Controller: assemble resend view (§11) --> estimate tokens --> if over threshold, run compaction (§11.4) first
Controller --POST /api/chat (stream:true, options.num_ctx set per §7.1) [resend-view history]--> Ollama
Ollama --chunk--> Controller --message_delta--> Browser  (repeated)
Ollama --done--> Controller: persist final assistant message (full text, untouched)
Controller --message (final assistant message)--> Browser
Controller --context_budget (recomputed)--> Browser
Controller --turn_state: completed--> Browser
```

### 12.2 Sending a message with tool-calling (`qfast`/`qthink`, workspace attached)
```
Browser --send_message--> Controller
Controller --turn_state: running--> Browser
Controller: assemble resend view (§11: prior-turn tool results collapsed, prior think-traces stripped)
Controller --POST /api/chat (stream:true, tools:[list_directory, read_file, search_files], options.num_ctx)--> Ollama
Ollama --tool_call requested--> Controller
Controller: validate path against workspace roots
  if invalid path --> synthesize a tool-result message: "Error: path outside workspace" (never silently ignored)
  if valid --> execute (list dir / read file / grep), truncate per size caps
Controller --tool_call_started--> Browser
Controller: append tool result as a "tool" role message tagged with this turn's turnId, re-POST /api/chat with updated history
Controller --tool_call_completed--> Browser
[repeat if the model chains multiple tool calls, up to the hard cap in §14]
Ollama --final streamed answer--> Controller --message_delta (repeated)--> Browser
Controller --message, context_budget, turn_state: completed--> Browser
```
There is no approval pause anywhere in this sequence — the security boundary is path validation before execution, not a human-in-the-loop gate. This is only safe because every available tool is read-only; it does not extend to any future write/exec tool. Note that within *this* turn, the fresh tool result is sent in full on every re-POST — collapsing only applies to *prior, completed* turns on later sends.

### 12.3 Interrupting a turn
```
Browser --interrupt_turn--> Controller
Controller: abort the in-flight fetch to Ollama (AbortController), stop appending deltas
Controller --turn_state: interrupted--> Browser
Controller: persist whatever partial assistant text was streamed so far, marked incomplete
```
Ollama has no server-side interrupt RPC — interruption is client-side (aborting the HTTP stream), which is why partial output up to that point is what gets saved.

### 12.4 Attachment ingestion
```
Browser: user picks a file (native picker or drag-in)
Browser --POST /api/attachments (multipart)--> Controller
Controller: detect mime type, size-check
  text/markdown/code --> read as utf8 directly
  application/pdf --> pdf-parse --> extracted text
  .docx --> mammoth --> extracted text
  image/* --> store only; extractedText left undefined
Controller: persist to SQLite + store original bytes under app data dir (not the workspace)
Controller --> Browser: AttachmentInfo
```

### 12.5 Manual or automatic compaction
```
[auto: controller detects usedRatio > autoCompactThreshold while assembling a resend view]
[manual: Browser --compact_conversation--> Controller]
Controller: apply mechanical pruning (§11.2, §11.3) to compute estimate
  if still over threshold (or manual trigger requested regardless):
    Controller --POST /api/chat (non-streaming) to qfast with summarization prompt--> Ollama
    Ollama --> Controller: summary text
    Controller: persist summary message (is_summary=1) + CompactionEvent row
Controller --compaction event--> Browser
Controller --context_budget (recomputed)--> Browser
```

---

## 13. Component Tree (`apps/web/src/`)

Single `App.tsx` with a `reduceEvent(state, event)` reducer over WebSocket events (split into more files only if it grows past ~1500 lines). Built to match the visual system in §4:

- `Sidebar` (left rail) — workspace list, conversation list, "New conversation" with model picker, Ollama connection LED footer
- `WorkspacePanel` — primary/linked chips, add-workspace flow (native picker or manual path), collapsible file-tree browser
- `AttachmentPanel` (part of right rail) — conversation-level attachment list + drag-drop zone
- `ConversationView` (center) — telemetry strip (including the context-used meter and "Compact conversation" control, §4.3/§11.5), message stream, composer with per-message attach control and model picker
- `ToolCallActivity` (right rail) — renders `tool_call_started`/`tool_call_completed` as the "Activity — this turn" log, and `compaction` events as a distinguishable entry type in the same log
- `TemplatesView` — starter templates with `{{variable}}` interpolation, seeded with reasoning/analysis prompts (e.g. "Summarize this workspace", "Compare these attached documents", "Reason through this problem step by step") rather than "implement a change"
- `SettingsView` — theme (system/light/dark), default model, data directory display, "open data folder in Finder", per-conversation `numCtx` override, `autoCompactThreshold`
- `DiagnosticsView` — Ollama connection state, recent errors, recent compaction events

---

## 14. Tool-Calling Loop Safety Limits

No human approval gate exists, so the controller enforces its own limits:
- **Max tool calls per turn: 8.** On the 9th requested call, return a synthetic tool error ("Tool call budget exceeded for this turn") instead of executing it; the model must answer from what it already has.
- **Per-call timeout**: 5s for `list_directory`/`search_files`, 2s for `read_file`.
- **Result size cap**: tool results truncated to 8KB before being fed back to the model, with a `[truncated, N more bytes not shown]` marker.
- **Path validation re-run on every call**, never cached from the first call in a turn.

These limits bound a single turn's tool-call volume; §11's pruning bounds how much of that volume keeps costing tokens in *later* turns.

---

## 15. Error Handling Matrix

| Condition | Behavior |
|---|---|
| Ollama not running / connection refused | `connection: unavailable` event; composer disabled with a clear "Start Ollama" message, not a silent hang |
| Selected model not installed anymore | `connection: model-missing`; model picker highlights it, blocks sending until a valid model is chosen |
| Tool call requests a path outside all workspace roots | Synthetic tool-error result returned to the model (not an app crash); logged as a `warning` diagnostic |
| Attachment exceeds size cap | Rejected at upload with a clear message; nothing partially stored |
| PDF/DOCX extraction fails (corrupt file) | Attachment stored with `kind: "unsupported"`, `extracted_text: null`, plus a diagnostic — never silently sent as empty context |
| Ollama stream errors mid-response | `turn_state: failed`; partial assistant text persisted and visibly marked incomplete |
| SQLite write failure | Diagnostic logged; in-memory state still reflects the attempted change for that session with a visible "not saved" indicator |
| Resend view still exceeds `num_ctx` even after compaction (e.g. one enormous single message) | Reject the send with a clear in-composer error identifying the oversized message/attachment, rather than sending a request Ollama will fail or truncate unpredictably |
| Compaction's `qfast` summarization call itself fails | Fall back to mechanical pruning only (do not block the user's turn on a failed compaction); log a `warning` diagnostic and let `usedRatio` stay elevated rather than silently dropping turns without a summary |

---

## 16. Security Model

- Controller binds only to `127.0.0.1`.
- HttpOnly per-launch session cookie; WS upgrade validates origin + session before accepting.
- CSP: `connect-src 'self' ws://127.0.0.1:*` — the browser never talks to Ollama directly; the controller is the only thing that calls `11434`, both because it owns the sandboxing check and because it keeps the CSP simple.
- All file-tool paths canonicalized and checked against selected workspace roots before any read, every time.
- No credentials, no auth beyond the local session cookie — this is a single-user, loopback-only app.

---

## 17. Testing Strategy

- **Unit**: path canonicalization/containment (traversal, symlink escape), tool-call-loop cap enforcement, attachment size/type detection, SQLite schema round-trips, token-estimation heuristic against known-length strings, tool-result-collapsing logic (current-turn vs. prior-turn), think-trace stripping.
- **Integration**: full `send_message` flow against a real local Ollama instance with a small test model, tool-calling round trip against a disposable fixture workspace, interrupt-mid-stream behavior, a synthetic long conversation that crosses `autoCompactThreshold` and verifiably triggers compaction, a manual `compact_conversation` call.
- **E2E**: create workspace → send message → see streamed response → attach a file → ask about it → confirm the model referenced its content → interrupt a long response → reopen the conversation after a controller restart and confirm history is intact → drive a conversation past the compaction threshold and confirm (a) the model can still answer coherently afterward, (b) the full original transcript is still visible in the UI, (c) a compaction entry appears in the activity log.
- Never test against real user workspaces or real conversation data — disposable fixture directories only.

---

## 18. Build Stages (with acceptance criteria — checkpoint after each)

### Stage A — Scaffold
npm workspaces (`apps/controller`, `apps/web`, `packages/shared`, `packages/ui`), Express+WS controller skeleton, React+Vite shell, `/api/health` + `/api/bootstrap`, PWA manifest, base `styles.css` with the full §4 token system wired to a starter three-pane layout (empty states, no live data yet).
**Done when:** app builds and runs locally, three-pane shell renders correctly in both light and dark (toggle Settings and OS theme to confirm all three theme states), no console errors.

### Stage B — Model registry + streaming chat
`modelRegistry.ts` sourced from `GET /api/tags` mapped to known aliases (including `defaultNumCtx`/`supportsThinking` per §7.1/§11.3); model picker in the UI; `ollamaClient.ts` streaming `/api/chat` with `options.num_ctx` always explicitly set and no tools yet; SQLite persistence wired for simple no-context conversations; basic `contextBudget.ts` producing a real (even if rough) `ContextBudget` and emitting `context_budget` events, wired to the telemetry meter.
**Done when:** you can pick `qfast`, `qthink`, or `rson` in the browser, send a message, see it stream token-by-token, see the context-used meter move against the conversation's actual configured `numCtx`, close and reopen the app, and see the conversation history intact.

### Stage C — Workspaces
Folder picker (native `osascript`), primary+linked validation/sandboxing per §8, file-tree browser, `list_directory`/`read_file`/`search_files` tool implementations, tool-calling wired for `qfast`/`qthink` per §7 and §14, `ToolCallActivity` panel, each `ToolCallRecord` tagged with `turnId`.
**Done when:** attaching a real folder, asking a question that requires reading a file in it, and seeing the tool-call trail populate in the right rail with correct paths/timings, and a path-traversal attempt is provably rejected (test it).

### Stage D — Attachments
File picker, ingestion pipeline per §9 (text/PDF/DOCX/image), conversation- and message-scoped attachment UI, size/type error handling per §15.
**Done when:** attaching a PDF and a DOCX both produce extracted text the model can reference in its answer, an oversized file is rejected with a clear message, and an image shows the "this model can't see images" notice rather than silently vanishing.

### Stage E — Templates, settings, diagnostics, PWA polish
Starter prompt templates, Settings (theme/default model/data dir/per-conversation `numCtx`/`autoCompactThreshold`), Diagnostics view (including recent compaction events), PWA install flow.
**Done when:** the app can be installed from Chrome like a real app, theme setting persists across restarts, and Diagnostics correctly reflects a deliberately-stopped Ollama server (`ollama serve` killed) as `unavailable`.

### Stage F — Token budget & context compaction
Full implementation of §11: mechanical pruning (tool-result collapsing per §11.2, think-trace stripping per §11.3) always active in the resend-view assembly; LLM-summarized compaction backstop per §11.4 using `qfast`; manual "Compact conversation" control and compaction activity-log entries per §11.5; the error-handling rows in §15 specific to compaction.
**Done when:** a scripted long conversation against a real fixture workspace (many tool calls across many turns) demonstrably crosses `autoCompactThreshold`, auto-compacts without the user doing anything, the model's next answer still makes sense, the full original transcript remains intact and readable in the UI, and clicking "Compact conversation" manually on a fresh conversation with at least one completed tool call visibly collapses that tool result in the next request (verifiable via a debug/log view of the actual resend payload).

Do not skip ahead to a later stage before the current stage's "done when" criteria are demonstrably true — each stage should be a working, checkpointable state of the app, not a partial pile of files. Stage F depends on B (context budget plumbing) and C (tool calls with `turnId` to prune); it is deliberately last because it's the stage most likely to need empirical tuning (thresholds, protected-tail size) against how the other stages actually behave once built.

---

## 19. Explicit Deferred Items (not v1 — do not build these)

- Write-capable tools (`write_file`, `run_command`) and any approval-flow UI that would come with them.
- Embedding-based/semantic search over large workspaces (v1 `search_files` is plain substring/grep) — also the long-term answer to "workspace context is bigger than any context window," deliberately deferred rather than solved by compaction, which is a mitigation, not that solution.
- Vision-model support (revisit only if a vision-capable model is added to the Ollama registry).
- Multi-user or remote access — stays single-user, loopback-only.
- Mid-conversation workspace-set changes (workspace set is fixed at conversation creation).
- Compacting/summarizing attachment text itself (only the message trail is compacted in v1; a single oversized attachment is rejected outright per §15, not summarized down).

## 20. Open Risks to Verify Empirically (don't assume)

- Whether Qwen3 tool-calling holds up specifically through Ollama's implementation — verify early in Stage C, not assumed from general reputation.
- Whether DeepSeek-R1-distill tool-calling is actually unreliable through Ollama, or just by reputation — worth a quick empirical check before locking `supportsTools: false` for `rson`.
- Very large attachments/workspaces slowing prefill even within a conservatively-sized context window — not a hard limit, but a latency consideration worth surfacing in the UI (e.g. the context-used meter) rather than hiding.
- The token-estimation heuristic in §11.1 is approximate by necessity (no pre-flight tokenizer available from Ollama) — verify in Stage F that it's conservative enough in practice to trigger compaction with real margin, not so imprecise that a request still overflows `num_ctx` right after a "successful" compaction.
- Whether `qfast`'s summarization calls (§11.4) add noticeable latency mid-conversation on real hardware, and whether the default `autoCompactThreshold` (0.75) and protected-tail size need tuning once Stage F is running against real, long, tool-heavy conversations rather than synthetic test ones.
