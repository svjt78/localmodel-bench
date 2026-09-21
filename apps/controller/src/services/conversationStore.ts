import Database from "better-sqlite3";
import path from "node:path";
import type {
  AttachmentInfo,
  Conversation,
  ConversationMessage,
  ToolCallRecord,
  WorkspaceSet,
} from "@ollama-local/shared";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  model         TEXT NOT NULL,
  workspace_set_json TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  archived      INTEGER NOT NULL DEFAULT 0,
  internet_enabled INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user','assistant','system','tool')),
  text            TEXT NOT NULL,
  tool_calls_json TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS attachments (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id      TEXT REFERENCES messages(id) ON DELETE CASCADE,
  file_name       TEXT NOT NULL,
  source_path     TEXT NOT NULL,
  mime_type       TEXT NOT NULL,
  size_bytes      INTEGER NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('text','image','unsupported')),
  extracted_text  TEXT,
  stored_path     TEXT NOT NULL,
  pending         INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);
`;

interface ConversationRow {
  id: string;
  title: string;
  model: string;
  workspace_set_json: string | null;
  created_at: number;
  updated_at: number;
  archived: number;
  internet_enabled: number;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: ConversationMessage["role"];
  text: string;
  tool_calls_json: string | null;
  created_at: number;
}

export interface AttachmentRow {
  id: string;
  conversation_id: string;
  message_id: string | null;
  file_name: string;
  source_path: string;
  mime_type: string;
  size_bytes: number;
  kind: AttachmentInfo["kind"];
  extracted_text: string | null;
  stored_path: string;
  pending: number;
  created_at: number;
}

export interface ConversationSummary {
  id: string;
  title: string;
  model: string;
  workspaceSet: WorkspaceSet | null;
  internetEnabled: boolean;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
}

function rowToSummary(row: ConversationRow): ConversationSummary {
  return {
    id: row.id,
    title: row.title,
    model: row.model,
    workspaceSet: row.workspace_set_json ? (JSON.parse(row.workspace_set_json) as WorkspaceSet) : null,
    internetEnabled: row.internet_enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archived: row.archived === 1,
  };
}

function rowToMessage(row: MessageRow): ConversationMessage {
  return {
    id: row.id,
    role: row.role,
    text: row.text,
    toolCalls: row.tool_calls_json ? (JSON.parse(row.tool_calls_json) as ToolCallRecord[]) : undefined,
    createdAt: row.created_at,
  };
}

function rowToAttachment(row: AttachmentRow): AttachmentInfo {
  return {
    id: row.id,
    fileName: row.file_name,
    sourcePath: row.source_path,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    kind: row.kind,
    extractedText: row.extracted_text ?? undefined,
    scope: row.message_id || row.pending ? "message" : "conversation",
  };
}

export class ConversationStore {
  private readonly db: Database.Database;

  constructor(dataDir: string) {
    this.db = new Database(path.join(dataDir, "conversations.sqlite"));
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
    const columns = this.db.prepare("PRAGMA table_info(attachments)").all() as { name: string }[];
    if (!columns.some((column) => column.name === "pending")) {
      this.db.exec("ALTER TABLE attachments ADD COLUMN pending INTEGER NOT NULL DEFAULT 0");
    }
    // Additive migration for databases created before internet_enabled existed —
    // CREATE TABLE IF NOT EXISTS above is a no-op on an already-existing table.
    try {
      this.db.exec(`ALTER TABLE conversations ADD COLUMN internet_enabled INTEGER NOT NULL DEFAULT 0`);
    } catch {
      // column already exists — fine
    }
  }

  createConversation(input: {
    id: string;
    title: string;
    model: string;
    workspaceSet: WorkspaceSet | null;
    internetEnabled: boolean;
  }): ConversationSummary {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO conversations (id, title, model, workspace_set_json, created_at, updated_at, archived, internet_enabled)
         VALUES (@id, @title, @model, @workspaceSetJson, @now, @now, 0, @internetEnabled)`,
      )
      .run({
        id: input.id,
        title: input.title,
        model: input.model,
        workspaceSetJson: input.workspaceSet ? JSON.stringify(input.workspaceSet) : null,
        internetEnabled: input.internetEnabled ? 1 : 0,
        now,
      });
    return {
      id: input.id,
      title: input.title,
      model: input.model,
      workspaceSet: input.workspaceSet,
      internetEnabled: input.internetEnabled,
      createdAt: now,
      updatedAt: now,
      archived: false,
    };
  }

  touchConversation(id: string): void {
    this.db.prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`).run(Date.now(), id);
  }

  setConversationModel(id: string, model: string): void {
    this.db.prepare(`UPDATE conversations SET model = ?, updated_at = ? WHERE id = ?`).run(model, Date.now(), id);
  }

  renameConversation(id: string, title: string): void {
    this.db.prepare(`UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?`).run(title, Date.now(), id);
  }

  // Permanently removes the conversation. messages/attachments rows cascade
  // via the FK constraints (foreign_keys is ON) — this only ever deletes DB
  // rows, never touches a file on disk, so attachment bytes under the data
  // dir survive even though their row is gone.
  deleteConversation(id: string): void {
    this.db.prepare(`DELETE FROM conversations WHERE id = ?`).run(id);
  }

  listConversations(): ConversationSummary[] {
    const rows = this.db
      .prepare(`SELECT * FROM conversations WHERE archived = 0 ORDER BY updated_at DESC`)
      .all() as ConversationRow[];
    return rows.map(rowToSummary);
  }

  getConversation(id: string): Conversation | null {
    const row = this.db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(id) as ConversationRow | undefined;
    if (!row) return null;

    const messageRows = this.db
      .prepare(`SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC`)
      .all(id) as MessageRow[];
    const attachmentRows = this.db
      .prepare(`SELECT * FROM attachments WHERE conversation_id = ? ORDER BY created_at ASC`)
      .all(id) as AttachmentRow[];

    const summary = rowToSummary(row);
    return {
      ...summary,
      attachments: attachmentRows.filter((a) => !a.message_id && !a.pending).map(rowToAttachment),
      pendingMessageAttachments: attachmentRows.filter((a) => a.pending).map(rowToAttachment),
      messages: messageRows.map((message) => ({
        ...rowToMessage(message),
        attachments: attachmentRows.filter((a) => a.message_id === message.id).map(rowToAttachment),
      })),
      turnStatus: "idle",
    };
  }

  appendMessage(conversationId: string, message: ConversationMessage): void {
    this.db
      .prepare(
        `INSERT INTO messages (id, conversation_id, role, text, tool_calls_json, created_at)
         VALUES (@id, @conversationId, @role, @text, @toolCallsJson, @createdAt)`,
      )
      .run({
        id: message.id,
        conversationId,
        role: message.role,
        text: message.text,
        toolCallsJson: message.toolCalls ? JSON.stringify(message.toolCalls) : null,
        createdAt: message.createdAt,
      });
    this.touchConversation(conversationId);
  }

  updateMessageText(conversationId: string, messageId: string, text: string): void {
    this.db.prepare(`UPDATE messages SET text = ? WHERE id = ? AND conversation_id = ?`).run(text, messageId, conversationId);
  }

  addAttachment(input: {
    id: string;
    conversationId: string;
    messageId: string | null;
    fileName: string;
    sourcePath: string;
    mimeType: string;
    sizeBytes: number;
    kind: AttachmentInfo["kind"];
    extractedText?: string;
    storedPath: string;
    pending?: boolean;
  }): AttachmentInfo {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO attachments
           (id, conversation_id, message_id, file_name, source_path, mime_type, size_bytes, kind, extracted_text, stored_path, created_at, pending)
         VALUES (@id, @conversationId, @messageId, @fileName, @sourcePath, @mimeType, @sizeBytes, @kind, @extractedText, @storedPath, @now, @pending)`,
      )
      .run({
        id: input.id,
        conversationId: input.conversationId,
        messageId: input.messageId,
        fileName: input.fileName,
        sourcePath: input.sourcePath,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        kind: input.kind,
        extractedText: input.extractedText ?? null,
        storedPath: input.storedPath,
        pending: input.pending ? 1 : 0,
        now,
      });
    return {
      id: input.id,
      fileName: input.fileName,
      sourcePath: input.sourcePath,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      kind: input.kind,
      extractedText: input.extractedText,
      scope: input.messageId || input.pending ? "message" : "conversation",
    };
  }

  getAttachmentRow(id: string): AttachmentRow | null {
    const row = this.db.prepare(`SELECT * FROM attachments WHERE id = ?`).get(id) as AttachmentRow | undefined;
    return row ?? null;
  }

  getPendingAttachments(conversationId: string, ids: string[]): AttachmentInfo[] {
    return [...new Set(ids)].map((id) => {
      const row = this.getAttachmentRow(id);
      if (!row || row.conversation_id !== conversationId || !row.pending || row.message_id) {
        throw new Error("A message attachment is no longer available in this conversation. Attach it again.");
      }
      return rowToAttachment(row);
    });
  }

  appendUserMessage(conversationId: string, message: ConversationMessage, attachmentIds: string[]): void {
    this.db.transaction(() => {
      this.getPendingAttachments(conversationId, attachmentIds);
      this.appendMessage(conversationId, message);
      for (const id of new Set(attachmentIds)) {
        this.db.prepare(`UPDATE attachments SET message_id = ?, pending = 0 WHERE id = ? AND conversation_id = ?`)
          .run(message.id, id, conversationId);
      }
    })();
  }

  close(): void {
    this.db.close();
  }

  // Deliberately does not touch the file at stored_path — removing an
  // attachment detaches it from the conversation but never deletes the
  // app's own copy of the original bytes.
  deleteAttachment(id: string): void {
    this.db.prepare(`DELETE FROM attachments WHERE id = ?`).run(id);
  }
}
