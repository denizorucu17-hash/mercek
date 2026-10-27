export type WebResult = {
  title: string;
  url: string;
  display: string;
  snippet: string;
};

export type Knowledge = {
  title: string;
  description: string;
  extract: string;
  url: string;
  image?: string;
};

export type Instant = {
  kind: "math" | "clock" | "weather";
  title: string;
  value: string;
  detail?: string;
};

export type SearchResponse = {
  query: string;
  page: number;
  source: "web" | "vikipedi";
  instant: Instant | null;
  knowledge: Knowledge | null;
  results: WebResult[];
  hasMore: boolean;
};

export type ReaderBlock = { type: "h" | "p"; text: string };

export type PageResponse = {
  url: string;
  title: string;
  site: string;
  blocks: ReaderBlock[];
  links: { title: string; url: string }[];
};
