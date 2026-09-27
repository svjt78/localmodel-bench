import { assertMemory } from "./resources.js";
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
  onThinking?: () => void;
  options?: { num_ctx: number; num_predict: number };
}

export interface StreamChatResult {
  fullText: string;
  toolCalls: OllamaToolCall[];
  promptEvalCount?: number;
  doneReason?: string;
  evalCount?: number;
  evalDurationNs?: number;
}

interface OllamaChatStreamChunk {
  message?: { role: string; content: string; thinking?: string; tool_calls?: OllamaToolCall[] };
  error?: string;
  done_reason?: string;
  prompt_eval_count?: number;
  done: boolean;
  eval_count?: number;
  eval_duration?: number;
}

export class GenerationError extends Error {
  constructor(message: string, public readonly reason: string, public readonly result?: StreamChatResult) { super(message); }
}

export async function streamChat(opts: StreamChatOptions): Promise<StreamChatResult> {
  const deadline = AbortSignal.timeout(600_000);
  const idle = new AbortController();
  const signal = AbortSignal.any([opts.signal, deadline, idle.signal]);
  const memoryTimer=setInterval(()=>{try{assertMemory();}catch(e){idle.abort(e);}},1000);
  const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({model: opts.model, messages: opts.messages,
      ...(opts.tools ? {tools: opts.tools} : {}), stream: true, keep_alive: 0,
      options: opts.options ?? {num_ctx: 16384, num_predict: 8192}}), signal,
  }).catch(error=>{clearInterval(memoryTimer);throw error;});
  if (!res.ok || !res.body) {
    clearInterval(memoryTimer);
    await res.body?.cancel();
    throw new GenerationError(opts.messages.some(m=>m.images?.length) ? `Image request failed with status ${res.status}.` : `Model request failed (HTTP ${res.status}).`, "http");
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", completed = false;
  const result: StreamChatResult = {fullText: "", toolCalls: []};
  let idleTimer: ReturnType<typeof setTimeout>;
  const resetIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => idle.abort(new Error("No model data for three minutes.")), 180_000); };
  const consume = (line: string) => {
    if (!line.trim()) return;
    const chunk = JSON.parse(line) as OllamaChatStreamChunk;
    if (chunk.error) throw new GenerationError("Model reported a streaming error. The response is incomplete.", "stream", result);
    if (chunk.message?.thinking) opts.onThinking?.();
    if (chunk.message?.content) { result.fullText += chunk.message.content; opts.onDelta(chunk.message.content); }
    if (chunk.message?.tool_calls?.length) result.toolCalls = chunk.message.tool_calls;
    if (chunk.done) {
      completed = true; result.doneReason = chunk.done_reason;
      result.promptEvalCount = chunk.prompt_eval_count;
      result.evalCount = chunk.eval_count; result.evalDurationNs = chunk.eval_duration;
    }
  };
  resetIdle();
  try {
    while (!completed) {
      const {value, done} = await reader.read();
      if (done) { buffer += decoder.decode(); if (buffer.trim()) consume(buffer); break; }
      resetIdle(); buffer += decoder.decode(value, {stream: true});
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) { consume(buffer.slice(0,index)); buffer = buffer.slice(index+1); }
    }
    if (!completed) throw new GenerationError("Connection ended without a completion marker. Response is incomplete.", "eof", result);
    if (result.doneReason === "length") throw new GenerationError("Response reached its generation or context allowance.", "length", result);
    if (!result.fullText.trim() && !result.toolCalls.length) throw new GenerationError("Model completed without a visible answer.", "empty", result);
    return result;
  } finally { clearInterval(memoryTimer); clearTimeout(idleTimer!); await reader.cancel().catch(() => {}); reader.releaseLock(); }
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
  const result = await streamChat({model, messages: [{role:"user",content:promptText}],
    signal: signal ?? AbortSignal.timeout(60_000), options:{num_ctx:16384,num_predict:512}, onDelta:()=>{}});
  return result.fullText;
}
