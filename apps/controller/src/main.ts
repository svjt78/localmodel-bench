import { randomUUID } from "node:crypto";
import http from "node:http";
import { attachWebSocketServer, createApp, type ServerContext } from "./server.js";
import { resolveDataDir } from "./services/dataDir.js";
import { PreferencesStore } from "./services/preferences.js";
import { ConversationStore } from "./services/conversationStore.js";
import { RecentWorkspacesStore } from "./services/recentWorkspaces.js";
import { DiagnosticsLog } from "./services/diagnosticsLog.js";
import { checkOllamaConnection } from "./services/modelRegistry.js";
import { WsSessionManager } from "./wsHandler.js";

const PORT = Number(process.env.PORT ?? 4173);
const APP_VERSION = "0.1.0";

const dataDir = resolveDataDir();
const preferences = new PreferencesStore(dataDir);
const store = new ConversationStore(dataDir);
const recentWorkspaces = new RecentWorkspacesStore(dataDir);
const diagnostics = new DiagnosticsLog();
const sessionManager = new WsSessionManager(store, diagnostics, preferences);

const ctx: ServerContext = {
  sessionToken: randomUUID(),
  appVersion: APP_VERSION,
  port: PORT,
  store,
  preferences,
  recentWorkspaces,
  diagnostics,
};

const app = createApp(ctx);
const httpServer = http.createServer(app);
const wss = attachWebSocketServer(httpServer, ctx);

wss.on("connection", (ws) => {
  checkOllamaConnection()
    .then((state) => ws.send(JSON.stringify({ type: "connection", state })))
    .catch(() => ws.send(JSON.stringify({ type: "connection", state: "unavailable" })));
  sessionManager.handleConnection(ws);
});

httpServer.listen(PORT, "127.0.0.1", () => {
  console.log(`Ollama Local Workspace controller listening on http://127.0.0.1:${PORT}`);
  console.log(`Data directory: ${dataDir}`);
});
