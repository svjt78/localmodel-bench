import { useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { StatusPill, type StatusTone } from "@ollama-local/ui";
import type {
  AppPreferences,
  AttachmentInfo,
  BootstrapPayload,
  Conversation,
  ConversationMessage,
  ControllerEvent,
  DiagnosticsEntry,
  ModelOption,
  OllamaConnectionState,
  PromptTemplate,
  ToolCallRecord,
  TurnStatus,
  WorkspaceInfo,
  WorkspaceSet,
} from "@ollama-local/shared";
import { ControllerSocket, type ConnectionStatus } from "./controllerSocket.js";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

interface ConversationListItem {
  id: string;
  title: string;
  model: string;
  updatedAt: number;
}

function relativeTime(ms: number): string {
  const deltaSec = Math.round((Date.now() - ms) / 1000);
  if (deltaSec < 60) return "just now";
  const deltaMin = Math.round(deltaSec / 60);
  if (deltaMin < 60) return `${deltaMin}m ago`;
  const deltaHour = Math.round(deltaMin / 60);
  if (deltaHour < 24) return `${deltaHour}h ago`;
  return `${Math.round(deltaHour / 24)}d ago`;
}

type ThemePreference = "system" | "light" | "dark";
type ModalKind = "templates" | "settings" | "diagnostics" | null;

function cycleTheme(theme: ThemePreference): ThemePreference {
  if (theme === "system") return "light";
  if (theme === "light") return "dark";
  return "system";
}

interface AppState {
  preferences: AppPreferences;
  templates: PromptTemplate[];
  diagnosticsEntries: DiagnosticsEntry[];
  activeModal: ModalKind;
  ollamaState: OllamaConnectionState;
  models: ModelOption[];
  selectedModel: string | null;
  conversationId: string | null;
  conversations: ConversationListItem[];
  messages: ConversationMessage[];
  turnStatus: TurnStatus;
  pendingFirstMessage: string | null;
  errorMessage: string | null;
  stagedWorkspaces: WorkspaceInfo[];
  activeWorkspaceSet: WorkspaceSet | null;
  stagedInternetEnabled: boolean;
  activeInternetEnabled: boolean;
  toolActivity: ToolCallRecord[];
  conversationAttachments: AttachmentInfo[];
  pendingMessageAttachments: AttachmentInfo[];
  stagedAttachmentFiles: { tempId: string; file: File; scope: "conversation" | "message" }[];
  controllerStatus: "connecting" | "connected" | "disconnected";
}

type Action =
  | { kind: "bootstrap"; payload: BootstrapPayload }
  | { kind: "select_model"; model: string }
  | { kind: "controller_event"; event: ControllerEvent }
  | { kind: "queue_new_conversation"; text: string }
  | { kind: "set_conversations"; conversations: ConversationListItem[] }
  | { kind: "hydrate_conversation"; conversation: Conversation }
  | { kind: "start_new_conversation" }
  | { kind: "clear_pending_message" }
  | { kind: "add_staged_workspace"; workspace: WorkspaceInfo }
  | { kind: "remove_staged_workspace"; path: string }
  | { kind: "set_staged_internet_enabled"; enabled: boolean }
  | { kind: "start_turn" }
  | { kind: "add_conversation_attachment"; attachment: AttachmentInfo }
  | { kind: "remove_conversation_attachment"; id: string }
  | { kind: "add_pending_message_attachment"; attachment: AttachmentInfo }
  | { kind: "remove_pending_message_attachment"; id: string }
  | { kind: "clear_pending_message_attachments" }
  | { kind: "add_staged_attachment_file"; tempId: string; file: File; scope: "conversation" | "message" }
  | { kind: "remove_staged_attachment_file"; tempId: string }
  | { kind: "clear_staged_attachment_files" }
  | { kind: "set_preferences"; preferences: AppPreferences }
  | { kind: "set_diagnostics"; entries: DiagnosticsEntry[] }
  | { kind: "open_modal"; modal: ModalKind }
  | { kind: "close_modal" }
  | { kind: "set_controller_status"; status: ConnectionStatus };

function initialState(): AppState {
  return {
    ollamaState: "starting",
    models: [],
    selectedModel: null,
    conversationId: null,
    conversations: [],
    messages: [],
    turnStatus: "idle",
    pendingFirstMessage: null,
    errorMessage: null,
    stagedWorkspaces: [],
    activeWorkspaceSet: null,
    stagedInternetEnabled: false,
    activeInternetEnabled: false,
    toolActivity: [],
    conversationAttachments: [],
    pendingMessageAttachments: [],
    stagedAttachmentFiles: [],
    preferences: { theme: "system", defaultModel: null, dataDir: "", systemPrompt: "" },
    templates: [],
    diagnosticsEntries: [],
    activeModal: null,
    controllerStatus: "connecting",
  };
}

function reducer(state: AppState, action: Action): AppState {
  switch (action.kind) {
    case "bootstrap":
      return {
        ...state,
        ollamaState: action.payload.ollamaState,
        models: action.payload.installedModels,
        selectedModel:
          state.selectedModel ??
          action.payload.preferences.defaultModel ??
          action.payload.installedModels[0]?.name ??
          null,
        preferences: action.payload.preferences,
        templates: action.payload.templates,
        diagnosticsEntries: action.payload.diagnostics,
      };
    case "select_model":
      return { ...state, selectedModel: action.model };
    case "queue_new_conversation":
      return { ...state, pendingFirstMessage: action.text };
    case "set_conversations":
      return { ...state, conversations: action.conversations };
    case "hydrate_conversation":
      return {
        ...state,
        conversationId: action.conversation.id,
        selectedModel: action.conversation.model,
        messages: action.conversation.messages,
        turnStatus: action.conversation.turnStatus,
        pendingFirstMessage: null,
        activeWorkspaceSet: action.conversation.workspaceSet,
        activeInternetEnabled: action.conversation.internetEnabled,
        toolActivity: lastAssistantToolCalls(action.conversation.messages),
        conversationAttachments: action.conversation.attachments,
        pendingMessageAttachments: action.conversation.pendingMessageAttachments ?? [],
        errorMessage: null,
        stagedAttachmentFiles: [],
      };
    case "start_new_conversation":
      return {
        ...state,
        conversationId: null,
        messages: [],
        turnStatus: "idle",
        errorMessage: null,
        pendingFirstMessage: null,
        activeWorkspaceSet: null,
        activeInternetEnabled: false,
        toolActivity: [],
        conversationAttachments: [],
        pendingMessageAttachments: [],
        stagedAttachmentFiles: [],
      };
    case "clear_pending_message":
      return { ...state, pendingFirstMessage: null };
    case "add_staged_workspace":
      if (state.stagedWorkspaces.some((w) => w.path === action.workspace.path)) return state;
      return { ...state, stagedWorkspaces: [...state.stagedWorkspaces, action.workspace] };
    case "remove_staged_workspace":
      return { ...state, stagedWorkspaces: state.stagedWorkspaces.filter((w) => w.path !== action.path) };
    case "set_staged_internet_enabled":
      return { ...state, stagedInternetEnabled: action.enabled };
    case "start_turn":
      return { ...state, toolActivity: [], errorMessage: null, turnStatus: "running" };
    case "add_conversation_attachment":
      return { ...state, conversationAttachments: [...state.conversationAttachments, action.attachment] };
    case "remove_conversation_attachment":
      return {
        ...state,
        conversationAttachments: state.conversationAttachments.filter((a) => a.id !== action.id),
      };
    case "add_pending_message_attachment":
      return { ...state, pendingMessageAttachments: [...state.pendingMessageAttachments, action.attachment] };
    case "remove_pending_message_attachment":
      return {
        ...state,
        pendingMessageAttachments: state.pendingMessageAttachments.filter((a) => a.id !== action.id),
      };
    case "clear_pending_message_attachments":
      return { ...state, pendingMessageAttachments: [] };
    case "add_staged_attachment_file":
      return {
        ...state,
        stagedAttachmentFiles: [...state.stagedAttachmentFiles, { tempId: action.tempId, file: action.file, scope: action.scope }],
      };
    case "remove_staged_attachment_file":
      return {
        ...state,
        stagedAttachmentFiles: state.stagedAttachmentFiles.filter((f) => f.tempId !== action.tempId),
      };
    case "clear_staged_attachment_files":
      return { ...state, stagedAttachmentFiles: [] };
    case "set_preferences":
      return { ...state, preferences: action.preferences };
    case "set_diagnostics":
      return { ...state, diagnosticsEntries: action.entries };
    case "open_modal":
      return { ...state, activeModal: action.modal };
    case "close_modal":
      return { ...state, activeModal: null };
    case "set_controller_status":
      return {
        ...state,
        controllerStatus: action.status === "open" ? "connected" : action.status === "connecting" ? "connecting" : "disconnected",
      };
    case "controller_event":
      return applyEvent(state, action.event);
  }
}

function lastAssistantToolCalls(messages: ConversationMessage[]): ToolCallRecord[] {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "assistant") return messages[i].toolCalls ?? [];
  }
  return [];
}

