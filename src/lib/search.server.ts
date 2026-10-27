import { lookup } from "node:dns/promises";
import {
  blocksFromPlain,
  cleanText,
  clockInstant,
  displayOf,
  htmlLinks,
  htmlToReader,
  mathInstant,
  parseBingHtml,
  weatherLabel,
  weatherPlace,
} from "./parse-web.ts";
import type {
  Instant,
  Knowledge,
  PageResponse,
  SearchResponse,
  WebResult,
} from "./search-types.ts";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const cache = new Map<string, { at: number; value: SearchResponse | PageResponse }>();

function remember<T extends SearchResponse | PageResponse>(key: string, value: T): T {
  if (cache.size > 80) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, { at: Date.now(), value });
  return value;
}

function recall<T>(key: string, ttl: number): T | null {
  const hit = cache.get(key);
  if (!hit || Date.now() - hit.at > ttl) return null;
  return hit.value as T;
}

function isBlockedIp(ip: string): boolean {
  const value = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (value.includes(":")) {
    if (value === "::1" || value === "::") return true;
    if (value.startsWith("fe80:") || value.startsWith("fc") || value.startsWith("fd")) return true;
    const mapped = /:ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
    return mapped ? isBlockedIp(mapped[1]) : false;
  }
  const parts = value.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

async function assertPublic(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Adres geçersiz");
  }
  if (url.username || url.password) throw new Error("Adres geçersiz");
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Sadece web adresleri açılır");
  }
  const host = url.hostname.toLowerCase();
  if (
    !host ||
    host === "localhost" ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".localhost") ||
    host === "metadata.google.internal"
  ) {
    throw new Error("Bu adres açılamıyor");
  }
  if (host.includes(":") || /^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    if (isBlockedIp(host)) throw new Error("Bu adres açılamıyor");
  }
  let records: { address: string }[];
  try {
    records = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error("Adres bulunamadı");
  }
  if (records.length === 0 || records.some((record) => isBlockedIp(record.address))) {
    throw new Error("Bu adres açılamıyor");
  }
  return url;
}

async function readBytes(response: Response, max: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new Error("Sayfa çok büyük");
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return all;
}

