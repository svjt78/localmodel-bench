import fs from "node:fs";
import path from "node:path";

const MAX_RECENT = 10;

export class RecentWorkspacesStore {
  private readonly filePath: string;
  private paths: string[];

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, "recent-workspaces.json");
    this.paths = this.load();
  }

  private load(): string[] {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
    } catch {
      return [];
    }
  }

  private persist(): void {
    fs.writeFileSync(this.filePath, JSON.stringify(this.paths, null, 2), "utf8");
  }

  list(): string[] {
    return [...this.paths];
  }

  add(workspacePath: string): void {
    this.paths = [workspacePath, ...this.paths.filter((p) => p !== workspacePath)].slice(0, MAX_RECENT);
    this.persist();
  }

  remove(workspacePath: string): void {
    this.paths = this.paths.filter((p) => p !== workspacePath);
    this.persist();
  }
}
