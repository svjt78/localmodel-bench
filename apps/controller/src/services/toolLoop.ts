import type { ToolCallRecord } from "@ollama-local/shared";
import type { ToolDefinition } from "./ollamaClient.js";
import { listDirectory, readFile, searchFiles, WorkspaceValidationError, type NamedRoot } from "./workspace.js";
import { fetchUrl, WebFetchError } from "./webFetch.js";

export const TOOL_CALL_BUDGET = 8;
const RESULT_TRUNCATE_BYTES = 8 * 1024;

const VALID_TOOL_NAMES = new Set<ToolCallRecord["name"]>([
  "list_directory",
  "read_file",
  "search_files",
  "fetch_url",
]);

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "list_directory",
      description: "List files and subdirectories under a path relative to a workspace root.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Path relative to a workspace root, e.g. \"src\" or \".\". If multiple workspaces are attached, \".\" lists them by name and paths must start with \"<workspace name>/...\".",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read the contents of a file relative to a workspace root. Text extracted from a file exceeding 1MB is truncated with a marker. .docx and .pdf files are supported — their text content is extracted automatically, not treated as binary.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Path to the file, relative to a workspace root. If multiple workspaces are attached, prefix with \"<workspace name>/...\".",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description:
        "Search for a substring across files in the workspace (plain substring match, not semantic search). Returns matching file paths with line numbers and snippets. Searches inside .docx and .pdf files too — their text is extracted automatically, not skipped as binary.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Substring to search for." },
          path: {
            type: "string",
            description:
              "Optional path relative to a workspace root to scope the search. If multiple workspaces are attached, prefix with \"<workspace name>/...\" to scope to one of them.",
          },
        },
        required: ["query"],
      },
    },
  },
];

export const FETCH_URL_TOOL_DEFINITION: ToolDefinition = {
  type: "function",
  function: {
    name: "fetch_url",
    description:
      'Fetch the content of one specific web page or PDF, given its exact URL. This is NOT a search tool — it can only retrieve a URL you already have (one the user gave you, or one already present in the conversation). Never invent or guess a URL to "search" with this tool. HTML pages are returned as extracted article text; PDFs are returned as extracted text.',
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The exact http(s) URL to fetch." },
      },
      required: ["url"],
    },
  },
};

// Races a promise-returning operation against a timeout. This only works
// because the operation is genuinely async (fs/promises, not fs.*Sync) —
// a blocking synchronous call can't be preempted by this timer no matter
// how it's wrapped, since Node runs on a single thread.
function withTimeout<T>(operation: () => Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    operation().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function truncateResult(text: string): string {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= RESULT_TRUNCATE_BYTES) return text;
  const truncatedBuffer = Buffer.from(text, "utf8").subarray(0, RESULT_TRUNCATE_BYTES);
  return `${truncatedBuffer.toString("utf8")}\n[truncated, ${bytes - RESULT_TRUNCATE_BYTES} more bytes not shown]`;
}

export interface ExecutedToolCall {
  record: ToolCallRecord;
  resultText: string;
  pathViolation?: boolean;
}

export async function executeToolCall(
  namedRoots: NamedRoot[],
  id: string,
  requestedName: string,
  args: Record<string, unknown>,
): Promise<ExecutedToolCall> {
  const fallbackWorkspacePath = namedRoots[0]?.path ?? "";

  if (!VALID_TOOL_NAMES.has(requestedName as ToolCallRecord["name"])) {
    const result = `Error: unknown tool "${requestedName}"`;
    return {
      record: { id, name: "list_directory", args, result, workspacePath: fallbackWorkspacePath },
      resultText: result,
    };
  }
  const name = requestedName as ToolCallRecord["name"];
  let workspacePath = fallbackWorkspacePath;

  try {
    let resultText: string;

    if (name === "list_directory") {
      const relPath = typeof args.path === "string" ? args.path : ".";
      const { entries, root } = await withTimeout(() => listDirectory(namedRoots, relPath), 5000, "list_directory");
      if (root) workspacePath = root.path;
      resultText =
        entries
          .map((e) => `${e.kind === "directory" ? "d" : "f"} ${e.name}${e.kind === "file" ? ` (${e.sizeBytes}B)` : ""}`)
          .join("\n") || "(empty directory)";
    } else if (name === "read_file") {
      const relPath = typeof args.path === "string" ? args.path : "";
      const { content, truncated, root } = await withTimeout(() => readFile(namedRoots, relPath), 2000, "read_file");
      workspacePath = root.path;
      resultText = truncated ? `${content}\n[truncated, file exceeds 1MB]` : content;
    } else if (name === "search_files") {
      const query = typeof args.query === "string" ? args.query : "";
      const scope = typeof args.path === "string" ? args.path : undefined;
      const matches = await withTimeout(() => searchFiles(namedRoots, query, scope), 5000, "search_files");
      resultText = matches.map((m) => `${m.path}:${m.lineNumber}: ${m.line}`).join("\n") || "(no matches)";
    } else {
      workspacePath = "";
      const url = typeof args.url === "string" ? args.url : "";
      const { content, truncated } = await withTimeout(() => fetchUrl(url), 10000, "fetch_url");
      resultText = truncated ? `${content}\n[truncated, extracted text exceeds 1MB]` : content;
    }

    const truncated = truncateResult(resultText);
    return { record: { id, name, args, result: truncated, workspacePath }, resultText: truncated };
  } catch (err) {
    // pathViolation also covers webFetch's SSRF rejections here (WebFetchError) —
    // reusing the existing flag, not renaming it, since wsHandler.ts already logs
    // a diagnostics warning whenever a tool result carries pathViolation: true.
    const isPathViolation = err instanceof WorkspaceValidationError || err instanceof WebFetchError;
    const message = `Error: ${err instanceof Error ? err.message : String(err)}`;
    return {
      record: { id, name, args, result: message, workspacePath },
      resultText: message,
      pathViolation: isPathViolation,
    };
  }
}

export function budgetExceededMessage(): string {
  return "Error: Tool call budget exceeded for this turn (8 tool calls already used). Answer from what you already have.";
}
