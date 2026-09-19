import fs from "node:fs";
import path from "node:path";
import type { AppPreferences } from "@ollama-local/shared";

const DEFAULT_SYSTEM_PROMPT =
  "Always, be brutally honest. Always, explain in a plain simple and layman's language.";

function defaults(dataDir: string): AppPreferences {
  return { theme: "system", defaultModel: null, dataDir, systemPrompt: DEFAULT_SYSTEM_PROMPT };
}

export class PreferencesStore {
  private readonly filePath: string;
  private current: AppPreferences;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, "preferences.json");
    this.current = this.load(dataDir);
  }

  private load(dataDir: string): AppPreferences {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<AppPreferences>;
      return { ...defaults(dataDir), ...parsed, dataDir };
    } catch {
      return defaults(dataDir);
    }
  }

  get(): AppPreferences {
    return this.current;
  }

  update(patch: Partial<Pick<AppPreferences, "theme" | "defaultModel" | "systemPrompt">>): AppPreferences {
    this.current = { ...this.current, ...patch };
    fs.writeFileSync(this.filePath, JSON.stringify(this.current, null, 2), "utf8");
    return this.current;
  }
}
