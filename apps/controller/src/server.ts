import cookieParser from "cookie-parser";
import * as cookie from "cookie";
import express, { type NextFunction, type Request, type Response } from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import multer from "multer";
import type { Server as HttpServer, IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { BootstrapPayload } from "@ollama-local/shared";
import { checkOllamaConnection, fetchInstalledModels } from "./services/modelRegistry.js";
import type { ConversationStore } from "./services/conversationStore.js";
import type { PreferencesStore } from "./services/preferences.js";
import type { RecentWorkspacesStore } from "./services/recentWorkspaces.js";
import { validateWorkspaceDirectory, validateWorkspaceSet, resolveWithinRoots } from "./services/workspace.js";
import { pickFolder, revealInFinder, openWithDefaultApp } from "./services/nativePicker.js";
import { ingestAttachment, AttachmentError } from "./services/attachments.js";
import { BUILT_IN_TEMPLATES } from "./services/templates.js";
import type { DiagnosticsLog } from "./services/diagnosticsLog.js";

const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 25 * 1024 * 1024 } });

export const SESSION_COOKIE_NAME = "ollama_local_session";

const STATIC_DIR = path.resolve(import.meta.dirname, "../../web/dist");

export interface ServerContext {
  sessionToken: string;
  appVersion: string;
  port: number;
  store: ConversationStore;
  preferences: PreferencesStore;
  recentWorkspaces: RecentWorkspacesStore;
  diagnostics: DiagnosticsLog;
}

async function listValidRecentWorkspaces(ctx: ServerContext) {
  const results = [];
  for (const p of ctx.recentWorkspaces.list()) {
    try {
      results.push(await validateWorkspaceDirectory(p));
    } catch {
      ctx.recentWorkspaces.remove(p);
    }
  }
  return results;
}

function csp(): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' https://fonts.googleapis.com 'unsafe-inline'",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "connect-src 'self' ws://127.0.0.1:*",
  ].join("; ");
}

function requireSession(ctx: ServerContext) {
  return (req: Request, res: Response, next: NextFunction) => {
    const token = req.cookies?.[SESSION_COOKIE_NAME];
    if (token !== ctx.sessionToken) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };
}

