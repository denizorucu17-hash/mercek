import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe,
  Home,
  Menu,
  Plus,
  RotateCw,
  Search,
  Star,
  X,
} from "lucide-react";
import { readPage, searchWeb } from "@/lib/web.functions";
import type { PageResponse, SearchResponse } from "@/lib/search-types";

type Loc =
  | { kind: "home" }
  | { kind: "search"; query: string; page: number }
  | { kind: "page"; url: string; hint?: string };

type Tab = {
  id: string;
  title: string;
  stack: Loc[];
  index: number;
  loading: boolean;
  error: string | null;
  search?: SearchResponse;
  page?: PageResponse;
};

type Visit = { id: string; title: string; at: number; loc: Loc };
type Bookmark = { id: string; title: string; loc: Loc };

const searchCache = new Map<string, SearchResponse>();
const pageCache = new Map<string, PageResponse>();
const inflight = new Map<string, Promise<SearchResponse | PageResponse>>();
const gens = new Map<string, number>();

function searchKey(query: string, page: number) {
  return `s:${page}:${query}`;
}

function invalidate(key: string) {
  searchCache.delete(key);
  pageCache.delete(key);
  inflight.delete(key);
  gens.set(key, (gens.get(key) ?? 0) + 1);
}

function loadSearch(query: string, page: number): Promise<SearchResponse> {
  const key = searchKey(query, page);
  const hit = searchCache.get(key);
  if (hit) return Promise.resolve(hit);
  const pending = inflight.get(key);
  if (pending) return pending as Promise<SearchResponse>;
  const token = gens.get(key) ?? 0;
  const promise = searchWeb({ data: { q: query, page } })
    .then((res) => {
      if ((gens.get(key) ?? 0) === token) searchCache.set(key, res);
      inflight.delete(key);
      return res;
    })
    .catch((error: unknown) => {
      inflight.delete(key);
      throw error;
    });
  inflight.set(key, promise);
  return promise;
}

function loadPage(url: string): Promise<PageResponse> {
  const key = `p:${url}`;
  const hit = pageCache.get(key);
  if (hit) return Promise.resolve(hit);
  const pending = inflight.get(key);
  if (pending) return pending as Promise<PageResponse>;
  const token = gens.get(key) ?? 0;
  const promise = readPage({ data: { url } })
    .then((res) => {
      if ((gens.get(key) ?? 0) === token) pageCache.set(key, res);
      inflight.delete(key);
      return res;
    })
    .catch((error: unknown) => {
      inflight.delete(key);
      throw error;
    });
  inflight.set(key, promise);
  return promise;
}

function sameLoc(a: Loc, b: Loc) {
  if (a.kind !== b.kind) return false;
  if (a.kind === "home" && b.kind === "home") return true;
  if (a.kind === "search" && b.kind === "search") return a.query === b.query && a.page === b.page;
  if (a.kind === "page" && b.kind === "page") return a.url === b.url;
  return false;
}

function locKey(loc: Loc) {
  if (loc.kind === "home") return "home";
  if (loc.kind === "search") return `search:${loc.query}`;
  return `page:${loc.url}`;
}

function titleFor(loc: Loc) {
  if (loc.kind === "home") return "Yeni sekme";
  if (loc.kind === "search") return loc.query;
  return loc.hint || "Sayfa";
}

function omniboxText(loc: Loc) {
  if (loc.kind === "search") return loc.query;
  if (loc.kind === "page") return loc.url;
  return "";
}

