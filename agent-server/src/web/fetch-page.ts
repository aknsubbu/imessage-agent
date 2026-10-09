// Fetches a web page the person linked to, safely. The URL comes from a
// message, so it is untrusted: the fetcher refuses anything that is not a
// public http(s) address, at connection time, on every redirect hop. Without
// this, a link could make the server read its own cloud metadata service
// (169.254.169.254), which hands out the VM's credentials.
import { lookup as dnsLookup } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

const blocked = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
] as const) {
  blocked.addSubnet(net, bits, "ipv4");
}
for (const [net, bits] of [
  ["::", 127], // unspecified and loopback
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link local
  ["ff00::", 8], // multicast
] as const) {
  blocked.addSubnet(net, bits, "ipv6");
}

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, "ipv4");
  if (family !== 6) return true;
  // An IPv4 address wrapped in IPv6 is judged as the IPv4 address it is.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  return mapped ? blocked.check(mapped[1]!, "ipv4") : blocked.check(address, "ipv6");
}

export class BlockedUrlError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "BlockedUrlError";
  }
}

export type PageFetchOptions = {
  signal?: AbortSignal;
  /** Tests only: addresses to treat as public, so a local server can stand in for the web. */
  allowAddresses?: string[];
  timeoutMs?: number;
};

const MAX_BYTES = 1_500_000;
const MAX_REDIRECTS = 4;
const TEXT_TYPES = /^(text\/html|application\/xhtml\+xml|text\/plain|text\/markdown|application\/json)/i;

function checkUrl(url: URL, allow: string[]): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new BlockedUrlError("only http and https links can be opened");
  if (url.username || url.password) throw new BlockedUrlError("links with embedded credentials are not opened");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (url.port && !["80", "443"].includes(url.port) && !allow.includes(host)) {
    throw new BlockedUrlError("only standard web ports are opened");
  }
  if (isIP(host) && isPrivateAddress(host) && !allow.includes(host)) throw new BlockedUrlError("that address is not on the public internet");
}

/** DNS lookup that fails if a name resolves to a private address, checked at the moment of connecting. */
const guardedLookup =
  (allow: string[]): LookupFunction =>
  (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, "", 0);
      const bad = addresses.find((entry) => isPrivateAddress(entry.address) && !allow.includes(entry.address));
      if (bad || addresses.length === 0) return callback(new BlockedUrlError("that address is not on the public internet"), "", 0);
      if (options.all) (callback as (e: null, a: typeof addresses) => void)(null, addresses);
      else callback(null, addresses[0]!.address, addresses[0]!.family);
    });
  };

function get(url: URL, opts: PageFetchOptions): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const allow = opts.allowAddresses ?? [];
    const request = (url.protocol === "https:" ? https : http).request(
      url,
      {
        method: "GET",
        lookup: guardedLookup(allow),
        signal: opts.signal,
        timeout: opts.timeoutMs ?? 10_000,
        headers: {
          "user-agent": "Mozilla/5.0 (compatible; imessage-agent/0.1; personal assistant fetching a link its user sent)",
          accept: "text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8",
          "accept-encoding": "gzip, deflate, br",
          "accept-language": "en",
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            res.destroy();
            return resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) });
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      },
    );
    request.on("timeout", () => request.destroy(new Error("the page took too long to respond")));
    request.on("error", reject);
    request.end();
  });
}

function decode(body: Buffer, encoding: string | undefined): string {
  const limit = { maxOutputLength: 6_000_000 }; // a small compressed page must not expand without bound
  try {
    if (encoding === "gzip") return gunzipSync(body, limit).toString("utf8");
    if (encoding === "deflate") return inflateSync(body, limit).toString("utf8");
    if (encoding === "br") return brotliDecompressSync(body, limit).toString("utf8");
  } catch {
    // A page cut off at the size limit will not decompress cleanly; fall through to what there is.
  }
  return body.toString("utf8");
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
};

const unescape = (text: string): string =>
  text
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Math.min(Number(code), 0x10ffff)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code: string) => String.fromCodePoint(Math.min(parseInt(code, 16), 0x10ffff)))
    .replace(/&([a-z]+);/gi, (match, name: string) => ENTITIES[name.toLowerCase()] ?? match);

/** Reduces an HTML document to its readable text. Crude by design: no dependency, good enough for articles. */
export function htmlToText(html: string): { title: string; text: string } {
  const title = unescape(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "")
    .replace(/\s+/g, " ")
    .trim();
  let body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|head|nav|footer|header|aside|form|iframe|template)\b[\s\S]*?<\/\1>/gi, " ");
  // Prefer the page's main content when it marks one.
  const main = /<(article|main)\b[\s\S]*?<\/\1>/i.exec(body)?.[0];
  if (main && main.length > 500) body = main;
  const text = unescape(
    body
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/blockquote)\b[^>]*>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "• ")
      .replace(/<[^>]+>/g, " "),
  )
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  return { title, text };
}

export type Page = { url: string; title: string; text: string };

export async function fetchPage(input: string, opts: PageFetchOptions = {}): Promise<Page> {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new BlockedUrlError("that is not a valid link");
  }
  const allow = opts.allowAddresses ?? [];
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    checkUrl(url, allow);
    const res = await get(url, opts);
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      url = new URL(res.headers.location, url); // checked again at the top of the loop
      continue;
    }
    if (res.status >= 400) throw new Error(`the site answered with an error (${res.status})`);
    const type = String(res.headers["content-type"] ?? "text/html");
    if (!TEXT_TYPES.test(type)) throw new Error(`that link is not a web page I can read (${type.split(";")[0]})`);
    const raw = decode(res.body, String(res.headers["content-encoding"] ?? "").toLowerCase() || undefined);
    if (/html|xml/i.test(type)) return { url: url.href, ...htmlToText(raw) };
    return { url: url.href, title: "", text: raw.trim() };
  }
  throw new Error("the link redirected too many times");
}
