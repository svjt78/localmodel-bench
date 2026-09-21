import { OLLAMA_BASE_URL } from "./modelRegistry.js";

export interface OllamaToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}

export interface ChatMessageInput {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  images?: string[]; // raw base64, not data URLs; constructed only for model requests
  tool_calls?: OllamaToolCall[];
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface StreamChatOptions {
  model: string;
  messages: ChatMessageInput[];
  tools?: ToolDefinition[];
  signal: AbortSignal;
  onDelta: (delta: string) => void;
}

export interface StreamChatResult {
  fullText: string;
  toolCalls: OllamaToolCall[];
  evalCount?: number;
  evalDurationNs?: number;
}

interface OllamaChatStreamChunk {
  message?: { role: string; content: string; tool_calls?: OllamaToolCall[] };
  done: boolean;
  eval_count?: number;
  eval_duration?: number;
}

export async function streamChat(opts: StreamChatOptions): Promise<StreamChatResult> {
  const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      ...(opts.tools ? { tools: opts.tools } : {}),
      stream: true,
    }),
    signal: opts.signal,
  });

  if (!res.ok || !res.body) {
    if (opts.messages.some((message) => message.images?.length)) {
      // A runtime error may echo its request. Never copy image payloads into diagnostics.
      await res.body?.cancel();
      throw new Error(`Image request failed with status ${res.status}. Confirm that the local model/runtime supports JPG and PNG image inputs.`);
    }
    const detail = await res.text().catch(() => "");
    throw new Error(`POST /api/chat failed with status ${res.status}: ${detail}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";
  let toolCalls: OllamaToolCall[] = [];
  let evalCount: number | undefined;
  let evalDurationNs: number | undefined;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          const chunk = JSON.parse(line) as OllamaChatStreamChunk;
          if (chunk.message?.content) {
            fullText += chunk.message.content;
            opts.onDelta(chunk.message.content);
          }
          if (chunk.message?.tool_calls?.length) {
            toolCalls = chunk.message.tool_calls;
          }
          if (chunk.done) {
            evalCount = chunk.eval_count;
            evalDurationNs = chunk.eval_duration;
          }
        }
        newlineIndex = buffer.indexOf("\n");
      }
    }
  } finally {
    reader.releaseLock();
  }

  return { fullText, toolCalls, evalCount, evalDurationNs };
}

interface OllamaChatResponse {
  message?: { content: string };
}

/**
 * One-shot, non-streaming completion — used for small side tasks like
 * generating a conversation title, where there's nothing to display
 * incrementally and a single parsed response is simpler than the
 * streaming/delta shape streamChat is built for.
 */
export async function generateTitle(model: string, promptText: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: promptText }],
      stream: false,
    }),
    signal,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`POST /api/chat (title) failed with status ${res.status}: ${detail}`);
  }

  const data = (await res.json()) as OllamaChatResponse;
  return data.message?.content ?? "";
}
