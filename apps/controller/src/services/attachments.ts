import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PDFParse } from "pdf-parse";
import * as mammoth from "mammoth";
import type { AttachmentInfo } from "@ollama-local/shared";

export class AttachmentError extends Error {}

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".json", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".c", ".h", ".cpp", ".hpp", ".cs",
  ".css", ".scss", ".html", ".xml", ".yml", ".yaml", ".toml", ".ini", ".sh", ".bash",
  ".sql", ".csv", ".log", ".env",
]);

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
};

const TEXT_CAP_BYTES = 1_000_000; // 1MB
export const PDF_DOCX_SOURCE_CAP_BYTES = 20_000_000; // 20MB
const IMAGE_CAP_BYTES = 10_000_000; // 10MB

export async function extractPdfText(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return result.text;
  } finally {
    await parser.destroy();
  }
}

export async function extractDocxText(buffer: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

export function looksLikeText(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 8000);
  let controlBytes = 0;
  for (const byte of sample) {
    if (byte === 0) return false; // NUL byte — definitely binary
    if (byte < 9 || (byte > 13 && byte < 32)) controlBytes += 1;
  }
  return sample.length === 0 || controlBytes / sample.length < 0.05;
}

export function truncateText(text: string, capBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= capBytes) return { text, truncated: false };
  const buf = Buffer.from(text, "utf8").subarray(0, capBytes);
  return { text: buf.toString("utf8"), truncated: true };
}

export interface IngestedAttachment {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  kind: AttachmentInfo["kind"];
  extractedText?: string;
  storedPath: string;
}

/**
 * Ingests an uploaded file: detects its type, extracts text where applicable,
 * and copies the original bytes under the app data dir (never the workspace).
 * Throws AttachmentError for conditions that should reject the upload outright
 * (oversized PDF/DOCX/image); text files are truncated rather than rejected,
 * per the build spec's ingestion table.
 */
export async function ingestAttachment(
  dataDir: string,
  tempFilePath: string,
  originalFileName: string,
): Promise<IngestedAttachment> {
  const stat = fs.statSync(tempFilePath);
  const ext = path.extname(originalFileName).toLowerCase();
  const storedPath = path.join(dataDir, "attachments", `${randomUUID()}${ext}`);

  if (ext === ".pdf") {
    if (stat.size > PDF_DOCX_SOURCE_CAP_BYTES) {
      throw new AttachmentError("PDF exceeds the 20MB size limit");
    }
    fs.copyFileSync(tempFilePath, storedPath);
    try {
      const extracted = await extractPdfText(fs.readFileSync(storedPath));
      const { text, truncated } = truncateText(extracted, TEXT_CAP_BYTES);
      return {
        fileName: originalFileName,
        mimeType: "application/pdf",
        sizeBytes: stat.size,
        kind: "text",
        extractedText: truncated ? `${text}\n[truncated, extracted text exceeds 1MB]` : text,
        storedPath,
      };
    } catch {
      return {
        fileName: originalFileName,
        mimeType: "application/pdf",
        sizeBytes: stat.size,
        kind: "unsupported",
        storedPath,
      };
    }
  }

  if (ext === ".docx") {
    if (stat.size > PDF_DOCX_SOURCE_CAP_BYTES) {
      throw new AttachmentError("DOCX exceeds the 20MB size limit");
    }
    fs.copyFileSync(tempFilePath, storedPath);
    try {
      const extracted = await extractDocxText(fs.readFileSync(storedPath));
      const { text, truncated } = truncateText(extracted, TEXT_CAP_BYTES);
      return {
        fileName: originalFileName,
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        sizeBytes: stat.size,
        kind: "text",
        extractedText: truncated ? `${text}\n[truncated, extracted text exceeds 1MB]` : text,
        storedPath,
      };
    } catch {
      return {
        fileName: originalFileName,
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        sizeBytes: stat.size,
        kind: "unsupported",
        storedPath,
      };
    }
  }

  if (IMAGE_MIME_BY_EXT[ext]) {
    if (stat.size > IMAGE_CAP_BYTES) {
      throw new AttachmentError("Image exceeds the 10MB size limit");
    }
    fs.copyFileSync(tempFilePath, storedPath);
    return {
      fileName: originalFileName,
      mimeType: IMAGE_MIME_BY_EXT[ext],
      sizeBytes: stat.size,
      kind: "image",
      storedPath,
    };
  }

  const head = fs.readFileSync(tempFilePath, { flag: "r" }).subarray(0, 8000);
  const isText = TEXT_EXTENSIONS.has(ext) || looksLikeText(head);

  fs.copyFileSync(tempFilePath, storedPath);

  if (isText) {
    const buffer = fs.readFileSync(storedPath);
    const truncated = buffer.byteLength > TEXT_CAP_BYTES;
    const text = buffer.subarray(0, TEXT_CAP_BYTES).toString("utf8");
    return {
      fileName: originalFileName,
      mimeType: "text/plain",
      sizeBytes: stat.size,
      kind: "text",
      extractedText: truncated ? `${text}\n[truncated, file exceeds 1MB]` : text,
      storedPath,
    };
  }

  return {
    fileName: originalFileName,
    mimeType: "application/octet-stream",
    sizeBytes: stat.size,
    kind: "unsupported",
    storedPath,
  };
}
