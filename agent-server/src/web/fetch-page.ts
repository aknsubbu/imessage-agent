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
// Prefixes that wrap an IPv4 address (or are never a public host) are refused outright instead of
// being decoded: nothing real is served from them, and a gateway such as NAT64 or 6to4 would turn
// "64:ff9b::7f00:1" or "2002:7f00:1::" into a request to 127.0.0.1.
for (const [net, bits] of [
  ["::", 96], // unspecified, loopback and the old IPv4-compatible form (::127.0.0.1)
  ["::ffff:0:0:0", 96], // IPv4-translated (::ffff:0:127.0.0.1)
  ["64:ff9b::", 96], // NAT64
  ["64:ff9b:1::", 48], // local-use NAT64
  ["100::", 64], // discard-only
  ["2001::", 32], // Teredo
  ["2002::", 16], // 6to4
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link local
  ["ff00::", 8], // multicast
] as const) {
  blocked.addSubnet(net, bits, "ipv6");
}

/** The eight 16-bit groups of an IPv6 address, or null if it is not one. */
function hextets(address: string): number[] | null {
  let text = address.split("%")[0]!.toLowerCase();
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    text = text.slice(0, dotted.index) + ((a << 8) | b).toString(16) + ":" + ((c << 8) | d).toString(16);
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array(fill).fill("0"), ...tail].map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return groups.length === 8 && groups.every((g) => g >= 0) ? groups : null;
}

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, "ipv4");
  if (family !== 6) return true;
  const groups = hextets(address);
  if (!groups) return true; // anything that cannot be read is not trusted
  // An IPv4 address wrapped as ::ffff:a.b.c.d is judged as the IPv4 address it is.
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return blocked.check(`${groups[6]! >> 8}.${groups[6]! & 255}.${groups[7]! >> 8}.${groups[7]! & 255}`, "ipv4");
  }
  return blocked.check(groups.map((g) => g.toString(16)).join(":"), "ipv6");
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

const SKIPPED_BLOCKS = new Set(["script", "style", "noscript", "svg", "head", "nav", "footer", "header", "aside", "form", "iframe", "template"]);
const LINE_BREAK_CLOSERS = new Set(["p", "div", "li", "tr", "section", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6"]);
const MAX_HTML_CHARS = 1_500_000;

/** Lower-cases ASCII only, so every index in the result is an index in the original. */
const asciiLower = (text: string): string => text.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));

/**
 * Drops comments and non-content blocks (scripts, navigation and so on) in one left-to-right pass.
 * A block or comment that never closes swallows the rest of the page, as a browser would show it.
 * The page is attacker-chosen, so nothing here may backtrack: a regex over "<script>" repeated
 * a hundred thousand times took forty seconds and froze every chat while it ran.
 */
function stripNonContent(html: string): string {
  const lower = asciiLower(html);
  let out = "";
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) return out + html.slice(i);
    out += html.slice(i, lt);
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      if (end === -1) return out;
      out += " ";
      i = end + 3;
      continue;
    }
    const name = /^<([a-z][a-z0-9]*)/.exec(lower.slice(lt, lt + 24))?.[1];
    if (name && SKIPPED_BLOCKS.has(name)) {
      const close = lower.indexOf(`</${name}`, lt + 1);
      const end = close === -1 ? -1 : lower.indexOf(">", close);
      if (end === -1) return out;
      out += " ";
      i = end + 1;
      continue;
    }
    out += "<";
    i = lt + 1;
  }
  return out;
}

/** The first <article> or <main> element, if the page has one. */
function mainContent(html: string): string | undefined {
  const lower = asciiLower(html);
  const found = ["article", "main"]
    .map((name) => ({ name, at: lower.search(new RegExp(`<${name}(?![a-z0-9])`)) }))
    .filter((hit) => hit.at !== -1)
    .sort((a, b) => a.at - b.at)[0];
  if (!found) return undefined;
  const close = lower.indexOf(`</${found.name}`, found.at);
  const end = close === -1 ? -1 : lower.indexOf(">", close);
  return end === -1 ? undefined : html.slice(found.at, end + 1);
}

/** Replaces every tag with a space, a line break or a bullet. A "<" with no ">" after it is left as text. */
function tagsToText(html: string): string {
  let out = "";
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) return out + html.slice(i);
    const gt = html.indexOf(">", lt);
    if (gt === -1) return out + html.slice(i); // no ">" anywhere after this point, so none after any later "<" either
    out += html.slice(i, lt);
    const tag = /^(\/?)([a-z][a-z0-9]*)/.exec(asciiLower(html.slice(lt + 1, lt + 24)));
    if (!tag) out += " ";
    else if (tag[1] ? LINE_BREAK_CLOSERS.has(tag[2]!) : tag[2] === "br") out += "\n";
    else if (!tag[1] && tag[2] === "li") out += "• ";
    else out += " ";
    i = gt + 1;
  }
  return out;
}

/** Reduces an HTML document to its readable text. Crude by design: no dependency, good enough for articles. */
export function htmlToText(input: string): { title: string; text: string } {
  const html = input.length > MAX_HTML_CHARS ? input.slice(0, MAX_HTML_CHARS) : input;
  let title = "";
  const lower = asciiLower(html);
  const titleAt = lower.search(/<title(?![a-z0-9])/);
  if (titleAt !== -1) {
    const open = html.indexOf(">", titleAt);
    const close = open === -1 ? -1 : lower.indexOf("</title", open);
    if (close !== -1) title = unescape(html.slice(open + 1, close)).replace(/\s+/g, " ").trim();
  }
  let body = stripNonContent(html);
  // Prefer the page's main content when it marks one.
  const main = mainContent(body);
  if (main && main.length > 500) body = main;
  const text = unescape(tagsToText(body))
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
