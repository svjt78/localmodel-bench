import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { WorkspaceInfo, WorkspaceSet } from "@ollama-local/shared";
import { MAX_CONVERSATION_WORKSPACES } from "@ollama-local/shared";
import { looksLikeText, extractDocxText, extractPdfText, PDF_DOCX_SOURCE_CAP_BYTES } from "./attachments.js";

const EXTRACTABLE_EXTENSIONS = new Set([".docx", ".pdf"]);

async function extractDocumentText(buffer: Buffer, ext: string): Promise<string> {
  return ext === ".docx" ? extractDocxText(buffer) : extractPdfText(buffer);
}

const SKIP_DIR_NAMES = new Set([".git", "node_modules", "dist", "build"]);
const MAX_ENUMERATED_FILES = 2000;
const MAX_READABLE_FILE_BYTES = 1_000_000; // 1MB
const WALK_TIME_BUDGET_MS = 3000;

export class WorkspaceValidationError extends Error {}

// All directory walks below use fs/promises rather than the *Sync variants.
// A folder attach or tool call can point at an arbitrarily large or
// slow (network/cloud-synced) directory — the Sync variants would run to
// completion on Node's single event-loop thread, freezing the entire
// controller (every request, every WS turn) for as long as the walk takes.
// The async variants yield to the event loop between I/O calls, so a slow
// walk only delays its own request/tool-call, not the whole app; they also
// make the per-call timeouts in toolLoop.ts actually able to fire, since a
// synchronous call can never be preempted by a timer on one thread.

async function canonicalize(inputPath: string): Promise<string> {
  try {
    return await fsp.realpath(inputPath);
  } catch {
    throw new WorkspaceValidationError(`Path does not exist: ${inputPath}`);
  }
}

async function countFiles(root: string): Promise<{ fileCount: number; truncated: boolean }> {
  let fileCount = 0;
  let truncated = false;
  const deadline = Date.now() + WALK_TIME_BUDGET_MS;

  async function walk(dir: string): Promise<void> {
    if (truncated) return;
    if (Date.now() > deadline) {
      truncated = true;
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      if (Date.now() > deadline) {
        truncated = true;
        return;
      }
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) continue;
        await walk(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        fileCount += 1;
        if (fileCount >= MAX_ENUMERATED_FILES) {
          truncated = true;
          return;
        }
      }
    }
  }

  await walk(root);
  return { fileCount, truncated };
}

export async function validateWorkspaceDirectory(inputPath: string): Promise<WorkspaceInfo> {
  const canonicalPath = await canonicalize(inputPath);
  const stat = await fsp.stat(canonicalPath);
  if (!stat.isDirectory()) {
    throw new WorkspaceValidationError(`Not a directory: ${inputPath}`);
  }

  const { fileCount, truncated } = await countFiles(canonicalPath);
  const isGitRepository = await fsp
    .access(path.join(canonicalPath, ".git"))
    .then(() => true)
    .catch(() => false);

  return {
    path: canonicalPath,
    displayName: path.basename(canonicalPath) || canonicalPath,
    isGitRepository,
    fileCount,
    truncated,
  };
}