function applyEvent(state: AppState, event: ControllerEvent): AppState {
  switch (event.type) {
    case "connection":
      return { ...state, ollamaState: event.state };
    case "conversation_created":
      return {
        ...state,
        conversationId: event.conversation.id,
        messages: event.conversation.messages,
        turnStatus: event.conversation.turnStatus,
        activeWorkspaceSet: event.conversation.workspaceSet,
        activeInternetEnabled: event.conversation.internetEnabled,
        conversationAttachments: event.conversation.attachments,
      };
    case "conversation_loaded":
      if (event.conversation.id !== state.conversationId) return state;
      return {
        ...state,
        messages: event.conversation.messages,
        turnStatus: event.conversation.turnStatus,
        activeWorkspaceSet: event.conversation.workspaceSet,
        activeInternetEnabled: event.conversation.internetEnabled,
        conversationAttachments: event.conversation.attachments,
      };
    case "turn_state":
      if (event.conversationId !== state.conversationId) return state;
      return {
        ...state,
        turnStatus: event.status,
        errorMessage: event.status === "failed" ? (event.detail ?? "The turn failed.") : state.errorMessage,
      };
    case "message": {
      if (event.conversationId !== state.conversationId) return state;
      const withoutStreaming = state.messages.filter((m) => m.id !== event.message.id);
      return {
        ...state, messages: [...withoutStreaming, event.message],
        pendingMessageAttachments: event.message.role === "user"
          ? state.pendingMessageAttachments.filter((a) => !event.message.attachments?.some((sent) => sent.id === a.id))
          : state.pendingMessageAttachments,
      };
    }
    case "message_delta": {
      if (event.conversationId !== state.conversationId) return state;
      const existing = state.messages.find((m) => m.id === event.messageId);
      if (existing) {
        return {
          ...state,
          messages: state.messages.map((m) =>
            m.id === event.messageId ? { ...m, text: m.text + event.delta, streaming: true } : m,
          ),
        };
      }
      const draft: ConversationMessage = {
        id: event.messageId,
        role: "assistant",
        text: event.delta,
        createdAt: Date.now(),
        streaming: true,
      };
      return { ...state, messages: [...state.messages, draft] };
    }
    case "tool_call_started": {
      if (event.conversationId !== state.conversationId) return state;
      const pending: ToolCallRecord = { ...event.call, result: "" };
      return { ...state, toolActivity: [...state.toolActivity, pending] };
    }
    case "tool_call_completed": {
      if (event.conversationId !== state.conversationId) return state;
      const exists = state.toolActivity.some((c) => c.id === event.call.id);
      return {
        ...state,
        toolActivity: exists
          ? state.toolActivity.map((c) => (c.id === event.call.id ? event.call : c))
          : [...state.toolActivity, event.call],
      };
    }
    case "conversation_renamed":
      return {
        ...state,
        conversations: state.conversations.map((c) =>
          c.id === event.conversationId ? { ...c, title: event.title } : c,
        ),
      };
    case "diagnostic": {
      const entry: DiagnosticsEntry = { level: event.level, message: event.message, detail: event.detail, at: Date.now() };
      return {
        ...state,
        errorMessage: event.level === "error" ? event.message : state.errorMessage,
        diagnosticsEntries: [entry, ...state.diagnosticsEntries],
      };
    }
  }
}

