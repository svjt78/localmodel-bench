import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const APP_DATA_DIR_NAME = "Ollama Local Workspace";

export function resolveDataDir(): string {
  const dir = path.join(os.homedir(), "Library", "Application Support", APP_DATA_DIR_NAME);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, "attachments"), { recursive: true });
  return dir;
}
