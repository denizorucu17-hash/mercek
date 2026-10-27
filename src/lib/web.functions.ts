import { createServerFn } from "@tanstack/react-start";

function searchInput(input: unknown): { q: string; page: number } {
  if (!input || typeof input !== "object") throw new Error("Geçersiz istek");
  const raw = input as { q?: unknown; page?: unknown };
  if (typeof raw.q !== "string") throw new Error("Bir şey yaz");
  const q = raw.q.trim().slice(0, 180);
  if (!q) throw new Error("Bir şey yaz");
  const pageNum = typeof raw.page === "number" ? raw.page : 1;
  const page = Math.min(8, Math.max(1, Math.floor(pageNum) || 1));
  return { q, page };
}

function readInput(input: unknown): { url: string } {
  if (!input || typeof input !== "object") throw new Error("Geçersiz istek");
  const url = (input as { url?: unknown }).url;
  if (typeof url !== "string") throw new Error("Adres geçersiz");
  const trimmed = url.trim().slice(0, 2000);
  if (!trimmed) throw new Error("Adres geçersiz");
  return { url: trimmed };
}

export const searchWeb = createServerFn({ method: "POST" })
  .validator(searchInput)
  .handler(async ({ data }) => {
    const { runSearch } = await import("./search.server.ts");
    return runSearch(data);
  });

export const readPage = createServerFn({ method: "POST" })
  .validator(readInput)
  .handler(async ({ data }) => {
    const { runRead } = await import("./search.server.ts");
    return runRead(data);
  });
