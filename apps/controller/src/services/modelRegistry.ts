import type { ModelOption, OllamaConnectionState } from "@ollama-local/shared";

export const OLLAMA_BASE_URL = "http://127.0.0.1:11434";

// Known-good defaults for the user's existing shell aliases — not the only
// selectable models. Any other installed model is still discovered and
// selectable via GET /api/tags; its friendly alias is just left null.
const KNOWN_ALIASES: Record<string, string> = {
  "qwen3:30b-a3b-instruct-2507-q4_K_M": "qfast",
  "qwen3:30b-a3b-thinking-2507-q4_K_M": "qthink",
  "deepseek-r1:32b-qwen-distill-q4_K_M": "rson",
};

interface OllamaTagsResponseModel {
  name: string;
  size?: number;
  details?: {
    family?: string;
  };
  // Some local runtimes include capabilities here; otherwise use /api/show.
  capabilities?: string[];
}

interface OllamaTagsResponse {
  models?: OllamaTagsResponseModel[];
}

export async function fetchInstalledModels(signal?: AbortSignal): Promise<ModelOption[]> {
  const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { signal });
  if (!res.ok) {
    throw new Error(`GET /api/tags failed with status ${res.status}`);
  }
  const body = (await res.json()) as OllamaTagsResponse;
  const models = body.models ?? [];

  return Promise.all(models.map(async (m): Promise<ModelOption> => {
    let capabilities = m.capabilities;
    if (!Array.isArray(capabilities)) {
      try {
        const show = await fetch(`${OLLAMA_BASE_URL}/api/show`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: m.name }),
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
        });
        if (show.ok) {
          const details = await show.json() as { capabilities?: string[] };
          if (Array.isArray(details.capabilities)) capabilities = details.capabilities;
        }
      } catch { /* Unknown capabilities must never enable vision. */ }
    }
    return {
      name: m.name,
      alias: KNOWN_ALIASES[m.name] ?? null,
      supportsTools: (capabilities ?? []).includes("tools"),
      supportsVision: (capabilities ?? []).includes("vision"),
      capabilitiesKnown: Array.isArray(capabilities),
      sizeBytes: m.size ?? 0,
      family: m.details?.family ?? "unknown",
    };
  }));
}

export async function checkOllamaConnection(signal?: AbortSignal): Promise<OllamaConnectionState> {
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { signal });
    return res.ok ? "ready" : "unavailable";
  } catch {
    return "unavailable";
  }
}
