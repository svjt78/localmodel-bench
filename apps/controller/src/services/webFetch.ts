import dns from "node:dns";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { extractPdfText, truncateText } from "./attachments.js";

export class WebFetchError extends Error {}

const RESPONSE_BYTE_CAP = 5_000_000; // 5MB
const EXTRACTED_TEXT_CAP_BYTES = 1_000_000; // 1MB
const FETCH_TIMEOUT_MS = 10_000;

// IPv4 CIDR ranges that must never be reached by this tool: loopback,
// RFC1918 private ranges, and link-local (which can carry cloud-metadata-style
// endpoints). Checked against every resolved address, not just the first,
// so a domain with multiple A records can't slip a private one past this.
const PRIVATE_IPV4_RANGES: [string, number][] = [
  ["127.0.0.0", 8],
  ["10.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["169.254.0.0", 16],
];

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    value = (value << 8) | n;
  }
  return value >>> 0;
}

function isPrivateIpv4(ip: string): boolean {
  const ipInt = ipv4ToInt(ip);
  if (ipInt === null) return false;
  for (const [base, bits] of PRIVATE_IPV4_RANGES) {
    const baseInt = ipv4ToInt(base);
    if (baseInt === null) continue;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    if ((ipInt & mask) === (baseInt & mask)) return true;
  }
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === "::1") return true; // loopback
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true; // fc00::/7 (ULA)
  if (normalized.startsWith("::ffff:")) {
    // IPv4-mapped IPv6 address — check the embedded IPv4 address too.
    const mapped = normalized.slice("::ffff:".length);
    return isPrivateIpv4(mapped);
  }
  return false;
}

function isPrivateOrLoopbackAddress(address: string, family: number): boolean {
  return family === 4 ? isPrivateIpv4(address) : isPrivateIpv6(address);
}

async function assertPublicUrl(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebFetchError(`Unsupported URL scheme: ${url.protocol}`);
  }
  let addresses: dns.LookupAddress[];
  try {
    addresses = await dns.promises.lookup(url.hostname, { all: true });
  } catch {
    // Fail closed — an unresolvable host is rejected, not allowed through.
    throw new WebFetchError(`Could not resolve host: ${url.hostname}`);
  }
  for (const { address, family } of addresses) {
    if (isPrivateOrLoopbackAddress(address, family)) {
      throw new WebFetchError(`Refusing to fetch a private/local address: ${url.hostname} (${address})`);
    }
  }
}

async function readBodyWithCap(response: Response): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) {
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.byteLength > RESPONSE_BYTE_CAP) {
      throw new WebFetchError(`Response exceeds the ${RESPONSE_BYTE_CAP / 1_000_000}MB size limit`);
    }
    return buf;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > RESPONSE_BYTE_CAP) {
        await reader.cancel();
        throw new WebFetchError(`Response exceeds the ${RESPONSE_BYTE_CAP / 1_000_000}MB size limit`);
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks);
}

export async function fetchUrl(rawUrl: string): Promise<{ content: string; truncated: boolean }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new WebFetchError(`Not a valid URL: ${rawUrl}`);
  }
  await assertPublicUrl(url);

  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    throw new WebFetchError(err instanceof Error ? err.message : "Fetch failed");
  }
  if (!response.ok) {
    throw new WebFetchError(`Request failed: ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const buffer = await readBodyWithCap(response);

  let extracted: string;
  if (contentType.includes("text/html")) {
    const dom = new JSDOM(buffer.toString("utf8"), { url: rawUrl });
    const article = new Readability(dom.window.document).parse();
    extracted = article ? `${article.title ? `${article.title}\n\n` : ""}${article.textContent}` : "";
    if (!extracted.trim()) {
      return { content: "[could not extract readable content from this page]", truncated: false };
    }
  } else if (contentType.includes("application/pdf")) {
    try {
      extracted = await extractPdfText(buffer);
    } catch {
      return { content: "[could not extract text from this PDF]", truncated: false };
    }
  } else {
    return {
      content: `[unsupported content type: ${contentType || "unknown"} — cannot extract text]`,
      truncated: false,
    };
  }

  const { text, truncated } = truncateText(extracted, EXTRACTED_TEXT_CAP_BYTES);
  return { content: text, truncated };
}