function connectionTone(state: OllamaConnectionState): StatusTone {
  if (state === "ready") return "success";
  if (state === "unavailable" || state === "model-missing") return "error";
  return "neutral";
}

function connectionLabel(state: OllamaConnectionState): string {
  switch (state) {
    case "ready":
      return "Ollama: ready";
    case "unavailable":
      return "Ollama: unavailable";
    case "model-missing":
      return "Ollama: model missing";
    default:
      return "Ollama: starting";
  }
}

function controllerStatusTone(status: AppState["controllerStatus"]): StatusTone {
  if (status === "connected") return "success";
  if (status === "disconnected") return "error";
  return "neutral";
}

function controllerStatusLabel(status: AppState["controllerStatus"]): string {
  if (status === "connected") return "App: connected";
  if (status === "disconnected") return "App: reconnecting…";
  return "App: connecting…";
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.4)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          boxShadow: "var(--shadow)",
          width: "min(520px, 90vw)",
          maxHeight: "80vh",
          overflowY: "auto",
          padding: 20,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <h2 style={{ fontSize: 14, margin: 0 }}>{title}</h2>
          <button type="button" className="icon-button" onClick={onClose}>
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function ImagePreview({ attachment, file }: { attachment?: AttachmentInfo; file?: File }) {
  const [localUrl, setLocalUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file || !(file.type.startsWith("image/") || /\.(jpe?g|png)$/i.test(file.name))) return;
    const url = URL.createObjectURL(file);
    setLocalUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  const src = attachment?.kind === "image" ? `/api/attachments/${attachment.id}/raw` : localUrl;
  if (!src) return null;
  return <a href={src} target="_blank" rel="noreferrer"><img className="attachment-preview" src={src} alt={attachment?.fileName ?? file?.name ?? "Attached image"} /></a>;
}

const RECOVERY_BASE_DELAY_MS = 1000;
const RECOVERY_MAX_DELAY_MS = 8000;

