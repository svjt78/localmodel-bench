import type { DiagnosticsEntry } from "@ollama-local/shared";

const MAX_ENTRIES = 100;

export class DiagnosticsLog {
  private entries: DiagnosticsEntry[] = [];

  add(entry: Omit<DiagnosticsEntry, "at">): void {
    this.entries.push({ ...entry, at: Date.now() });
    if (this.entries.length > MAX_ENTRIES) {
      this.entries = this.entries.slice(-MAX_ENTRIES);
    }
  }

  list(): DiagnosticsEntry[] {
    return [...this.entries].reverse();
  }
}