export function createApp(ctx: ServerContext) {
  const app = express();

  app.use((_req, res, next) => {
    res.setHeader("Content-Security-Policy", csp());
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });

  app.use(express.json({ limit: "2mb" }));
  app.use(cookieParser());

  app.get("/api/health", async (_req, res) => {
    const ollamaState = await checkOllamaConnection();
    res.json({ ok: true, appVersion: ctx.appVersion, ollamaState });
  });

  app.get("/api/bootstrap", async (_req, res) => {
    res.cookie(SESSION_COOKIE_NAME, ctx.sessionToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      path: "/",
    });

    const ollamaState = await checkOllamaConnection();
    const installedModels = ollamaState === "ready" ? await fetchInstalledModels().catch(() => []) : [];

    const payload: BootstrapPayload = {
      appVersion: ctx.appVersion,
      controllerHost: `127.0.0.1:${ctx.port}`,
      ollamaState,
      installedModels,
      recentWorkspaces: await listValidRecentWorkspaces(ctx),
      preferences: ctx.preferences.get(),
      templates: BUILT_IN_TEMPLATES,
      diagnostics: ctx.diagnostics.list(),
    };
    res.json(payload);
  });

  const authed = requireSession(ctx);
  app.use("/api", (req, res, next) => {
    if (req.path === "/health" || req.path === "/bootstrap") {
      next();
      return;
    }
    authed(req, res, next);
  });

  app.get("/api/models", async (_req, res) => {
    try {
      const models = await fetchInstalledModels();
      res.json(models);
    } catch (err) {
      res.status(502).json({ error: "ollama_unavailable", detail: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/conversations", (_req, res) => {
    res.json(ctx.store.listConversations());
  });

  app.get("/api/conversations/:id", (req, res) => {
    const conversation = ctx.store.getConversation(req.params.id);
    if (!conversation) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json(conversation);
  });

  app.delete("/api/conversations/:id", (req, res) => {
    ctx.store.deleteConversation(req.params.id);
    res.json({ ok: true });
  });

  app.patch("/api/conversations/:id", (req, res) => {
    const { title } = req.body as { title?: unknown };
    if (typeof title !== "string" || !title.trim()) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    ctx.store.renameConversation(req.params.id, title.trim().slice(0, 200));
    res.json({ ok: true });
  });

  app.post("/api/workspaces/validate", async (req, res) => {
    const { path: inputPath } = req.body as { path?: unknown };
    if (typeof inputPath !== "string" || !inputPath) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    try {
      const info = await validateWorkspaceDirectory(inputPath);
      res.json(info);
    } catch (err) {
      res.status(400).json({ error: "invalid_workspace", detail: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/workspaces/pick", async (_req, res) => {
    const picked = await pickFolder();
    if (!picked) {
      res.json({ cancelled: true });
      return;
    }
    try {
      const workspace = await validateWorkspaceDirectory(picked);
      ctx.recentWorkspaces.add(workspace.path);
      res.json({ cancelled: false, workspace });
    } catch (err) {
      res.status(400).json({ error: "invalid_workspace", detail: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/workspaces/recent", async (_req, res) => {
    res.json(await listValidRecentWorkspaces(ctx));
  });

  app.delete("/api/workspaces/recent", (req, res) => {
    const { path: inputPath } = req.body as { path?: unknown };
    if (typeof inputPath === "string") {
      ctx.recentWorkspaces.remove(inputPath);
    }
    res.json({ ok: true });
  });

  app.post("/api/workspace-sets/validate", async (req, res) => {
    const { primaryPath, linkedPaths } = req.body as { primaryPath?: unknown; linkedPaths?: unknown };
    if (typeof primaryPath !== "string" || !Array.isArray(linkedPaths)) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    try {
      const set = await validateWorkspaceSet({
        primaryPath,
        linkedPaths: linkedPaths.filter((p): p is string => typeof p === "string"),
      });
      ctx.recentWorkspaces.add(set.primary.path);
      res.json(set);
    } catch (err) {
      res.status(400).json({ error: "invalid_workspace_set", detail: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/files/open", async (req, res) => {
    const { workspacePath, path: relPath } = req.body as { workspacePath?: unknown; path?: unknown };
    if (typeof workspacePath !== "string" || typeof relPath !== "string") {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    try {
      const info = await validateWorkspaceDirectory(workspacePath);
      const target = await resolveWithinRoots([info.path], relPath);
      await openWithDefaultApp(target);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: "invalid_path", detail: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/files/reveal", async (req, res) => {
    const { workspacePath, path: relPath } = req.body as { workspacePath?: unknown; path?: unknown };
    if (typeof workspacePath !== "string" || typeof relPath !== "string") {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    try {
      const info = await validateWorkspaceDirectory(workspacePath);
      const target = await resolveWithinRoots([info.path], relPath);
      await revealInFinder(target);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: "invalid_path", detail: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/attachments", upload.single("file"), async (req, res) => {
    const file = req.file;
    const { conversationId } = req.body as { conversationId?: unknown };
    if (!file || typeof conversationId !== "string" || !conversationId) {
      if (file) fs.unlinkSync(file.path);
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    try {
      const dataDir = ctx.preferences.get().dataDir;
      const ingested = await ingestAttachment(dataDir, file.path, file.originalname);
      const ext = path.extname(file.originalname).toLowerCase();
      if (ingested.kind === "unsupported" && (ext === ".pdf" || ext === ".docx")) {
        ctx.diagnostics.add({
          level: "warning",
          message: `Failed to extract text from ${file.originalname}`,
          detail: "The file may be corrupt or password-protected.",
        });
      }
      const info = ctx.store.addAttachment({
        id: randomUUID(),
        conversationId,
        messageId: null,
        fileName: ingested.fileName,
        sourcePath: file.originalname,
        mimeType: ingested.mimeType,
        sizeBytes: ingested.sizeBytes,
        kind: ingested.kind,
        extractedText: ingested.extractedText,
        storedPath: ingested.storedPath,
      });
      res.json(info);
    } catch (err) {
      const status = err instanceof AttachmentError ? 400 : 500;
      res.status(status).json({ error: "attachment_rejected", detail: err instanceof Error ? err.message : String(err) });
    } finally {
      fs.rm(file.path, { force: true }, () => {});
    }
  });

  app.get("/api/attachments/:id/raw", (req, res) => {
    const row = ctx.store.getAttachmentRow(req.params.id);
    if (!row || !fs.existsSync(row.stored_path)) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.setHeader("Content-Type", row.mime_type);
    res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(row.file_name)}"`);
    res.sendFile(row.stored_path);
  });

  app.delete("/api/attachments/:id", (req, res) => {
    ctx.store.deleteAttachment(req.params.id);
    res.json({ ok: true });
  });

  app.get("/api/diagnostics/report", async (_req, res) => {
    const ollamaState = await checkOllamaConnection();
    res.json({ ollamaState, entries: ctx.diagnostics.list() });
  });

  app.post("/api/data-dir/reveal", async (_req, res) => {
    try {
      await openWithDefaultApp(ctx.preferences.get().dataDir);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: "reveal_failed", detail: err instanceof Error ? err.message : String(err) });
    }
  });

  app.patch("/api/preferences", (req, res) => {
    const { theme, defaultModel, systemPrompt } = req.body as {
      theme?: unknown;
      defaultModel?: unknown;
      systemPrompt?: unknown;
    };
    const patch: Partial<{ theme: "system" | "light" | "dark"; defaultModel: string | null; systemPrompt: string }> =
      {};
    if (theme === "system" || theme === "light" || theme === "dark") {
      patch.theme = theme;
    }
    if (typeof defaultModel === "string" || defaultModel === null) {
      patch.defaultModel = defaultModel;
    }
    if (typeof systemPrompt === "string") {
      patch.systemPrompt = systemPrompt.trim();
    }
    res.json(ctx.preferences.update(patch));
  });

  if (fs.existsSync(STATIC_DIR)) {
    app.use(express.static(STATIC_DIR));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(STATIC_DIR, "index.html"));
    });
  }

  return app;
}

// Port intentionally not compared strictly: the Vite dev server runs on a
// different port than the controller during `npm run dev`, both loopback-only.
function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true; // non-browser tooling in dev; browsers always send Origin
  try {
    const url = new URL(origin);
    return url.hostname === "127.0.0.1" || url.hostname === "localhost";
  } catch {
    return false;
  }
}

export function attachWebSocketServer(httpServer: HttpServer, ctx: ServerContext) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req: IncomingMessage, socket, head) => {
    if (req.url !== "/ws") {
      socket.destroy();
      return;
    }

    const origin = req.headers.origin;
    if (!isAllowedOrigin(origin)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    const cookies = cookie.parse(req.headers.cookie ?? "");
    if (cookies[SESSION_COOKIE_NAME] !== ctx.sessionToken) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      wss.emit("connection", ws, req);
    });
  });

  return wss;
}