export function App() {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const socketRef = useRef<ControllerSocket | null>(null);
  const conversationIdRef = useRef<string | null>(null);
  const recoveryInFlightRef = useRef(false);
  const [draft, setDraft] = useState("");
  const sendingRef = useRef(false);
  const uploadCountRef = useRef(0);
  const [submitting, setSubmitting] = useState(false);
  const [uploadCount, setUploadCount] = useState(0);
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const [renamingConversationId, setRenamingConversationId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [systemPromptDraft, setSystemPromptDraft] = useState(state.preferences.systemPrompt);
  const messageAttachInputRef = useRef<HTMLInputElement | null>(null);
  const conversationAttachInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    conversationIdRef.current = state.conversationId;
  }, [state.conversationId]);

  // Visible even when this tab isn't focused (tab bar / Dock), so a long
  // response finishing doesn't go unnoticed just because you tabbed away.
  useEffect(() => {
    document.title = state.turnStatus === "running" ? "● Working… — Ollama Local Workspace" : "Ollama Local Workspace";
  }, [state.turnStatus]);

  useEffect(() => {
    const theme = state.preferences.theme;
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }, [state.preferences.theme]);

  useEffect(() => {
    setSystemPromptDraft(state.preferences.systemPrompt);
  }, [state.preferences.systemPrompt]);

  // Retries GET /api/bootstrap with backoff until it succeeds. This both
  // refreshes the session cookie (needed after the controller restarts —
  // each launch issues a fresh per-launch token) and repopulates models/
  // preferences. The WebSocket's own reconnect loop naturally succeeds once
  // this cookie is valid again, with no explicit coordination needed.
  async function recoverSession(): Promise<void> {
    if (recoveryInFlightRef.current) return;
    recoveryInFlightRef.current = true;
    try {
      let attempt = 0;
      for (;;) {
        try {
          const res = await fetch("/api/bootstrap", { credentials: "same-origin" });
          if (res.ok) {
            const payload = (await res.json()) as BootstrapPayload;
            dispatch({ kind: "bootstrap", payload });
            return;
          }
        } catch {
          // network error (server not up yet) — fall through to retry
        }
        const delay = Math.min(RECOVERY_BASE_DELAY_MS * 2 ** attempt, RECOVERY_MAX_DELAY_MS);
        attempt += 1;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    } finally {
      recoveryInFlightRef.current = false;
    }
  }

  // Wraps every authenticated API call: a 401 means the session died (the
  // controller restarted since this tab last loaded) — kick off recovery
  // instead of letting the caller parse a mismatched error body silently.
  async function callApi(path: string, init?: RequestInit): Promise<Response> {
    const res = await fetch(path, { credentials: "same-origin", ...init });
    if (res.status === 401) {
      void recoverSession();
    }
    return res;
  }

  async function updatePreferences(patch: Partial<Pick<AppPreferences, "theme" | "defaultModel" | "systemPrompt">>) {
    dispatch({ kind: "set_preferences", preferences: { ...state.preferences, ...patch } });
    const res = await callApi("/api/preferences", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (res.ok) {
      const updated = (await res.json()) as AppPreferences;
      dispatch({ kind: "set_preferences", preferences: updated });
    }
  }

  async function refreshDiagnostics() {
    const res = await callApi("/api/diagnostics/report");
    if (!res.ok) return;
    const body = (await res.json()) as { ollamaState: OllamaConnectionState; entries: DiagnosticsEntry[] };
    dispatch({ kind: "set_diagnostics", entries: body.entries });
    dispatch({ kind: "controller_event", event: { type: "connection", state: body.ollamaState } });
  }

  async function refreshConversationList(): Promise<ConversationListItem[]> {
    const res = await callApi("/api/conversations");
    if (!res.ok) return state.conversations;
    const list = (await res.json()) as ConversationListItem[];
    dispatch({ kind: "set_conversations", conversations: list });
    return list;
  }

  async function hydrateConversation(id: string) {
    const res = await callApi(`/api/conversations/${id}`);
    if (!res.ok) return;
    const conversation = (await res.json()) as Conversation;
    dispatch({ kind: "hydrate_conversation", conversation });
  }

  useEffect(() => {
    let cancelled = false;

    async function boot() {
      const res = await fetch("/api/bootstrap", { credentials: "same-origin" });
      const payload = (await res.json()) as BootstrapPayload;
      if (cancelled) return;
      dispatch({ kind: "bootstrap", payload });

      const socket = new ControllerSocket();
      socket.onStatusChange((status) => {
        dispatch({ kind: "set_controller_status", status });
        if (status === "open") {
          // Runs on the very first connect AND every reconnect — resyncing
          // here covers "just booted" and "just recovered" with one path.
          void refreshConversationList();
          if (conversationIdRef.current) void hydrateConversation(conversationIdRef.current);
        } else if (status === "closed") {
          void recoverSession();
        }
      });
      socket.onEvent((event) => {
        dispatch({ kind: "controller_event", event });
        if (
          event.type === "conversation_created" ||
          (event.type === "turn_state" && event.status !== "running")
        ) {
          void refreshConversationList();
        }
      });
      socket.connect();
      socketRef.current = socket;

      // Deliberately does not auto-hydrate the most recent conversation —
      // the app starts on a blank conversation by default; past conversations
      // stay listed in the sidebar for the user to open when they choose to.
      await refreshConversationList();
    }

    void boot();
    return () => {
      cancelled = true;
    };
  }, []);

  // Creation must finish before uploading staged files; uploads must finish before inference.
  useEffect(() => {
    if (!state.conversationId || !state.pendingFirstMessage) return;
    void sendWithAttachments(state.conversationId, state.pendingFirstMessage);
  }, [state.conversationId]);

  const selectedModelOption = useMemo(
    () => state.models.find((m) => m.name === state.selectedModel) ?? null,
    [state.models, state.selectedModel],
  );

  const isRunning = state.turnStatus === "running";
  const isConnected = state.controllerStatus === "connected";
  const busy = isRunning || submitting || uploadCount > 0;
  const relevantAttachments = [...state.conversationAttachments, ...state.pendingMessageAttachments,
    ...state.messages.flatMap((m) => m.attachments ?? [])];
  const hasImages = relevantAttachments.some((a) => a.kind === "image") || state.stagedAttachmentFiles.some(
    ({ file }) => file.type.startsWith("image/") || /\.(jpe?g|png|gif|webp|svg|bmp|heic|avif)$/i.test(file.name));
  const visionBlocked = hasImages && !selectedModelOption?.supportsVision;
  const canSend = Boolean(state.selectedModel) && state.ollamaState === "ready" && isConnected &&
    draft.trim().length > 0 && !busy && !visionBlocked;

  async function sendWithAttachments(conversationId: string, text: string) {
    try {
      const ids = state.pendingMessageAttachments.map((a) => a.id);
      for (const staged of state.stagedAttachmentFiles) {
        const attachment = await uploadAttachment(staged.file, conversationId, staged.scope);
        dispatch({ kind: staged.scope === "message" ? "add_pending_message_attachment" : "add_conversation_attachment", attachment });
        if (staged.scope === "message") ids.push(attachment.id);
        dispatch({ kind: "remove_staged_attachment_file", tempId: staged.tempId });
      }
      if (!socketRef.current?.send({ type: "send_message", conversationId, text, messageAttachmentIds: ids })) {
        throw new Error("The app disconnected. Your attachments are saved; reconnect and send again.");
      }
      dispatch({ kind: "start_turn" });
      setDraft("");
    } catch (err) {
      reportWorkspaceError(err instanceof Error ? err.message : "Unable to send attached files");
    } finally {
      dispatch({ kind: "clear_pending_message" });
      sendingRef.current = false;
      setSubmitting(false);
    }
  }

  function handleSend() {
    if (!canSend || sendingRef.current || uploadCountRef.current > 0 || !state.selectedModel) return;
    const text = draft.trim();
    sendingRef.current = true;
    setSubmitting(true);
    if (!state.conversationId) {
      const [primary, ...linked] = state.stagedWorkspaces;
      const sent = socketRef.current?.send({ type: "new_conversation", model: state.selectedModel,
        workspaceSet: primary ? { primary, linked } : null, internetEnabled: state.stagedInternetEnabled });
      if (!sent) {
        sendingRef.current = false;
        setSubmitting(false);
        reportWorkspaceError("The app disconnected. Reconnect and send again.");
        return;
      }
      dispatch({ kind: "queue_new_conversation", text });
    } else {
      void sendWithAttachments(state.conversationId, text);
    }
  }

  async function uploadAttachment(file: File, conversationId: string, scope: "conversation" | "message"): Promise<AttachmentInfo> {
    const form = new FormData();
    form.append("file", file);
    form.append("conversationId", conversationId);
    form.append("scope", scope);
    const res = await callApi("/api/attachments", { method: "POST", body: form });
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { detail?: string };
      throw new Error(err.detail ?? "Attachment rejected");
    }
    return await res.json() as AttachmentInfo;
  }

  async function addAttachment(file: File, scope: "conversation" | "message") {
    if (busy || sendingRef.current || uploadCountRef.current) return;
    if (!state.conversationId) {
      dispatch({ kind: "add_staged_attachment_file", tempId: crypto.randomUUID(), file, scope });
      return;
    }
    const conversationId = state.conversationId;
    uploadCountRef.current += 1;
    setUploadCount(uploadCountRef.current);
    try {
      const attachment = await uploadAttachment(file, conversationId, scope);
      if (conversationIdRef.current === conversationId) {
        dispatch({ kind: scope === "message" ? "add_pending_message_attachment" : "add_conversation_attachment", attachment });
      }
    } catch (err) {
      reportWorkspaceError(err instanceof Error ? err.message : "Attachment upload failed");
    } finally {
      uploadCountRef.current -= 1;
      setUploadCount(uploadCountRef.current);
    }
  }

  async function removeAttachment(id: string) {
    if (busy || uploadCountRef.current || sendingRef.current) return;
    uploadCountRef.current += 1;
    setUploadCount(uploadCountRef.current);
    try {
      const res = await callApi(`/api/attachments/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to remove attachment");
      dispatch({ kind: "remove_conversation_attachment", id });
      dispatch({ kind: "remove_pending_message_attachment", id });
      if (state.messages.some((m) => m.attachments?.some((a) => a.id === id)) && state.conversationId) {
        await hydrateConversation(state.conversationId);
      }
    } catch (err) {
      reportWorkspaceError(err instanceof Error ? err.message : "Failed to remove attachment");
    } finally {
      uploadCountRef.current -= 1;
      setUploadCount(uploadCountRef.current);
    }
  }

  function reportWorkspaceError(message: string) {
    dispatch({ kind: "controller_event", event: { type: "diagnostic", level: "error", message } });
  }

  async function handleAddWorkspace() {
    if (workspaceBusy) return;
    setWorkspaceBusy(true);
    try {
      const res = await callApi("/api/workspaces/pick", { method: "POST" });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { detail?: string };
        reportWorkspaceError(err.detail ?? "Failed to open the folder picker");
        return;
      }
      const body = (await res.json()) as { cancelled: boolean; workspace?: WorkspaceInfo };
      if (!body.cancelled && body.workspace) {
        dispatch({ kind: "add_staged_workspace", workspace: body.workspace });
      }
    } catch (err) {
      reportWorkspaceError(err instanceof Error ? err.message : "Failed to open the folder picker");
    } finally {
      setWorkspaceBusy(false);
    }
  }

  function handleInterrupt() {
    if (state.conversationId) {
      socketRef.current?.send({ type: "interrupt_turn", conversationId: state.conversationId });
    }
  }

  function handleModelChange(model: string) {
    if (busy || sendingRef.current || uploadCountRef.current) return;
    dispatch({ kind: "select_model", model });
    if (state.conversationId) {
      socketRef.current?.send({ type: "switch_model", conversationId: state.conversationId, model });
    }
  }

  function handleSelectConversation(id: string) {
    if (busy || sendingRef.current || uploadCountRef.current) return;
    setDraft("");
    if (id !== state.conversationId) void hydrateConversation(id);
  }

  async function handleDeleteConversation(id: string, title: string) {
    if (busy) return;
    if (!window.confirm(`Permanently delete "${title}"? This cannot be undone.`)) return;
    const res = await callApi(`/api/conversations/${id}`, { method: "DELETE" });
    if (!res.ok) {
      dispatch({
        kind: "controller_event",
        event: { type: "diagnostic", level: "error", message: "Failed to delete conversation" },
      });
      return;
    }
    if (id === state.conversationId) {
      dispatch({ kind: "start_new_conversation" });
    }
    void refreshConversationList();
  }

  function handleStartRename(id: string, currentTitle: string) {
    setRenamingConversationId(id);
    setRenameDraft(currentTitle);
  }

  async function handleCommitRename() {
    const id = renamingConversationId;
    const title = renameDraft.trim();
    setRenamingConversationId(null);
    if (!id || !title) return;
    const res = await callApi(`/api/conversations/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    });
    if (res.ok) {
      void refreshConversationList();
    } else {
      dispatch({
        kind: "controller_event",
        event: { type: "diagnostic", level: "error", message: "Failed to rename conversation" },
      });
    }
  }

  function handleUseTemplate(template: PromptTemplate) {
    setDraft(template.body);
    dispatch({ kind: "close_modal" });
  }

  async function handleOpenDataDir() {
    const res = await callApi("/api/data-dir/reveal", { method: "POST" });
    if (!res.ok) {
      dispatch({
        kind: "controller_event",
        event: { type: "diagnostic", level: "error", message: "Failed to open the data folder" },
      });
    }
  }

  return (
    <div className="app-shell">
      <aside className="rail app-shell__left-rail">
        <div className="wordmark">
          <span className="wordmark__mark" aria-hidden="true" />
          Ollama Local Workspace
        </div>

        <div style={{ display: "flex", gap: 6, padding: "8px 16px", borderBottom: "1px solid var(--border)" }}>
          <button
            type="button"
            className="icon-button icon-button--square"
            title="Templates"
            aria-label="Templates"
            onClick={() => dispatch({ kind: "open_modal", modal: "templates" })}
          >
            T
          </button>
          <button
            type="button"
            className="icon-button icon-button--square"
            title="Settings"
            aria-label="Settings"
            onClick={() => dispatch({ kind: "open_modal", modal: "settings" })}
          >
            S
          </button>
          <button
            type="button"
            className="icon-button icon-button--square"
            title="Diagnostics"
            aria-label="Diagnostics"
            onClick={() => {
              dispatch({ kind: "open_modal", modal: "diagnostics" });
              void refreshDiagnostics();
            }}
          >
            D
          </button>
        </div>

        <div className="rail-section">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <p className="rail-section__title">Workspaces</p>
            <button
              type="button"
              className="icon-button"
              disabled={workspaceBusy || !isConnected}
              onClick={() => void handleAddWorkspace()}
            >
              {workspaceBusy ? "…" : "Add"}
            </button>
          </div>
          {state.stagedWorkspaces.length === 0 && (
            <p className="empty-hint">No workspace attached yet. New conversations start read-only.</p>
          )}
          {state.stagedWorkspaces.map((w, i) => (
            <div key={w.path} className="list-row">
              <span>
                <span className="accent-dot" style={{ display: "inline-block", marginRight: 6 }} />
                {w.displayName}
                {i === 0 ? " (primary)" : ""}
              </span>
              <button
                type="button"
                className="icon-button"
                onClick={() => dispatch({ kind: "remove_staged_workspace", path: w.path })}
              >
                ×
              </button>
            </div>
          ))}
          <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8, fontSize: 13 }}>
            <input
              type="checkbox"
              checked={state.stagedInternetEnabled}
              onChange={(e) => dispatch({ kind: "set_staged_internet_enabled", enabled: e.target.checked })}
            />
            Allow internet access for this conversation
          </label>
        </div>

        <div className="rail-section">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <p className="rail-section__title">Attachments</p>
            <input
              ref={conversationAttachInputRef}
              type="file"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void addAttachment(file, "conversation");
                e.target.value = "";
              }}
            />
            <button
              type="button"
              className="icon-button"
              disabled={!isConnected || busy}
              title="Attach a file — to this conversation, or staged for the next one you start"
              onClick={() => conversationAttachInputRef.current?.click()}
            >
              Add
            </button>
          </div>
          {state.conversationAttachments.length === 0 && state.stagedAttachmentFiles.length === 0 && (
            <p className="empty-hint">No attachments.</p>
          )}
          {state.stagedAttachmentFiles.map((f) => (
            <div key={f.tempId} className="attachment-chip">
              <ImagePreview file={f.file} /><span className="type-badge">{f.scope === "message" ? "next message" : "pending"}</span>
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {f.file.name}
              </span>
              <span className="list-row__meta">{formatBytes(f.file.size)}</span>
              <button
                type="button"
                className="icon-button"
                disabled={busy}
                onClick={() => dispatch({ kind: "remove_staged_attachment_file", tempId: f.tempId })}
              >
                ×
              </button>
            </div>
          ))}
          {state.conversationAttachments.map((a) => (
            <div key={a.id} className="attachment-chip">
              <ImagePreview attachment={a} /><span className="type-badge">{a.kind}</span>
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {a.fileName}
                {a.kind === "image" && !selectedModelOption?.supportsVision && " — select a vision model"}
                {a.kind === "unsupported" && " — unsupported type"}
              </span>
              <span className="list-row__meta">{formatBytes(a.sizeBytes)}</span>
              <button
                type="button"
                className="icon-button"
                disabled={busy} onClick={() => void removeAttachment(a.id)}
              >
                ×
              </button>
            </div>
          ))}
        </div>

        <div className="rail-section rail-section--scrollable">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <p className="rail-section__title">Conversations</p>
            <button type="button" className="icon-button" disabled={busy} onClick={() => { setDraft(""); dispatch({ kind: "start_new_conversation" }); }}>
              New
            </button>
          </div>
          {state.conversations.length === 0 && (
            <p className="empty-hint">Start a new conversation to see it here.</p>
          )}
          {state.conversations.map((c) => (
            <div
              key={c.id}
              className={`list-row${c.id === state.conversationId ? " list-row--active" : ""}`}
              role="button"
              tabIndex={0}
              onClick={() => handleSelectConversation(c.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSelectConversation(c.id);
              }}
              style={{ cursor: "pointer" }}
            >
              {renamingConversationId === c.id ? (
                <input
                  autoFocus
                  value={renameDraft}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onBlur={() => void handleCommitRename()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleCommitRename();
                    if (e.key === "Escape") setRenamingConversationId(null);
                  }}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: 13,
                    padding: "2px 4px",
                    borderRadius: 4,
                    border: "1px solid var(--border-strong)",
                    background: "var(--surface)",
                    color: "var(--text)",
                  }}
                />
              ) : (
                <span
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    handleStartRename(c.id, c.title);
                  }}
                  title={`${c.title}\nDouble-click to rename`}
                  style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                >
                  {c.title}
                </span>
              )}
              <span className="list-row__meta">{relativeTime(c.updatedAt)}</span>
              <button
                type="button"
                className="icon-button"
                title="Delete this conversation"
                onClick={(e) => {
                  e.stopPropagation();
                  void handleDeleteConversation(c.id, c.title);
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>

        <div className="rail-footer">
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <StatusPill
              tone={connectionTone(state.ollamaState)}
              label={connectionLabel(state.ollamaState)}
              pulse={isRunning}
            />
            <StatusPill
              tone={controllerStatusTone(state.controllerStatus)}
              label={controllerStatusLabel(state.controllerStatus)}
              pulse={state.controllerStatus !== "connected"}
            />
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={() => void updatePreferences({ theme: cycleTheme(state.preferences.theme) })}
            title="Cycle theme (system / light / dark)"
          >
            {state.preferences.theme}
          </button>
        </div>
      </aside>

      <main className="app-shell__center">
        <div className="telemetry-strip">
          <select
            value={state.selectedModel ?? ""}
            onChange={(e) => handleModelChange(e.target.value)}
            aria-label="Model" disabled={state.models.length === 0 || busy}
          >
            {state.models.length === 0 && <option value="">No models installed</option>}
            {state.models.map((m) => (
              <option key={m.name} value={m.name}>
                {m.alias ? `${m.alias} (${m.name})` : m.name}{m.supportsVision ? " — Vision" : ""}
              </option>
            ))}
          </select>
          <StatusPill tone={isRunning ? "success" : "neutral"} label={isRunning ? "Working…" : "Idle"} pulse={isRunning} />
          <span className="tabular">{selectedModelOption?.supportsTools ? "tools: on" : "tools: off"}</span>
          <span className="tabular">{selectedModelOption?.supportsVision ? "Vision supported" : selectedModelOption?.capabilitiesKnown ? "Text only" : "Vision capability unknown"}</span>
          <span className="tabular">budget: {state.toolActivity.length}/8</span>
          <span>{state.activeWorkspaceSet ? state.activeWorkspaceSet.primary.displayName : "No workspace"}</span>
          {state.activeInternetEnabled && <span className="tabular">Internet: on</span>}
        </div>

        <div className="message-stream">
          {state.messages.length === 0 && (
            <p className="empty-hint">No messages yet. Pick a model and send one to get started.</p>
          )}
          {state.messages.map((m) =>
            m.role === "user" ? (
              <div key={m.id} className="bubble bubble--user">
                {m.text}
                {m.attachments?.map((a) => <div className="attachment-chip" key={a.id}>
                  <ImagePreview attachment={a} /><span>{a.fileName}</span>
                  <button type="button" className="icon-button" disabled={busy} onClick={() => void removeAttachment(a.id)} aria-label={`Remove ${a.fileName}`}>×</button>
                </div>)}
              </div>
            ) : (
              <div key={m.id} className="bubble bubble--assistant">
                {m.text ? (
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.text}</ReactMarkdown>
                ) : m.streaming ? (
                  "…"
                ) : (
                  ""
                )}
              </div>
            ),
          )}
          {state.errorMessage && <div className="bubble bubble--assistant">Error: {state.errorMessage}</div>}
        </div>

        <div className="composer">
          {state.pendingMessageAttachments.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
              {state.pendingMessageAttachments.map((a) => (
                <span key={a.id} className="attachment-chip" style={{ borderBottom: "none", padding: "2px 8px", background: "var(--surface-raised)", borderRadius: 6 }}>
                  <ImagePreview attachment={a} /><span className="type-badge">{a.kind}</span>
                  {a.fileName}
                  <button
                    type="button"
                    className="icon-button"
                    disabled={busy} onClick={() => void removeAttachment(a.id)}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="composer__row">
            <input
              ref={messageAttachInputRef}
              type="file"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void addAttachment(file, "message");
                e.target.value = "";
              }}
            />
            <button
              type="button"
              className="icon-button"
              disabled={!isConnected || busy}
              title="Attach a file to this message"
              onClick={() => messageAttachInputRef.current?.click()}
            >
              +
            </button>
            <textarea
              placeholder="Send a message…"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (canSend) handleSend();
                }
              }}
              disabled={state.ollamaState !== "ready" || !isConnected || submitting}
            />
            {isRunning ? (
              <button type="button" className="btn" onClick={handleInterrupt}>
                Stop
              </button>
            ) : (
              <button type="button" className="btn btn--primary" onClick={handleSend} disabled={!canSend}>
                Send
              </button>
            )}
          </div>
          {visionBlocked && <p className="composer__hint" role="alert">
            {selectedModelOption?.capabilitiesKnown ? "This model cannot read images." : "Vision capability could not be confirmed."}
            {" Select a vision-capable model or remove the attached images before sending."}
          </p>}
          {(uploadCount > 0 || submitting) && <p className="composer__hint" role="status">Preparing attachments…</p>}
          <p className="composer__hint">
            Read-only — this model cannot modify files in this workspace.
            {state.activeInternetEnabled && " This model may fetch content from the internet."}
          </p>
        </div>
      </main>

      <aside className="rail app-shell__right-rail">
        <div className="rail-section">
          <p className="rail-section__title">Activity — this turn</p>
          {state.toolActivity.length === 0 && <p className="empty-hint">No tool calls yet.</p>}
          {state.toolActivity.map((call) => (
            <div key={call.id} className="activity-entry">
              <span>
                <strong>{call.name}</strong>{" "}
                {typeof call.args.path === "string"
                  ? call.args.path
                  : typeof call.args.query === "string"
                    ? `"${call.args.query}"`
                    : ""}
              </span>
              <span className="list-row__meta">{call.result ? `${call.result.length}B` : "…"}</span>
            </div>
          ))}
        </div>
      </aside>

      {state.activeModal === "templates" && (
        <Modal title="Templates" onClose={() => dispatch({ kind: "close_modal" })}>
          {state.templates.map((t) => (
            <div key={t.id} className="list-row" style={{ alignItems: "flex-start", flexDirection: "column", gap: 4 }}>
              <div style={{ display: "flex", width: "100%", justifyContent: "space-between", alignItems: "center" }}>
                <strong>{t.name}</strong>
                <button type="button" className="btn" onClick={() => handleUseTemplate(t)}>
                  Use
                </button>
              </div>
              <p className="empty-hint" style={{ margin: 0 }}>
                {t.description}
              </p>
            </div>
          ))}
        </Modal>
      )}

      {state.activeModal === "settings" && (
        <Modal title="Settings" onClose={() => dispatch({ kind: "close_modal" })}>
          <div className="rail-section" style={{ padding: "8px 0" }}>
            <p className="rail-section__title">Theme</p>
            <select
              value={state.preferences.theme}
              onChange={(e) => void updatePreferences({ theme: e.target.value as ThemePreference })}
            >
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </div>
          <div className="rail-section" style={{ padding: "8px 0" }}>
            <p className="rail-section__title">Default model</p>
            <select
              value={state.preferences.defaultModel ?? ""}
              onChange={(e) => void updatePreferences({ defaultModel: e.target.value || null })}
            >
              <option value="">None</option>
              {state.models.map((m) => (
                <option key={m.name} value={m.name}>
                  {m.alias ? `${m.alias} (${m.name})` : m.name}{m.supportsVision ? " — Vision" : ""}
                </option>
              ))}
            </select>
          </div>
          <div className="rail-section" style={{ padding: "8px 0" }}>
            <p className="rail-section__title">Global system prompt</p>
            <p className="empty-hint">Always applied, to every conversation, on every message.</p>
            <textarea
              value={systemPromptDraft}
              onChange={(e) => setSystemPromptDraft(e.target.value)}
              onBlur={() => {
                if (systemPromptDraft !== state.preferences.systemPrompt) {
                  void updatePreferences({ systemPrompt: systemPromptDraft });
                }
              }}
              rows={3}
              style={{
                width: "100%",
                resize: "vertical",
                fontFamily: "inherit",
                fontSize: 13,
                padding: "6px 8px",
                borderRadius: 4,
                border: "1px solid var(--border-strong)",
                background: "var(--surface)",
                color: "var(--text)",
              }}
            />
          </div>
          <div className="rail-section" style={{ padding: "8px 0" }}>
            <p className="rail-section__title">Data directory</p>
            <p className="mono empty-hint" style={{ wordBreak: "break-all" }}>
              {state.preferences.dataDir}
            </p>
            <button type="button" className="btn" onClick={() => void handleOpenDataDir()}>
              Open data folder in Finder
            </button>
          </div>
        </Modal>
      )}

      {state.activeModal === "diagnostics" && (
        <Modal title="Diagnostics" onClose={() => dispatch({ kind: "close_modal" })}>
          <div className="rail-section" style={{ padding: "8px 0", display: "flex", gap: 12 }}>
            <StatusPill tone={connectionTone(state.ollamaState)} label={connectionLabel(state.ollamaState)} />
            <StatusPill
              tone={controllerStatusTone(state.controllerStatus)}
              label={controllerStatusLabel(state.controllerStatus)}
            />
          </div>
          <div className="rail-section" style={{ padding: "8px 0" }}>
            <p className="rail-section__title">Recent diagnostics</p>
            {state.diagnosticsEntries.length === 0 && <p className="empty-hint">No diagnostics recorded.</p>}
            {state.diagnosticsEntries.map((entry, i) => (
              <div key={i} className="activity-entry" style={{ flexDirection: "column", alignItems: "flex-start", gap: 2 }}>
                <span>
                  <StatusPill
                    tone={entry.level === "error" ? "error" : entry.level === "warning" ? "warning" : "neutral"}
                    label={entry.message}
                  />
                </span>
                {entry.detail && <span className="empty-hint">{entry.detail}</span>}
                <span className="list-row__meta">{relativeTime(entry.at)}</span>
              </div>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}
