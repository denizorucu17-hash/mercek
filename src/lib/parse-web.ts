import type { ReaderBlock, WebResult } from "./search-types.ts";

const AMP = "&" + "amp;";
const QUOT = "&" + "quot;";
const LT = "&" + "lt;";
const GT = "&" + "gt;";
const APOS = "&" + "apos;";
const NBSP = "&" + "nbsp;";

export function decodeEntities(input: string): string {
  let value = input;
  for (let pass = 0; pass < 2; pass += 1) {
    value = value
      .split(AMP)
      .join("&")
      .split(NBSP)
      .join(" ")
      .split(QUOT)
      .join('"')
      .split("&#39;")
      .join("'")
      .split(APOS)
      .join("'")
      .split(LT)
      .join("<")
      .split(GT)
      .join(">")
      .replace(/&#(\d+);/g, (_, n: string) => fromCode(Number(n)))
      .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => fromCode(parseInt(n, 16)));
  }
  return value;
}

function fromCode(code: number): string {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

export function cleanText(input: string): string {
  return decodeEntities(input.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

export function displayOf(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    let path = u.pathname;
    try {
      path = decodeURIComponent(u.pathname);
    } catch {
      path = u.pathname;
    }
    path = path.replace(/\/$/, "");
    const shown = path ? `${host}${path}` : host;
    return shown.length > 72 ? `${shown.slice(0, 70)}…` : shown;
  } catch {
    return url;
  }
}

export function citeToUrl(cite: string): string | null {
  let text = cite.replace(/\s+/g, " ").trim();
  text = text.replace(/\s*(çeviri|translate this result|cached|önbellek).*/i, "");
  text = text.replace(/›/g, "/");
  text = text.replace(/\s*\/\s*/g, "/");
  text = text.replace(/\s+/g, "");
  if (!text || /\s/.test(text)) return null;
  if (!/^https?:\/\//i.test(text)) text = `https://${text}`;
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const host = url.hostname.toLowerCase();
    if (!host.includes(".") || host.endsWith(".bing.com") || host === "bing.com") return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function dedupe(results: WebResult[]): WebResult[] {
  const seen = new Set<string>();
  const out: WebResult[] = [];
  for (const result of results) {
    if (seen.has(result.url)) continue;
    seen.add(result.url);
    out.push(result);
  }
  return out;
}

export function parseBingHtml(html: string): WebResult[] {
  const parts = html.split(/<li class="b_algo"/i).slice(1);
  const out: WebResult[] = [];
  for (const part of parts) {
    const block = part.slice(0, 30000);
    const heading = /<h2\b[^>]*>([\s\S]*?)<\/h2>/i.exec(block);
    if (!heading) continue;
    const title = cleanText(heading[1]);
    if (!title) continue;
    const citeMatch = /<cite\b[^>]*>([\s\S]*?)<\/cite>/i.exec(block);
    const url = citeMatch ? citeToUrl(cleanText(citeMatch[1])) : null;
    if (!url) continue;
    const caption = /class="b_caption"[\s\S]*?<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(block);
    const paragraph = caption ?? /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(block);
    const snippet = paragraph
      ? cleanText(paragraph[1]).replace(/\s*devamını oku\s*$/i, "")
      : "";
    out.push({ title, url, display: displayOf(url), snippet });
    if (out.length >= 10) break;
  }
  return dedupe(out);
}

function splitLong(text: string): string[] {
  if (text.length <= 420) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > 420) {
    let cut = rest.lastIndexOf(". ", 420);
    if (cut < 160) cut = 420;
    else cut += 1;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
    if (parts.length >= 24) break;
  }
  if (rest && parts.length < 24) parts.push(rest);
  return parts.filter(Boolean);
}

export function blocksFromPlain(text: string): ReaderBlock[] {
  const blocks: ReaderBlock[] = [];
  const normalized = text
    .replace(/\r/g, "")
    .replace(/\s(={2,})\s*(.+?)\s*\1\s/g, "\n\n$2\n\n");
  const chunks = normalized
    .split(/\n{2,}/)
    .map((chunk) => chunk.trim())
    .filter(Boolean);
  for (const chunk of chunks) {
    const lines = chunk
      .split(/\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    for (const line of lines) {
      const heading = /^(={2,})\s*(.+?)\s*\1$/.exec(line);
      if (heading) {
        const label = cleanText(heading[2]);
        if (label) blocks.push({ type: "h", text: label });
      } else if (line.startsWith("## ")) {
        const label = cleanText(line.slice(3));
        if (label) blocks.push({ type: "h", text: label });
      } else {
        for (const part of splitLong(cleanText(line))) {
          blocks.push({ type: "p", text: part });
          if (blocks.length >= 70) return blocks;
        }
      }
      if (blocks.length >= 70) return blocks;
    }
  }
  return blocks;
}

export function htmlToReader(html: string): { title: string; blocks: ReaderBlock[] } {
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? cleanText(titleMatch[1]) : "";
  const article = /<article\b[\s\S]*?<\/article>/i.exec(html);
  const main = /<main\b[\s\S]*?<\/main>/i.exec(html);
  let body = article?.[0] ?? main?.[0] ?? html;
  body = body
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer\b[\s\S]*?<\/footer>/gi, " ")
    .replace(/<header\b[\s\S]*?<\/header>/gi, " ")
    .replace(/<aside\b[\s\S]*?<\/aside>/gi, " ")
    .replace(/<form\b[\s\S]*?<\/form>/gi, " ")
    .replace(/<h[1-3]\b[^>]*>/gi, "\n## ")
    .replace(/<\/(p|div|h1|h2|h3|li|tr|section|article|blockquote)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n");
  return { title, blocks: blocksFromPlain(body) };
}

export function htmlLinks(html: string, base: string): { title: string; url: string }[] {
  const links: { title: string; url: string }[] = [];
  const seen = new Set<string>();
  const re = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    const title = cleanText(match[2]);
    if (!title || title.length < 2 || title.length > 80) continue;
    let url: URL;
    try {
      url = new URL(match[1], base);
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    url.hash = "";
    const href = url.toString();
    if (seen.has(href) || href === base) continue;
    seen.add(href);
    links.push({ title, url: href });
    if (links.length >= 8) break;
  }
  return links;
}

function parseExpr(s: string, i: { n: number }): number {
  let value = parseTerm(s, i);
  while (s[i.n] === "+" || s[i.n] === "-") {
    const op = s[i.n];
    i.n += 1;
    const right = parseTerm(s, i);
    value = op === "+" ? value + right : value - right;
  }
  return value;
}

function parseTerm(s: string, i: { n: number }): number {
  let value = parsePower(s, i);
  while (s[i.n] === "*" || s[i.n] === "/" || s[i.n] === "%") {
    if (s[i.n] === "*" && s[i.n + 1] === "*") break;
    const op = s[i.n];
    i.n += 1;
    const right = parsePower(s, i);
    if (op === "*") value *= right;
    else if (op === "/") value /= right;
    else value %= right;
  }
  return value;
}

function parsePower(s: string, i: { n: number }): number {
  const value = parseUnary(s, i);
  if (s[i.n] === "*" && s[i.n + 1] === "*") {
    i.n += 2;
    return value ** parsePower(s, i);
  }
  return value;
}

function parseUnary(s: string, i: { n: number }): number {
  if (s[i.n] === "+") {
    i.n += 1;
    return parseUnary(s, i);
  }
  if (s[i.n] === "-") {
    i.n += 1;
    return -parseUnary(s, i);
  }
  return parsePrimary(s, i);
}

function parsePrimary(s: string, i: { n: number }): number {
  if (s[i.n] === "(") {
    i.n += 1;
    const value = parseExpr(s, i);
    if (s[i.n] !== ")") throw new Error("paren");
    i.n += 1;
    return value;
  }
  const start = i.n;
  if (s[i.n] === ".") i.n += 1;
  while (i.n < s.length && /[\d.]/.test(s[i.n] ?? "")) i.n += 1;
  if (start === i.n) throw new Error("num");
  const value = Number(s.slice(start, i.n));
  if (!Number.isFinite(value)) throw new Error("num");
  return value;
}

export function mathInstant(query: string): { value: string } | null {
  const compact = query
    .trim()
    .toLowerCase()
    .replace(/,/g, ".")
    .replace(/[x×]/g, "*")
    .replace(/÷/g, "/")
    .replace(/\^/g, "**")
    .replace(/\s+/g, "");
  if (!compact || compact.length > 48) return null;
  if (!/^[\d.+\-*/()%]+$/.test(compact.replace(/\*\*/g, ""))) return null;
  if (!/\d/.test(compact) || !/[+\-*/%]/.test(compact)) return null;
  try {
    const cursor = { n: 0 };
    const value = parseExpr(compact, cursor);
    if (cursor.n !== compact.length || !Number.isFinite(value)) return null;
    const shown =
      Math.abs(value) >= 1e12 || (Math.abs(value) > 0 && Math.abs(value) < 1e-6)
        ? value.toExponential(4)
        : String(Math.round(value * 1e10) / 1e10);
    return { value: shown };
  } catch {
    return null;
  }
}

export function clockInstant(query: string): { value: string; detail: string } | null {
  if (!/^(saat\s*kaç|saat|bugünün?\s*tarihi|tarih|bugün)\s*\??$/i.test(query.trim())) {
    return null;
  }
  const now = new Date();
  return {
    value: new Intl.DateTimeFormat("tr-TR", {
      timeZone: "Europe/Istanbul",
      hour: "2-digit",
      minute: "2-digit",
    }).format(now),
    detail: new Intl.DateTimeFormat("tr-TR", {
      timeZone: "Europe/Istanbul",
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(now),
  };
}

export function weatherPlace(query: string): string | null {
  const match = query
    .trim()
    .match(/^(.*?)(?:hava\s*durumu|\bhava\b|weather)(.*)$/i);
  if (!match) return null;
  const place = `${match[1]} ${match[2]}`
    .replace(/\b(bugün|yarın|nasıl|nedir|için|lütfen)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return place || "İstanbul";
}

export function weatherLabel(code: number): string {
  if (code === 0) return "Açık";
  if (code === 1) return "Çoğunlukla açık";
  if (code === 2) return "Parçalı bulutlu";
  if (code === 3) return "Kapalı";
  if (code === 45 || code === 48) return "Sisli";
  if (code >= 51 && code <= 57) return "Çisenti";
  if (code >= 61 && code <= 67) return "Yağmurlu";
  if (code >= 71 && code <= 77) return "Karlı";
  if (code >= 80 && code <= 82) return "Sağanak";
  if (code >= 85 && code <= 86) return "Kar sağanağı";
  if (code >= 95) return "Gök gürültülü";
  return "Değişken";
}
