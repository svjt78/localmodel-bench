export type PermissionMode = "read-only"; // only mode that exists in v1

export type OllamaConnectionState = "starting" | "ready" | "unavailable" | "model-missing";

export type TurnStatus = "idle" | "running" | "interrupted" | "failed" | "completed";

export interface WorkspaceInfo {
  path: string;
  displayName: string;
  isGitRepository: boolean;
  fileCount: number; // populated at validation time, capped (see workspace.ts)
  truncated: boolean; // true if fileCount hit the cap
}

export const MAX_CONVERSATION_WORKSPACES = 10;

export interface WorkspaceSet {
  primary: WorkspaceInfo;
  linked: WorkspaceInfo[]; // up to 9 (MAX_CONVERSATION_WORKSPACES = 10 total)
}

export interface AttachmentInfo {
  id: string;
  fileName: string;
  sourcePath: string; // original path on disk, for display/reveal-in-finder only
  mimeType: string;
  sizeBytes: number;
  kind: "text" | "image" | "unsupported";
  extractedText?: string; // for text/pdf/docx — populated at attach time
  scope: "conversation" | "message"; // attached to whole conversation, or one message
}

export interface ModelOption {
  name: string; // Ollama tag, e.g. "qwen3:30b-a3b-instruct-2507-q4_K_M"
  alias: string | null; // "qfast" / "qthink" / "rson" if it matches a known alias
  supportsTools: boolean; // whether tool-calling is enabled for this model
  supportsVision: boolean;
  capabilitiesKnown: boolean; // false when model capability discovery failed
  sizeBytes: number;
  family: string; // "qwen3", "deepseek-r1", etc., from `ollama show`
}

export type MessageRole = "user" | "assistant" | "system" | "tool";

export interface ConversationMessage {
  id: string;
  role: MessageRole;
  text: string;
  toolCalls?: ToolCallRecord[]; // populated on assistant messages that read files
  attachments?: AttachmentInfo[]; // message-scoped files, restored from storage
  createdAt: number;
  streaming?: boolean;
}

export interface ToolCallRecord {
  id: string;
  name: "list_directory" | "read_file" | "search_files" | "fetch_url";
  args: Record<string, unknown>;
  result: string; // truncated preview stored; full result not re-sent on reload
  workspacePath: string; // which workspace root this touched
}

export interface Conversation {
  id: string;
  title: string;
  model: string; // Ollama tag in use
  workspaceSet: WorkspaceSet | null;
  internetEnabled: boolean; // fixed at creation, like workspaceSet — never mutated afterward
  attachments: AttachmentInfo[]; // conversation-scoped attachments
  pendingMessageAttachments?: AttachmentInfo[]; // unsent draft files for this conversation only
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
  body: string; // {{variable}} interpolation
  variables: string[];
  builtIn: boolean;
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
  | { type: "conversation_renamed"; conversationId: string; title: string }
  | { type: "diagnostic"; level: "info" | "warning" | "error"; message: string; detail?: string };

export type ClientCommand =
  | { type: "new_conversation"; model: string; workspaceSet: WorkspaceSet | null; internetEnabled?: boolean }
  | { type: "send_message"; conversationId: string; text: string; messageAttachmentIds?: string[] }
  | { type: "interrupt_turn"; conversationId: string }
  | { type: "switch_model"; conversationId: string; model: string };

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
  dataDir: string; // display-only; not user-editable without a restart
  systemPrompt: string; // always-on instruction prepended to every conversation's every turn
}

export interface DiagnosticsEntry {
  level: "info" | "warning" | "error";
  message: string;
  detail?: string;
  at: number;
}