function isSubPath(parent: string, child: string): boolean {
  if (parent === child) return true;
  const relative = path.relative(parent, child);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

export async function validateWorkspaceSet(input: {
  primaryPath: string;
  linkedPaths: string[];
}): Promise<WorkspaceSet> {
  const totalCount = 1 + input.linkedPaths.length;
  if (totalCount > MAX_CONVERSATION_WORKSPACES) {
    throw new WorkspaceValidationError(
      `Too many workspaces: ${totalCount} exceeds the limit of ${MAX_CONVERSATION_WORKSPACES}`,
    );
  }

  const primary = await validateWorkspaceDirectory(input.primaryPath);
  const linked = await Promise.all(input.linkedPaths.map((p) => validateWorkspaceDirectory(p)));

  const all = [primary, ...linked];
  for (let i = 0; i < all.length; i += 1) {
    for (let j = 0; j < all.length; j += 1) {
      if (i === j) continue;
      if (isSubPath(all[i].path, all[j].path)) {
        throw new WorkspaceValidationError(
          `Workspace overlap: "${all[j].path}" is inside "${all[i].path}"`,
        );
      }
    }
  }

  return { primary, linked };
}

export function workspaceRoots(workspaceSet: WorkspaceSet): string[] {
  return [workspaceSet.primary.path, ...workspaceSet.linked.map((w) => w.path)];
}

export interface NamedRoot {
  name: string;
  path: string;
}

/**
 * One entry per attached workspace, keyed by a name the model can address it
 * by (its folder name, auto-disambiguated on collision). Built once per turn
 * in wsHandler.ts and threaded through every tool call — this is what lets
 * the model reach a *linked* workspace at all, not just the primary one.
 */
export function buildNamedWorkspaceRoots(workspaceSet: WorkspaceSet): NamedRoot[] {
  const all = [workspaceSet.primary, ...workspaceSet.linked];
  const seen = new Map<string, number>();
  return all.map((w) => {
    const count = (seen.get(w.displayName) ?? 0) + 1;
    seen.set(w.displayName, count);
    const name = count === 1 ? w.displayName : `${w.displayName} (${count})`;
    return { name, path: w.path };
  });
}

/**
 * The security boundary for every tool call: canonicalizes the requested path
 * and re-checks containment against every selected workspace root, every
 * single call — never cached from an earlier check in the same turn.
 */
export async function resolveWithinRoots(roots: string[], relativeOrAbsolutePath: string): Promise<string> {
  const candidate = path.isAbsolute(relativeOrAbsolutePath)
    ? relativeOrAbsolutePath
    : path.join(roots[0] ?? ".", relativeOrAbsolutePath);

  let resolved: string;
  try {
    resolved = await fsp.realpath(candidate);
  } catch {
    throw new WorkspaceValidationError(`Path does not exist: ${relativeOrAbsolutePath}`);
  }

  const withinAnyRoot = roots.some((root) => isSubPath(root, resolved));
  if (!withinAnyRoot) {
    throw new WorkspaceValidationError(`Path escapes all selected workspace roots: ${relativeOrAbsolutePath}`);
  }
  return resolved;
}

/**
 * Multi-root-aware version of resolveWithinRoots, used by the model-facing
 * tools (list_directory/read_file/search_files). With a single workspace,
 * behaves exactly like resolveWithinRoots (no name prefix needed — fully
 * backward compatible). With multiple workspaces, the first path segment
 * must name one of them (e.g. "Aegon/notes.txt") — this is what the model
 * already tries intuitively, so this makes that actually work instead of
 * silently mis-resolving against the primary root.
 */
export async function resolveWorkspacePath(
  namedRoots: NamedRoot[],
  relativeOrAbsolutePath: string,
): Promise<{ resolvedPath: string; root: NamedRoot }> {
  if (namedRoots.length === 0) {
    throw new WorkspaceValidationError("No workspace is attached to this conversation");
  }

  if (path.isAbsolute(relativeOrAbsolutePath)) {
    let resolved: string;
    try {
      resolved = await fsp.realpath(relativeOrAbsolutePath);
    } catch {
      throw new WorkspaceValidationError(`Path does not exist: ${relativeOrAbsolutePath}`);
    }
    const root = namedRoots.find((r) => isSubPath(r.path, resolved));
    if (!root) {
      throw new WorkspaceValidationError(`Path escapes all selected workspace roots: ${relativeOrAbsolutePath}`);
    }
    return { resolvedPath: resolved, root };
  }

  let root: NamedRoot;
  let restPath: string;

  if (namedRoots.length === 1) {
    root = namedRoots[0];
    restPath = relativeOrAbsolutePath;
  } else {
    const normalized = relativeOrAbsolutePath.replace(/^(\.\/|\/)+/, "").replace(/^\.$/, "");
    const segments = normalized.split("/").filter(Boolean);
    const [first, ...rest] = segments;
    const match = namedRoots.find((r) => r.name === first);
    if (!match) {
      const validNames = namedRoots.map((r) => `"${r.name}"`).join(", ");
      throw new WorkspaceValidationError(
        `"${first ?? ""}" is not one of the attached workspaces — must start with one of: ${validNames}`,
      );
    }
    root = match;
    restPath = rest.join("/");
  }

  const candidate = restPath ? path.join(root.path, restPath) : root.path;
  let resolved: string;
  try {
    resolved = await fsp.realpath(candidate);
  } catch {
    throw new WorkspaceValidationError(`Path does not exist: ${relativeOrAbsolutePath}`);
  }
  if (!isSubPath(root.path, resolved)) {
    throw new WorkspaceValidationError(`Path escapes all selected workspace roots: ${relativeOrAbsolutePath}`);
  }
  return { resolvedPath: resolved, root };
}

export interface DirectoryEntry {
  name: string;
  kind: "file" | "directory";
  sizeBytes: number;
}

export async function listDirectory(
  namedRoots: NamedRoot[],
  relativePath: string,
): Promise<{ entries: DirectoryEntry[]; root: NamedRoot | null }> {
  const trimmed = relativePath.trim();
  const isTopLevel = trimmed === "" || trimmed === "." || trimmed === "./";
  if (namedRoots.length > 1 && isTopLevel) {
    return {
      entries: namedRoots.map((r) => ({ name: r.name, kind: "directory" as const, sizeBytes: 0 })),
      root: null,
    };
  }

  const { resolvedPath, root } = await resolveWorkspacePath(namedRoots, relativePath);
  const entries = await fsp.readdir(resolvedPath, { withFileTypes: true });
  const visible = entries.filter((e) => !(e.isDirectory() && SKIP_DIR_NAMES.has(e.name)));
  const result = await Promise.all(
    visible.map(async (e) => {
      const full = path.join(resolvedPath, e.name);
      const stat = await fsp.stat(full);
      return {
        name: e.name,
        kind: e.isDirectory() ? ("directory" as const) : ("file" as const),
        sizeBytes: e.isFile() ? stat.size : 0,
      };
    }),
  );
  return { entries: result, root };
}

export async function readFile(
  namedRoots: NamedRoot[],
  relativePath: string,
): Promise<{ content: string; truncated: boolean; root: NamedRoot }> {
  const { resolvedPath, root } = await resolveWorkspacePath(namedRoots, relativePath);
  const stat = await fsp.stat(resolvedPath);
  if (!stat.isFile()) {
    throw new WorkspaceValidationError(`Not a file: ${relativePath}`);
  }
  const ext = path.extname(resolvedPath).toLowerCase();

  if (EXTRACTABLE_EXTENSIONS.has(ext)) {
    if (stat.size > PDF_DOCX_SOURCE_CAP_BYTES) {
      return { content: "[file too large to extract text from — exceeds 20MB]", truncated: false, root };
    }
    try {
      const buffer = await fsp.readFile(resolvedPath);
      const text = await extractDocumentText(buffer, ext);
      const truncated = Buffer.byteLength(text, "utf8") > MAX_READABLE_FILE_BYTES;
      const content = truncated
        ? Buffer.from(text, "utf8").subarray(0, MAX_READABLE_FILE_BYTES).toString("utf8")
        : text;
      return { content, truncated, root };
    } catch {
      return { content: "[could not extract text from this file]", truncated: false, root };
    }
  }

  const buffer = await fsp.readFile(resolvedPath);
  if (!looksLikeText(buffer)) {
    return { content: "[binary file — cannot be read as text]", truncated: false, root };
  }
  const truncated = buffer.byteLength > MAX_READABLE_FILE_BYTES;
  const content = buffer.subarray(0, MAX_READABLE_FILE_BYTES).toString("utf8");
  return { content, truncated, root };
}

export interface SearchMatch {
  path: string;
  lineNumber: number;
  line: string;
}

export async function searchFiles(
  namedRoots: NamedRoot[],
  query: string,
  scopedPath?: string,
): Promise<SearchMatch[]> {
  const searchRoots = scopedPath
    ? [(await resolveWorkspacePath(namedRoots, scopedPath)).resolvedPath]
    : namedRoots.map((r) => r.path);
  const matches: SearchMatch[] = [];
  const MAX_MATCHES = 200;
  const deadline = Date.now() + WALK_TIME_BUDGET_MS;

  async function walk(dir: string): Promise<void> {
    if (matches.length >= MAX_MATCHES || Date.now() > deadline) return;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (matches.length >= MAX_MATCHES || Date.now() > deadline) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) continue;
        await walk(full);
      } else if (entry.isFile()) {
        let stat: fs.Stats;
        try {
          stat = await fsp.stat(full);
        } catch {
          continue;
        }
        const ext = path.extname(full).toLowerCase();
        const isExtractable = EXTRACTABLE_EXTENSIONS.has(ext);
        const sizeCap = isExtractable ? PDF_DOCX_SOURCE_CAP_BYTES : MAX_READABLE_FILE_BYTES;
        if (stat.size > sizeCap) continue;
        let buffer: Buffer;
        try {
          buffer = await fsp.readFile(full);
        } catch {
          continue;
        }
        let text: string;
        if (isExtractable) {
          try {
            text = await extractDocumentText(buffer, ext);
          } catch {
            continue;
          }
        } else {
          if (!looksLikeText(buffer)) continue;
          text = buffer.toString("utf8");
        }
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i += 1) {
          if (lines[i].includes(query)) {
            matches.push({ path: full, lineNumber: i + 1, line: lines[i].slice(0, 300) });
            if (matches.length >= MAX_MATCHES) break;
          }
        }
      }
    }
  }

  for (const searchRoot of searchRoots) {
    await walk(searchRoot);
    if (matches.length >= MAX_MATCHES) break;
  }

  return matches;
}