function decodeBytes(bytes: Uint8Array, contentType: string): string {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 900));
  const match =
    /charset=["']?([\w:-]+)/i.exec(contentType) || /charset=["']?([\w:-]+)/i.exec(head);
  let encoding = (match?.[1] || "utf-8").toLowerCase();
  if (encoding === "iso-8859-9" || encoding === "latin5") encoding = "windows-1254";
  try {
    return new TextDecoder(encoding).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

async function fetchPublic(raw: string, maxBytes: number): Promise<{ url: string; type: string; text: string }> {
  let current = raw;
  for (let hop = 0; hop < 4; hop += 1) {
    const safe = await assertPublic(current);
    const response = await fetch(safe.toString(), {
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
      headers: {
        "user-agent": UA,
        accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        "accept-language": "tr-TR,tr;q=0.9,en;q=0.6",
      },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("Sayfa yönlendiremedi");
      current = new URL(location, safe).toString();
      continue;
    }
    if (!response.ok) throw new Error(`Sayfa yanıt vermedi (${response.status})`);
    const type = response.headers.get("content-type") || "";
    const bytes = await readBytes(response, maxBytes);
    return { url: safe.toString(), type, text: decodeBytes(bytes, type) };
  }
  throw new Error("Çok fazla yönlendirme");
}

async function fetchBing(query: string, page: number): Promise<WebResult[]> {
  const first = (page - 1) * 10 + 1;
  const target = `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=tr&cc=TR&first=${first}`;
  const response = await fetchPublic(target, 900_000);
  return parseBingHtml(response.text);
}

async function fetchWikiResults(query: string, page: number): Promise<WebResult[]> {
  const offset = (page - 1) * 10;
  const target =
    "https://tr.wikipedia.org/w/api.php?action=query&list=search&format=json&utf8=1&srlimit=10&srprop=snippet" +
    `&sroffset=${offset}&srsearch=${encodeURIComponent(query)}`;
  const response = await fetch(target, {
    signal: AbortSignal.timeout(8000),
    headers: { "user-agent": UA, accept: "application/json" },
  });
  if (!response.ok) return [];
  const data = (await response.json()) as {
    query?: { search?: { title?: string; snippet?: string }[] };
  };
  return (data.query?.search ?? []).flatMap((item) => {
    if (!item.title) return [];
    const url = `https://tr.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/ /g, "_"))}`;
    return [
      {
        title: item.title,
        url,
        display: displayOf(url),
        snippet: cleanText(item.snippet ?? ""),
      },
    ];
  });
}

async function fetchSummary(title: string): Promise<Knowledge | null> {
  const target = `https://tr.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
  const response = await fetch(target, {
    signal: AbortSignal.timeout(6000),
    headers: { "user-agent": UA, accept: "application/json" },
  });
  if (!response.ok) return null;
  const data = (await response.json()) as {
    title?: string;
    description?: string;
    extract?: string;
    type?: string;
    thumbnail?: { source?: string };
    content_urls?: { desktop?: { page?: string } };
  };
  if (!data.title || typeof data.extract !== "string" || data.extract.length < 40) return null;
  const page = data.content_urls?.desktop?.page;
  if (!page) return null;
  return {
    title: data.title,
    description: data.description || "Vikipedi",
    extract: data.extract.slice(0, 460),
    url: page,
    image: typeof data.thumbnail?.source === "string" ? data.thumbnail.source : undefined,
  };
}

function knowledgeFits(query: string, card: Knowledge): boolean {
  const norm = (value: string) =>
    value.toLocaleLowerCase("tr-TR").replace(/[^a-z0-9çğıöşü\s]/gi, " ");
  const words = norm(query)
    .split(/\s+/)
    .filter((word) => word.length > 2);
  const title = norm(card.title);
  if (words.length === 0) return false;
  const hits = words.filter((word) => title.includes(word)).length;
  return hits >= Math.ceil(words.length / 2);
}

async function fetchWeather(place: string): Promise<Instant | null> {
  const geo = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=1&language=tr&format=json`,
    { signal: AbortSignal.timeout(6000), headers: { accept: "application/json" } },
  );
  if (!geo.ok) return null;
  const found = (await geo.json()) as {
    results?: { name?: string; latitude?: number; longitude?: number; admin1?: string; country?: string }[];
  };
  const hit = found.results?.[0];
  if (!hit || typeof hit.latitude !== "number" || typeof hit.longitude !== "number") return null;
  const forecast = await fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${hit.latitude}&longitude=${hit.longitude}&current=temperature_2m,weather_code&timezone=auto`,
    { signal: AbortSignal.timeout(6000), headers: { accept: "application/json" } },
  );
  if (!forecast.ok) return null;
  const data = (await forecast.json()) as {
    current?: { temperature_2m?: number; weather_code?: number };
  };
  if (typeof data.current?.temperature_2m !== "number") return null;
  const placeName = hit.name || place;
  const region = hit.admin1 && hit.admin1 !== hit.name ? hit.admin1 : hit.country;
  const where = [placeName, region].filter(Boolean).join(", ");
  return {
    kind: "weather",
    title: "Hava",
    value: `${Math.round(data.current.temperature_2m)}°`,
    detail: `${weatherLabel(data.current.weather_code ?? -1)} · ${where}`,
  };
}

async function fetchInstant(query: string): Promise<Instant | null> {
  const math = mathInstant(query);
  if (math) return { kind: "math", title: "Hesap", value: math.value };
  const clock = clockInstant(query);
  if (clock) return { kind: "clock", title: "İstanbul", value: clock.value, detail: clock.detail };
  const place = weatherPlace(query);
  if (!place) return null;
  return fetchWeather(place);
}

function wikiTitleFromUrl(url: string): { lang: string; title: string } | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^([\w-]+)\.m\.wikipedia\.org$/i, "$1.wikipedia.org");
    const match = /^([\w-]+)\.wikipedia\.org$/i.exec(host);
    if (!match) return null;
    const path = decodeURIComponent(parsed.pathname);
    const article = /^\/wiki\/(.+)$/.exec(path);
    if (!article || article[1].includes(":")) return null;
    return { lang: match[1].toLowerCase(), title: article[1].replace(/_/g, " ") };
  } catch {
    return null;
  }
}

export async function runSearch(input: { q: string; page: number }): Promise<SearchResponse> {
  const key = `s:${input.page}:${input.q.toLowerCase()}`;
  const cached = recall<SearchResponse>(key, 120_000);
  if (cached) return cached;

  const [bing, wiki, instant, direct] = await Promise.all([
    fetchBing(input.q, input.page).catch(() => null),
    fetchWikiResults(input.q, input.page).catch(() => null),
    input.page === 1 ? fetchInstant(input.q).catch(() => null) : Promise.resolve(null),
    input.page === 1 && !mathInstant(input.q) && !weatherPlace(input.q)
      ? fetchSummary(input.q).catch(() => null)
      : Promise.resolve(null),
  ]);

  if (bing === null && wiki === null && !instant) {
    throw new Error("Arama şu an yapılamıyor");
  }

  let knowledge = direct;
  const wikiRows = wiki ?? [];
  if (
    !knowledge &&
    input.page === 1 &&
    input.q.split(/\s+/).length <= 4 &&
    wikiRows[0] &&
    !weatherPlace(input.q)
  ) {
    knowledge = await fetchSummary(wikiRows[0].title).catch(() => null);
  }

  if (knowledge && !knowledgeFits(input.q, knowledge)) knowledge = null;

  const web = bing ?? [];
  const useWeb = web.length > 0;
  const results = useWeb ? web : wikiRows;
  const response: SearchResponse = {
    query: input.q,
    page: input.page,
    source: useWeb ? "web" : "vikipedi",
    instant,
    knowledge,
    results,
    hasMore: results.length >= 10 && input.page < 8,
  };
  if (results.length === 0 && !instant && !knowledge && bing === null && wiki === null) {
    throw new Error("Arama şu an yapılamıyor");
  }
  return remember(key, response);
}

export async function runRead(input: { url: string }): Promise<PageResponse> {
  const key = `p:${input.url}`;
  const cached = recall<PageResponse>(key, 300_000);
  if (cached) return cached;

  const wiki = wikiTitleFromUrl(input.url);
  if (wiki) {
    const api =
      `https://${wiki.lang}.wikipedia.org/w/api.php?action=query&prop=extracts|links&explaintext=1` +
      `&exchars=9000&plnamespace=0&pllimit=8&redirects=1&format=json&titles=${encodeURIComponent(wiki.title)}`;
    const response = await fetch(api, {
      signal: AbortSignal.timeout(8000),
      headers: { "user-agent": UA, accept: "application/json" },
    });
    if (response.ok) {
      const data = (await response.json()) as {
        query?: {
          pages?: Record<
            string,
            { title?: string; extract?: string; missing?: string; links?: { title?: string }[] }
          >;
        };
      };
      const page = Object.values(data.query?.pages ?? {})[0];
      if (page && !("missing" in page && page.missing !== undefined) && page.extract) {
        const title = page.title || wiki.title;
        const result: PageResponse = {
          url: `https://${wiki.lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`,
          title,
          site: `${wiki.lang}.wikipedia.org`,
          blocks: blocksFromPlain(page.extract),
          links: (page.links ?? []).flatMap((link) => {
            if (!link.title || link.title.includes(":")) return [];
            return [
              {
                title: link.title,
                url: `https://${wiki.lang}.wikipedia.org/wiki/${encodeURIComponent(link.title.replace(/ /g, "_"))}`,
              },
            ];
          }),
        };
        return remember(key, result);
      }
    }
  }

  const fetched = await fetchPublic(input.url, 1_200_000);
  const site = new URL(fetched.url).hostname.replace(/^www\./, "");
  if (fetched.type && !/text\/html|application\/xhtml|text\/plain|application\/json/i.test(fetched.type)) {
    return remember(key, {
        url: fetched.url,
        title: site,
        site,
        blocks: [
          {
            type: "p",
            text: "Bu adres bir yazı sayfası değil. Orijinalini yeni sekmede açabilirsin.",
          },
        ],
        links: [],
      },
    );
  }
  const reader = htmlToReader(fetched.text);
  const blocks = reader.blocks.filter((block) => block.text.length > 1).slice(0, 70);
  const result: PageResponse = {
    url: fetched.url,
    title: reader.title || site,
    site,
    blocks:
      blocks.length > 0
        ? blocks
        : [{ type: "p", text: "Bu sayfadan okunabilir bir metin çıkmadı. Orijinalini açmayı dene." }],
    links: htmlLinks(fetched.text, fetched.url),
  };
  return remember(key, result);
}
