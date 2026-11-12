export const COLORS = ['yellow', 'green', 'blue', 'pink'] as const;
export type Color = typeof COLORS[number];

export interface Anchor {
  exact: string;
  prefix: string;
  suffix: string;
  start: number;
  end: number;
}

export interface Annotation {
  id: string;
  anchor: Anchor;
  image?: ImageReference;
  color: Color;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface ImageReference {
  url: string;
  alt: string;
  data?: string;
}

export function checkedImage(input: unknown): ImageReference {
  const value = input as ImageReference;
  if (!value || typeof value.url !== 'string' || value.url.length > 10000 || typeof value.alt !== 'string' || value.alt.length > 2000) throw new Error('图片信息无效');
  const url = new URL(value.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('暂时只支持 HTTP / HTTPS 图片链接');
  if (value.data !== undefined && (typeof value.data !== 'string' || value.data.length > 16 * 1024 * 1024 + 64 ||
    !/^data:image\/(?:png|jpeg|gif|webp|avif|svg\+xml|bmp|x-icon);base64,[A-Za-z0-9+/]+=*$/.test(value.data))) throw new Error('图片附件格式无效或超过 12 MB');
  return { url: url.href, alt: value.alt, ...(value.data ? { data: value.data } : {}) };
}

export interface Article {
  id: string;
  url: string;
  title: string;
  hostname: string;
  createdAt: string;
  updatedAt: string;
  pageNote: string;
  pageNoteCard?: boolean;
  bodyText: string;
  publishedDate?: string;
  faviconUrl?: string;
  bodyMarkdown?: string;
  bodyCapturedAt?: string;
  annotations: Annotation[];
  deletedAt?: string;
}

export interface Session {
  id: string;
  articleId: string;
  day: string;
  startedAt: string;
  updatedAt: string;
  activeMs: number;
  progress: number;
}

export interface Settings {
  ai?: { enabled: boolean; baseUrl: string; apiKey: string; model: string };
  outputTarget: 'obsidian' | 'flomo';
  flomoApiUrl: string;
  recordHistory: boolean;
  excludedDomains: string[];
  vaultName: string;
  vaultFolder: string;
}

export const DEFAULT_SETTINGS: Settings = {
  outputTarget: 'obsidian',
  flomoApiUrl: '',
  recordHistory: true,
  excludedDomains: [],
  vaultName: '',
  vaultFolder: 'Reading',
};

export function publicationDate(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  const match = /^(\d{4}-\d{2}-\d{2})(?:$|[T\s]\d{2}:)/.exec(value.trim());
  if (!match) return;
  const day = new Date(match[1] + 'T00:00:00Z');
  if (Number.isFinite(day.getTime()) && day.toISOString().startsWith(match[1])) return match[1];
}

export interface PageInfo {
  url: string;
  title: string;
  bodyText?: string;
  publishedDate?: string;
  faviconUrl?: string;
  bodyMarkdown?: string;
}

export interface Pending {
  key: string;
  version: string;
  error?: string;
}

export interface Backup {
  schemaVersion: 1;
  exportedAt: string;
  articles: Article[];
  sessions: Session[];
}

export function normalizeUrl(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('仅支持 HTTP / HTTPS 网页');
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_.+|fbclid|gclid|msclkid)$/i.test(key)) url.searchParams.delete(key);
  }
  // Preserve query parameters and hash routes: both can identify distinct articles.
  return url.href;
}

export async function articleId(url: string): Promise<string> {
  const bytes = new TextEncoder().encode(normalizeUrl(url));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return 'a_' + [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

export function isExcluded(url: string, domains: string[]): boolean {
  const hostname = new URL(url).hostname.toLowerCase();
  return domains.some(domain => hostname === domain || hostname.endsWith('.' + domain));
}

export function localDay(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function obsidianUrl(settings: Settings, id?: string): string {
  const params = new URLSearchParams({ vault: settings.vaultName });
  const file = id ? `Articles/${id}.md` : '卡片盒.md';
  params.set('file', [settings.vaultFolder.replace(/^\/+|\/+$/g, ''), file].filter(Boolean).join('/'));
  return `obsidian://open?${params}`;
}