function parseBox(input: string): Loc | null {
  const text = input.trim();
  if (!text) return null;
  if (/^https?:\/\//i.test(text)) return { kind: "page", url: text };
  if (/^[\w.-]+\.[a-z]{2,}([/:?#].*)?$/i.test(text) && !text.includes(" ")) {
    return { kind: "page", url: `https://${text}` };
  }
  return { kind: "search", query: text, page: 1 };
}

function errorText(error: unknown) {
  return error instanceof Error && error.message ? error.message : "Bir şeyler ters gitti";
}

function freshTab(id: string): Tab {
  return {
    id,
    title: "Yeni sekme",
    stack: [{ kind: "home" }],
    index: 0,
    loading: false,
    error: null,
  };
}

export function Mercek() {
  const [tabs, setTabs] = useState<Tab[]>([freshTab("tab-1")]);
  const [activeId, setActiveId] = useState("tab-1");
  const [tick, setTick] = useState(0);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [visits, setVisits] = useState<Visit[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [panel, setPanel] = useState<"history" | "bookmarks" | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const seq = useRef(2);
  const visitSeq = useRef(1);
  const api = useRef({
    newTab: () => {},
    closeTab: (_id: string) => {},
    back: () => {},
    forward: () => {},
    activeId: "tab-1",
  });

  const tab = tabs.find((item) => item.id === activeId) ?? tabs[0];
  const loc = tab.stack[tab.index] ?? { kind: "home" as const };
  const locationKey = locKey(loc) + JSON.stringify(loc);

  useEffect(() => {
    try {
      const raw = localStorage.getItem("mercek-v1");
      const parsed = raw ? (JSON.parse(raw) as { bookmarks?: Bookmark[]; visits?: Visit[] }) : {};
      const storedMarks = Array.isArray(parsed.bookmarks) ? parsed.bookmarks.slice(0, 40) : [];
      const storedVisits = Array.isArray(parsed.visits) ? parsed.visits.slice(0, 50) : [];
      setBookmarks((current) => (current.length ? current : storedMarks));
      setVisits((current) => {
        const ids = new Set(current.map((item) => item.id));
        return [...current, ...storedVisits.filter((item) => !ids.has(item.id))].slice(0, 50);
      });
    } catch {
      /* keep empty */
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem("mercek-v1", JSON.stringify({ bookmarks, visits }));
  }, [hydrated, bookmarks, visits]);

  useEffect(() => {
    document.title = tab.title === "Yeni sekme" ? "Google" : `${tab.title} - Google'da Ara`;
  }, [tab.title]);

  useEffect(() => {
    let cancel = false;
    const myId = tab.id;
    const here = loc;
    if (here.kind === "home") {
      setTabs((current) =>
        current.map((item) => (item.id === myId ? { ...item, loading: false, error: null } : item)),
      );
      return;
    }
    const cached = here.kind === "search" ? searchCache.get(searchKey(here.query, here.page)) : pageCache.get(`p:${here.url}`);
    if (!cached) {
      setTabs((current) =>
        current.map((item) => {
          if (item.id !== myId) return item;
          if (!sameLoc(item.stack[item.index], here)) return item;
          return { ...item, loading: true, error: null };
        }),
      );
    }
    const run = async () => {
      try {
        if (here.kind === "search") {
          const res = await loadSearch(here.query, here.page);
          if (cancel) return;
          setTabs((current) =>
            current.map((item) => {
              if (item.id !== myId || !sameLoc(item.stack[item.index], here)) return item;
              return { ...item, loading: false, error: null, search: res, title: here.query };
            }),
          );
        } else if (here.kind === "page") {
          const res = await loadPage(here.url);
          if (cancel) return;
          setTabs((current) =>
            current.map((item) => {
              if (item.id !== myId || !sameLoc(item.stack[item.index], here)) return item;
              return { ...item, loading: false, error: null, page: res, title: res.title || item.title };
            }),
          );
        }
      } catch (error) {
        if (cancel) return;
        setTabs((current) =>
          current.map((item) => {
            if (item.id !== myId || !sameLoc(item.stack[item.index], here)) return item;
            return { ...item, loading: false, error: errorText(error) };
          }),
        );
      }
    };
    void run();
    return () => {
      cancel = true;
    };
    // locationKey captures the active location; tab id is included via it changing with active tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, locationKey, tick]);

  function rememberVisit(next: Loc, title: string) {
    if (next.kind === "home") return;
    const id = `v${visitSeq.current++}`;
    setVisits((current) => [{ id, title, at: Date.now(), loc: next }, ...current].slice(0, 50));
  }

  function navigate(next: Loc, title?: string) {
    const label = title || titleFor(next);
    setDraft(null);
    setSuggestOpen(false);
    setMenuOpen(false);
    setPanel(null);
    setTabs((current) =>
      current.map((item) => {
        if (item.id !== activeId) return item;
        const cur = item.stack[item.index];
        if (sameLoc(cur, next)) return item;
        const stack = item.stack.slice(0, item.index + 1).concat(next);
        const cached =
          next.kind === "search"
            ? searchCache.get(searchKey(next.query, next.page))
            : next.kind === "page"
              ? pageCache.get(`p:${next.url}`)
              : undefined;
        return {
          ...item,
          stack,
          index: stack.length - 1,
          title: label,
          loading: next.kind !== "home" && !cached,
          error: null,
          search: next.kind === "search" && cached ? (cached as SearchResponse) : undefined,
          page: next.kind === "page" && cached ? (cached as PageResponse) : undefined,
        };
      }),
    );
    rememberVisit(next, label);
  }

  function back() {
    setTabs((current) =>
      current.map((item) => {
        if (item.id !== activeId || item.index === 0) return item;
        const index = item.index - 1;
        return { ...item, index, title: titleFor(item.stack[index]), error: null };
      }),
    );
  }

  function forward() {
    setTabs((current) =>
      current.map((item) => {
        if (item.id !== activeId || item.index >= item.stack.length - 1) return item;
        const index = item.index + 1;
        return { ...item, index, title: titleFor(item.stack[index]), error: null };
      }),
    );
  }

  function reload() {
    if (loc.kind === "search") invalidate(searchKey(loc.query, loc.page));
    if (loc.kind === "page") invalidate(`p:${loc.url}`);
    setTick((value) => value + 1);
  }

  function newTab() {
    const id = `tab-${seq.current++}`;
    setTabs((current) => [...current, freshTab(id)]);
    setActiveId(id);
    setDraft(null);
    setMenuOpen(false);
    setPanel(null);
  }

  function closeTab(id: string) {
    setTabs((current) => {
      if (current.length === 1) return [freshTab(current[0].id)];
      return current.filter((item) => item.id !== id);
    });
    if (activeId === id) {
      const index = tabs.findIndex((item) => item.id === id);
      const rest = tabs.filter((item) => item.id !== id);
      if (rest.length === 0) setActiveId(tabs[0].id);
      else setActiveId(rest[Math.max(0, index - 1)].id);
    }
  }

  api.current = { newTab, closeTab, back, forward, activeId };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === "t") {
        event.preventDefault();
        api.current.newTab();
      } else if (meta && event.key.toLowerCase() === "w") {
        event.preventDefault();
        api.current.closeTab(api.current.activeId);
      } else if (event.altKey && event.key === "ArrowLeft") {
        event.preventDefault();
        api.current.back();
      } else if (event.altKey && event.key === "ArrowRight") {
        event.preventDefault();
        api.current.forward();
      } else if (event.key === "Escape") {
        setMenuOpen(false);
        setPanel(null);
        setSuggestOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const shown = draft ?? omniboxText(loc);
  const suggestions = useSuggest(shown, suggestOpen);
  const historyHits = visits
    .filter((visit) => visit.title.toLowerCase().includes(shown.trim().toLowerCase()))
    .slice(0, 3);
  const options = [
    ...historyHits.map((visit) => ({ label: visit.title, loc: visit.loc, hint: "Geçmiş" })),
    ...suggestions
      .filter((item) => !historyHits.some((visit) => visit.title === item))
      .map((item) => ({ label: item, loc: { kind: "search", query: item, page: 1 } as Loc, hint: "Öneri" })),
  ].slice(0, 7);

  function submit(raw: string) {
    const next = parseBox(raw);
    if (!next) return;
    navigate(next, next.kind === "search" ? next.query : undefined);
  }

  function choose(index: number) {
    const option = options[index];
    if (!option) {
      submit(shown);
      return;
    }
    navigate(option.loc, option.label);
  }

  const marked = bookmarks.some((item) => locKey(item.loc) === locKey(loc));

  function toggleBookmark() {
    if (loc.kind === "home") return;
    const key = locKey(loc);
    setBookmarks((current) => {
      if (current.some((item) => locKey(item.loc) === key)) {
        return current.filter((item) => locKey(item.loc) !== key);
      }
      return [{ id: `b${Date.now()}`, title: tab.title, loc }, ...current].slice(0, 40);
    });
  }

  return (
    <div className="shell flex h-dvh flex-col overflow-hidden bg-paper text-ink">
      <div className="bg-tab px-2 pt-2">
        <div className="flex items-end gap-1 overflow-x-auto">
          {tabs.map((item) => {
            const active = item.id === tab.id;
            return (
              <div
                key={item.id}
                className={
                  "flex h-11 min-w-0 max-w-52 shrink-0 items-stretch rounded-t-xl " +
                  (active ? "bg-paper text-ink" : "text-muted hover:bg-line")
                }
              >
                <button
                  type="button"
                  onClick={() => {
                    setActiveId(item.id);
                    setDraft(null);
                    setSuggestOpen(false);
                  }}
                  className="min-w-16 truncate px-3 text-left text-sm"
                >
                  {item.title}
                </button>
                <button
                  type="button"
                  aria-label={`${item.title} sekmesini kapat`}
                  onClick={() => closeTab(item.id)}
                  className="grid w-11 place-items-center"
                >
                  <X className="size-4" />
                </button>
              </div>
            );
          })}
          <button
            type="button"
            aria-label="Yeni sekme"
            onClick={newTab}
            className="mb-1 grid size-11 shrink-0 place-items-center rounded-xl text-muted hover:bg-line hover:text-ink"
          >
            <Plus className="size-5" />
          </button>
        </div>
      </div>

      <div className="relative flex items-center gap-1 border-b border-line bg-paper px-1 sm:px-2">
        <IconButton label="Geri" disabled={tab.index === 0} onClick={back}>
          <ArrowLeft className="size-5" />
        </IconButton>
        <IconButton label="İleri" disabled={tab.index >= tab.stack.length - 1} onClick={forward}>
          <ArrowRight className="size-5" />
        </IconButton>
        <IconButton label="Yenile" onClick={reload} disabled={loc.kind === "home"}>
          <RotateCw className={"size-5 " + (tab.loading ? "animate-spin" : "")} />
        </IconButton>
        <span className="hidden sm:contents">
          <IconButton label="Ana sayfa" onClick={() => navigate({ kind: "home" })}>
            <Home className="size-5" />
          </IconButton>
        </span>
        <form
          className="relative my-2 flex h-11 min-w-0 flex-1 items-center gap-2 rounded-full border border-transparent bg-chrome px-3 focus-within:border-line focus-within:bg-paper focus-within:shadow-sm"
          onSubmit={(event) => {
            event.preventDefault();
            if (highlight >= 0) choose(highlight);
            else submit(shown);
          }}
        >
          <Globe className="size-4 shrink-0 text-muted" />
          <input
            aria-label="Ara veya adres yaz"
            value={shown}
            placeholder="Google'da ara veya adres yaz"
            className="h-full min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted"
            onChange={(event) => {
              setDraft(event.target.value);
              setSuggestOpen(true);
              setHighlight(-1);
            }}
            onFocus={() => {
              setDraft(omniboxText(loc));
              setSuggestOpen(true);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setHighlight((value) => Math.min(options.length - 1, value + 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setHighlight((value) => Math.max(-1, value - 1));
              }
            }}
          />
          {suggestOpen && options.length > 0 && (
            <ul className="absolute top-12 right-0 left-0 z-20 overflow-hidden rounded-2xl border border-line bg-sheet shadow-sm">
              {options.map((option, index) => (
                <li key={`${option.hint}-${option.label}`}>
                  <button
                    type="button"
                    className={
                      "flex min-h-11 w-full items-center justify-between gap-3 px-3 text-left text-sm " +
                      (index === highlight ? "bg-chrome" : "hover:bg-chrome")
                    }
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => navigate(option.loc, option.label)}
                  >
                    <span className="truncate">{option.label}</span>
                    <span className="shrink-0 text-xs text-muted">{option.hint}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </form>
        <IconButton
          label={marked ? "Yer imini kaldır" : "Yer imi ekle"}
          onClick={toggleBookmark}
          disabled={loc.kind === "home"}
        >
          <Star className={"size-5 " + (marked ? "fill-blue text-blue" : "")} />
        </IconButton>
        <IconButton
          label="Menü"
          onClick={() => {
            setMenuOpen((open) => !open);
            setSuggestOpen(false);
          }}
        >
          <Menu className="size-5" />
        </IconButton>
        {menuOpen && (
          <>
            <button
              type="button"
              aria-label="Menüyü kapat"
              className="fixed inset-0 z-20 cursor-default"
              onClick={() => setMenuOpen(false)}
            />
            <div className="absolute top-14 right-2 z-30 w-56 rounded-2xl border border-line bg-sheet p-1 shadow-sm">
              <MenuItem
                label="Yeni sekme"
                onClick={newTab}
              />
              <MenuItem
                label="Geçmiş"
                onClick={() => {
                  setPanel("history");
                  setMenuOpen(false);
                }}
              />
              <MenuItem
                label="Yer imleri"
                onClick={() => {
                  setPanel("bookmarks");
                  setMenuOpen(false);
                }}
              />
              <MenuItem label="Ana sayfa" onClick={() => navigate({ kind: "home" })} />
            </div>
          </>
        )}
      </div>
      <div className="relative h-0.5 overflow-hidden bg-line">
        {tab.loading && <div className="loadbar absolute inset-y-0 left-0 w-1/3 bg-blue" />}
      </div>

      <main className="min-h-0 flex-1 overflow-y-auto">
        {loc.kind === "home" && (
          <HomeView
            onOpen={(next, title) => navigate(next, title)}
          />
        )}
        {loc.kind === "search" && (
          <ResultsView
            tab={tab}
            onOpen={(url, title) => navigate({ kind: "page", url, hint: title }, title)}
            onPage={(page) => {
              if (loc.kind !== "search") return;
              navigate({ kind: "search", query: loc.query, page }, loc.query);
            }}
            onRetry={reload}
          />
        )}
        {loc.kind === "page" && (
          <ReaderView tab={tab} onOpen={(url, title) => navigate({ kind: "page", url, hint: title }, title)} onRetry={reload} />
        )}
      </main>

      {panel && (
        <div className="fixed inset-0 z-40 flex justify-end">
          <button type="button" aria-label="Paneli kapat" className="absolute inset-0 bg-ink/30" onClick={() => setPanel(null)} />
          <aside className="relative flex h-full w-full max-w-sm flex-col bg-sheet">
            <div className="flex h-14 items-center justify-between border-b border-line px-4">
              <h2 className="font-serif text-xl">{panel === "history" ? "Geçmiş" : "Yer imleri"}</h2>
              <button type="button" aria-label="Kapat" className="grid size-11 place-items-center" onClick={() => setPanel(null)}>
                <X className="size-5" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {panel === "history" && visits.length === 0 && <EmptyNote text="Henüz bir yere gitmedin." />}
              {panel === "bookmarks" && bookmarks.length === 0 && <EmptyNote text="Yıldız, bu sayfayı saklar." />}
              {panel === "history" &&
                visits.map((visit) => (
                  <ListRow
                    key={visit.id}
                    title={visit.title}
                    detail={new Intl.DateTimeFormat("tr-TR", {
                      hour: "2-digit",
                      minute: "2-digit",
                      day: "numeric",
                      month: "short",
                    }).format(visit.at)}
                    onOpen={() => navigate(visit.loc, visit.title)}
                    onRemove={() => setVisits((current) => current.filter((item) => item.id !== visit.id))}
                  />
                ))}
              {panel === "bookmarks" &&
                bookmarks.map((item) => (
                  <ListRow
                    key={item.id}
                    title={item.title}
                    detail={item.loc.kind === "page" ? item.loc.url : item.loc.kind === "search" ? item.loc.query : "Ana sayfa"}
                    onOpen={() => navigate(item.loc, item.title)}
                    onRemove={() => setBookmarks((current) => current.filter((mark) => mark.id !== item.id))}
                  />
                ))}
            </div>
            {panel === "history" && visits.length > 0 && (
              <button
                type="button"
                className="m-3 h-11 rounded-full border border-line text-sm"
                onClick={() => setVisits([])}
              >
                Geçmişi temizle
              </button>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}

function useSuggest(query: string, open: boolean) {
  const [items, setItems] = useState<string[]>([]);
  useEffect(() => {
    const text = query.trim();
    if (!open || text.length < 2) {
      setItems([]);
      return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(
          `https://tr.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(text)}&limit=6&namespace=0&format=json&origin=*`,
          { signal: ctrl.signal },
        );
        const data = (await response.json()) as unknown[];
        const list = Array.isArray(data[1]) ? data[1].filter((item) => typeof item === "string") : [];
        setItems(list as string[]);
      } catch {
        setItems([]);
      }
    }, 160);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [query, open]);
  return items;
}

function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="grid size-11 shrink-0 place-items-center rounded-full text-ink disabled:text-line"
    >
      {children}
    </button>
  );
}

function MenuItem({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex h-11 w-full items-center rounded-xl px-3 text-left text-sm hover:bg-chrome">
      {label}
    </button>
  );
}

function EmptyNote({ text }: { text: string }) {
  return <p className="px-3 py-8 text-center text-sm text-muted">{text}</p>;
}

function ListRow({
  title,
  detail,
  onOpen,
  onRemove,
}: {
  title: string;
  detail: string;
  onOpen: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex items-center gap-1 rounded-xl hover:bg-chrome">
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 px-3 py-2 text-left">
        <span className="block truncate text-sm">{title}</span>
        <span className="block truncate text-xs text-muted">{detail}</span>
      </button>
      <button type="button" aria-label="Sil" onClick={onRemove} className="grid size-11 place-items-center text-muted">
        <X className="size-4" />
      </button>
    </div>
  );
}

function HomeView({ onOpen }: { onOpen: (loc: Loc, title?: string) => void }) {
  const [value, setValue] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const [busy, setBusy] = useState(false);
  const suggestions = useSuggest(value, open);
  const options = suggestions.map((item) => ({ label: item }));

  function go(raw: string) {
    const next = parseBox(raw);
    if (!next) return;
    onOpen(next, next.kind === "search" ? next.query : next.kind === "page" ? next.hint : undefined);
  }

  async function lucky() {
    const next = parseBox(value);
    if (!next) return;
    if (next.kind !== "search") {
      onOpen(next);
      return;
    }
    setBusy(true);
    try {
      const res = await loadSearch(next.query, 1);
      onOpen(next, next.query);
      if (res.results[0]) onOpen({ kind: "page", url: res.results[0].url, hint: res.results[0].title }, res.results[0].title);
    } catch {
      onOpen(next, next.query);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex flex-1 flex-col items-center px-4 pt-16 md:pt-28">
        <GoogleMark />
        <form
          className="relative mt-7 flex w-full max-w-xl flex-col items-center"
          onSubmit={(event) => {
            event.preventDefault();
            if (highlight >= 0 && options[highlight]) go(options[highlight].label);
            else go(value);
          }}
        >
          <div className="flex h-12 w-full items-center gap-3 rounded-full border border-line bg-paper px-4 hover:shadow-md focus-within:shadow-md">
            <Search className="size-5 shrink-0 text-muted" />
            <input
              aria-label="Google'da ara"
              value={value}
              className="h-full min-w-0 flex-1 bg-transparent text-base outline-none"
              onChange={(event) => {
                setValue(event.target.value);
                setOpen(true);
                setHighlight(-1);
              }}
              onFocus={() => setOpen(true)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setHighlight((index) => Math.min(options.length - 1, index + 1));
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setHighlight((index) => Math.max(-1, index - 1));
                }
              }}
            />
          </div>
          {open && options.length > 0 && (
            <ul className="absolute top-14 right-0 left-0 z-10 overflow-hidden rounded-2xl border border-line bg-paper shadow-md">
              {options.map((option, index) => (
                <li key={option.label}>
                  <button
                    type="button"
                    className={
                      "flex h-11 w-full items-center px-4 text-left text-sm " +
                      (index === highlight ? "bg-chrome" : "hover:bg-chrome")
                    }
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => go(option.label)}
                  >
                    {option.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-7 flex flex-wrap justify-center gap-3">
            <button type="submit" className="h-11 rounded border border-transparent bg-chrome px-4 text-sm text-ink hover:border-line hover:shadow-sm">
              Google'da Ara
            </button>
            <button
              type="button"
              disabled={!value.trim() || busy}
              onClick={() => void lucky()}
              className="h-11 rounded border border-transparent bg-chrome px-4 text-sm text-ink hover:border-line hover:shadow-sm disabled:text-muted"
            >
              {busy ? "Açılıyor…" : "Kendimi Şanslı Hissediyorum"}
            </button>
          </div>
        </form>
      </div>
      <div className="mt-auto border-t border-line bg-chrome px-5 py-3 text-sm">Türkiye</div>
    </div>
  );
}

function GoogleMark() {
  const letters: [string, string][] = [
    ["G", "text-gblue"],
    ["o", "text-gred"],
    ["o", "text-gyellow"],
    ["g", "text-gblue"],
    ["l", "text-ggreen"],
    ["e", "text-gred"],
  ];
  return (
    <h1 className="text-6xl font-normal select-none md:text-7xl">
      {letters.map(([letter, color], index) => (
        <span key={`${letter}-${index}`} className={color}>
          {letter}
        </span>
      ))}
    </h1>
  );
}

function ResultsView({
  tab,
  onOpen,
  onPage,
  onRetry,
}: {
  tab: Tab;
  onOpen: (url: string, title: string) => void;
  onPage: (page: number) => void;
  onRetry: () => void;
}) {
  const data = tab.search;
  const loc = tab.stack[tab.index];
  const page = loc.kind === "search" ? loc.page : 1;

  if (tab.error) {
    return (
      <Status
        title="Arama açılmadı"
        text={tab.error}
        action="Tekrar dene"
        onAction={onRetry}
      />
    );
  }
  if (!data) {
    return <Skeleton />;
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 md:px-8">
      <div className="flex flex-col gap-6 md:grid md:grid-cols-[minmax(0,1fr)_18rem] md:items-start">
        <div className="order-2 md:order-1">
          {data.instant && <InstantCard instant={data.instant} />}
          <p className="mb-2 px-3 text-sm text-muted">
            {data.source === "vikipedi" ? "Vikipedi sonuçları" : "Web sonuçları"}
            {page > 1 ? ` · sayfa ${page}` : ""}
          </p>
          {data.source === "vikipedi" && (
            <p className="mb-3 px-3 text-sm text-pretty text-muted">
              Genel web dizini şu an kapalı. Eldekiler Vikipedi’den.
            </p>
          )}
          {data.results.length === 0 && !data.instant && (
            <p className="px-3 py-8 font-serif text-2xl text-balance">Bu aramada bir şey çıkmadı.</p>
          )}
          <ul>
            {data.results.map((result) => (
              <li key={result.url}>
                <button
                  type="button"
                  onClick={() => onOpen(result.url, result.title)}
                  className="group block w-full px-1 py-3 text-left"
                >
                  <span className="flex items-center gap-2 text-sm text-muted">
                    <span className="grid size-7 place-items-center rounded-full bg-chrome text-xs font-semibold text-ink">
                      {result.display.replace(/^www\./, "").slice(0, 1).toUpperCase()}
                    </span>
                    <span className="truncate">{result.display}</span>
                  </span>
                  <span className="mt-1 block text-xl leading-snug text-link group-hover:underline">
                    {result.title}
                  </span>
                  {result.snippet && (
                    <span className="mt-1 line-clamp-2 block text-sm leading-relaxed text-pretty text-ink">
                      {result.snippet}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-4 flex gap-2 px-3">
            {page > 1 && (
              <button type="button" className="h-11 px-3 text-sm text-link" onClick={() => onPage(page - 1)}>
                Önceki
              </button>
            )}
            {data.hasMore && (
              <button type="button" className="h-11 px-3 text-sm text-link" onClick={() => onPage(page + 1)}>
                Sonraki
              </button>
            )}
          </div>
        </div>
        {data.knowledge && (
          <KnowledgeCard knowledge={data.knowledge} onOpen={onOpen} />
        )}
      </div>
    </div>
  );
}

function KnowledgeCard({
  knowledge,
  onOpen,
}: {
  knowledge: NonNullable<SearchResponse["knowledge"]>;
  onOpen: (url: string, title: string) => void;
}) {
  const [image, setImage] = useState(knowledge.image);
  return (
    <aside className="order-1 rounded-2xl border border-line bg-sheet p-4 md:order-2">
      {image && (
        <img
          src={image}
          alt=""
          className="mb-3 h-28 w-full rounded-xl object-cover"
          onError={() => setImage(undefined)}
        />
      )}
      <p className="text-xs font-semibold tracking-wide text-muted uppercase">Vikipedi</p>
      <h2 className="mt-1 font-serif text-2xl text-balance">{knowledge.title}</h2>
      <p className="text-sm text-muted">{knowledge.description}</p>
      <p className="mt-2 text-sm leading-relaxed text-pretty">{knowledge.extract}</p>
      <button
        type="button"
        className="mt-3 h-11 text-sm text-link"
        onClick={() => onOpen(knowledge.url, knowledge.title)}
      >
        Maddenin tamamı
      </button>
    </aside>
  );
}

function InstantCard({ instant }: { instant: SearchResponse["instant"] }) {
  if (!instant) return null;
  return (
    <section className="mb-4 rounded-2xl border border-line bg-sheet px-4 py-4">
      <p className="text-xs font-semibold tracking-wide text-muted uppercase">{instant.title}</p>
      <p className="mt-1 font-serif text-4xl tabular-nums">{instant.value}</p>
      {instant.detail && <p className="mt-1 text-sm text-muted">{instant.detail}</p>}
    </section>
  );
}

function ReaderView({
  tab,
  onOpen,
  onRetry,
}: {
  tab: Tab;
  onOpen: (url: string, title: string) => void;
  onRetry: () => void;
}) {
  const page = tab.page;
  if (tab.error) {
    return <Status title="Sayfa açılmadı" text={tab.error} action="Tekrar dene" onAction={onRetry} />;
  }
  if (!page) return <Skeleton />;
  return (
    <article className="mx-auto w-full max-w-2xl px-4 py-6 md:py-10">
      <p className="text-xs font-semibold tracking-wide text-muted uppercase">{page.site}</p>
      <h1 className="mt-2 font-serif text-3xl text-balance md:text-4xl">{page.title}</h1>
      <a
        href={page.url}
        target="_blank"
        rel="noreferrer"
        className="mt-3 inline-flex h-11 items-center gap-1 text-sm text-link"
      >
        Orijinalini aç
        <ExternalLink className="size-4" />
      </a>
      <div className="mt-6 space-y-4">
        {page.blocks.map((block, index) =>
          block.type === "h" ? (
            <h2 key={`${block.type}-${index}`} className="pt-2 font-serif text-xl text-balance">
              {block.text}
            </h2>
          ) : (
            <p key={`${block.type}-${index}`} className="font-serif text-lg leading-relaxed text-pretty">
              {block.text}
            </p>
          ),
        )}
      </div>
      {page.links.length > 0 && (
        <div className="mt-8 border-t border-line pt-4">
          <h2 className="text-sm font-semibold text-muted">Bağlantılar</h2>
          <ul className="mt-2">
            {page.links.map((link) => (
              <li key={link.url}>
                <button
                  type="button"
                  onClick={() => onOpen(link.url, link.title)}
                  className="flex min-h-11 w-full items-center text-left text-sm text-link"
                >
                  {link.title}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </article>
  );
}

function Skeleton() {
  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 px-6 py-8">
      {Array.from({ length: 5 }, (_, index) => (
        <div key={index} className="animate-pulse space-y-2 rounded-2xl bg-sheet p-4">
          <div className="h-3 w-40 rounded-full bg-chrome" />
          <div className="h-5 w-4/5 rounded-full bg-chrome" />
          <div className="h-3 w-full rounded-full bg-line" />
        </div>
      ))}
    </div>
  );
}

function Status({
  title,
  text,
  action,
  onAction,
}: {
  title: string;
  text: string;
  action: string;
  onAction: () => void;
}) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-start px-6 py-16">
      <h1 className="font-serif text-3xl text-balance">{title}</h1>
      <p className="mt-2 text-sm leading-relaxed text-pretty text-muted">{text}</p>
      <button type="button" onClick={onAction} className="mt-5 h-11 rounded bg-blue px-4 text-sm text-onblue">
        {action}
      </button>
    </div>
  );
}
