import { normalizeTags } from '../shared/vault-tags.ts';
import { matchesTag } from '../obsidian/tags.ts';
import { contentHash } from '../browser/src/siyuan-content.ts';
import { newSiyuanId, SIYUAN_ID } from '../browser/src/siyuan-api.ts';

export type Request = <T = unknown>(endpoint: string, body?: Record<string, unknown>) => Promise<T>;
export interface BlockRow { id: string; root_id: string; title: string; box: string; markdown: string; name: string }
export interface Card { id: string; title: string; box: string; versionId: string; markdown: string; thoughts: BlockRow[]; tags: string[]; timestamp: string; source: string; search: string; kind: 'capture' | 'local' }
export function cleanMarkdown(markdown: string): string {
  return markdown.replace(/^\s*\{:[^\n]*\}\s*$/gm, '').replace(/^\{\{\{\w*\s*$|^\}\}\}\s*$/gm, '').trim();
}
export function safeSource(markdown: string): string {
  const matches = [...markdown.matchAll(/^来源：\[.*\]\(<?(https?:\/\/[^\s<>]+?)>?\)\s*$/gm)];
  try { const url = new URL(matches.at(-1)?.[1] || ''); return ['http:', 'https:'].includes(url.protocol) ? url.href : ''; } catch { return ''; }
}
export function collectCards(rows: BlockRow[]): Card[] {
  const docs = new Map<string, BlockRow[]>();
  for (const row of rows) {
    if (!SIYUAN_ID.test(row.id) || !SIYUAN_ID.test(row.root_id)) continue;
    const doc = docs.get(row.root_id) || []; doc.push(row); docs.set(row.root_id, doc);
  }
  const timestamp = (row: BlockRow) => row.markdown.match(/^### 更新 (\d{4}-\d\d-\d\dT[^\s]+)/m)?.[1] || row.id.slice(0, 14);
  const cards: Card[] = [];
  for (const [id, blocks] of docs) {
    const versions = blocks.filter(b => ['custom-underline-hash', 'custom-underline-local'].includes(b.name)).sort((a, b) => timestamp(b).localeCompare(timestamp(a)) || b.id.localeCompare(a.id));
    const latest = versions[0]; if (!latest) continue;
    const thoughts = blocks.filter(b => b.name === 'custom-underline-thought').sort((a, b) => a.id.localeCompare(b.id));
    const markdown = cleanMarkdown(latest.markdown);
    const text = [markdown, ...thoughts.map(b => cleanMarkdown(b.markdown))].join('\n');
    const tags = normalizeTags([...text.matchAll(/(?:^|\s)#([^\s#]+)/gu)].map(match => match[1]));
    cards.push({ id, title: latest.title, box: latest.box, versionId: latest.id, markdown, thoughts, tags,
      kind: latest.name === 'custom-underline-local' ? 'local' : 'capture',
      timestamp: timestamp(latest), source: latest.name === 'custom-underline-local' ? '' : safeSource(markdown), search: (latest.title + '\n' + text).toLocaleLowerCase() });
  }
  return cards.sort((a, b) => b.timestamp.localeCompare(a.timestamp) || b.id.localeCompare(a.id));
}
export function filterCards(cards: Card[], query: string, tag: string, box = ''): Card[] {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return cards.filter(card => (!box || card.box === box) && (!tag || card.tags.some(value => matchesTag(value, tag))) && words.every(word => card.search.includes(word)));
}
export async function readCards(request: Request): Promise<Card[]> {
  const rows: BlockRow[] = [];
  let cursor = '';
  for (;;) {
    // Fixed attribute allowlist; cursor can only be a validated block ID. No user search text in SQL.
    const page = await request<BlockRow[]>('/api/query/sql', { stmt: `SELECT b.id, b.root_id, b.markdown, b.box, d.content AS title, a.name FROM blocks b JOIN attributes a ON a.block_id=b.id JOIN blocks d ON d.id=b.root_id WHERE a.name IN ('custom-underline-hash','custom-underline-thought','custom-underline-local') AND b.id > '${cursor}' ORDER BY b.id LIMIT 256` });
    if (!Array.isArray(page)) throw new Error('无法读取卡片索引，请稍后刷新。');
    if (!page.length) break;
    const last = page.at(-1)!.id;
    if (!SIYUAN_ID.test(last) || last <= cursor) throw new Error('卡片索引返回了无效的块 ID。');
    rows.push(...page); cursor = last;
    // Keep paging until empty: some kernels apply a smaller SQL result limit.
  }
  return collectCards(rows);
}
export interface Attempt { id: string; hash: string; markdown: string }
export interface Draft { text: string; attempt?: Attempt }
export type Drafts = Record<string, Draft>;
export function thoughtMarkdown(text: string, id: string, hash: string, timestamp: string): string {
  const safe = text.replace(/\{:/g, '\\{:').replace(/\{\{\{/g, '\\{\\{\\{').replace(/\}\}\}/g, '\\}\\}\\}');
  return `{{{row\n### 想法 ${timestamp}\n\n${safe}\n}}}\n{: id="${id}" custom-underline-thought="${hash}"}`;
}
export function hasThought(markdown: string, attempt: Attempt): boolean {
  return [...markdown.matchAll(/\{:[^\n]*?\}/g)].some(([ial]) => ial.includes(`id="${attempt.id}"`) && ial.includes(`custom-underline-thought="${attempt.hash}"`));
}
export class ThoughtStore {
  private writes: Promise<unknown> = Promise.resolve();
  private pending = new Map<string, Promise<void>>();
  private deleting = new Set<string>();
  drafts: Drafts;
  private request: Request;
  private persist: (drafts: Drafts) => Promise<unknown>;
  constructor(drafts: Drafts, request: Request, persist: (drafts: Drafts) => Promise<unknown>) {
    this.drafts = drafts; this.request = request; this.persist = persist;
  }
  private save() {
    const snapshot = structuredClone(this.drafts);
    const next = this.writes.catch(() => {}).then(() => this.persist(snapshot)); this.writes = next; return next;
  }
  async edit(docId: string, text: string) {
    if (this.deleting.has(docId)) throw new Error('笔记正在删除，请稍后重试。');
    if (this.drafts[docId]?.attempt) throw new Error('上次保存结果待确认，请先重试保存。');
    if (text) this.drafts[docId] = { text }; else delete this.drafts[docId];
    await this.save();
  }
  submit(docId: string): Promise<void> {
    if (this.deleting.has(docId)) return Promise.reject(new Error('笔记正在删除，请稍后重试。'));
    const pending = this.pending.get(docId); if (pending) return pending;
    const run = this.commit(docId).finally(() => this.pending.delete(docId)); this.pending.set(docId, run); return run;
  }
  async remove(docId: string): Promise<void> {
    if (!SIYUAN_ID.test(docId)) throw new Error('无效的文档 ID。');
    if (this.pending.has(docId) || this.deleting.has(docId)) throw new Error('笔记正在保存或删除，请稍后重试。');
    this.deleting.add(docId);
    try {
      await this.request('/api/sqlite/flushTransaction');
      const rows = await this.request<{ box: string; path: string }[]>('/api/query/sql', { stmt: `SELECT box, path FROM blocks WHERE id='${docId}' AND type='d'` });
      if (!Array.isArray(rows)) throw new Error('无法核对笔记位置，请刷新后重试。');
      if (rows.length) {
        const location = rows[0];
        if (!SIYUAN_ID.test(location.box) || !new RegExp(`^(?:/\\d{14}-[a-z0-9]{7})*/${docId}\\.sy$`).test(location.path)) throw new Error('笔记位置异常，请刷新后重试。');
        await this.request('/api/filetree/removeDoc', { notebook: location.box, path: location.path });
      }
      const draft = this.drafts[docId];
      delete this.drafts[docId];
      try { await this.save(); } catch (error) { if (draft) this.drafts[docId] = draft; throw error; }
    } finally { this.deleting.delete(docId); }
  }
  private async commit(docId: string) {
    if (!SIYUAN_ID.test(docId)) throw new Error('无效的文档 ID。');
    const draft = this.drafts[docId]; if (!draft?.text.trim()) throw new Error('请先写下想法。');
    if (!draft.attempt) {
      const hash = await contentHash(draft.text), id = newSiyuanId();
      draft.attempt = { id, hash, markdown: thoughtMarkdown(draft.text, id, hash, new Date().toISOString()) };
    }
    // Persist the identity before sending; restart/retry must reuse it after an uncertain response.
    await this.save();
    const attempt = draft.attempt;
    const exists = async () => hasThought((await this.request<{ kramdown: string }>('/api/block/getBlockKramdown', { id: docId })).kramdown, attempt);
    if (!await exists()) {
      try { await this.request('/api/block/appendBlock', { parentID: docId, dataType: 'markdown', data: attempt.markdown }); }
      catch (error) { if (!await exists().catch(() => false)) throw error; }
    }
    delete this.drafts[docId];
    try { await this.save(); } catch (error) { this.drafts[docId] = draft; throw error; }
  }
}
