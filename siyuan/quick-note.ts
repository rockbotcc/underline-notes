import { SIYUAN_ID, newSiyuanId } from '../browser/src/siyuan-api.ts';
import { contentHash, versionMarkdown } from '../browser/src/siyuan-content.ts';
import type { Request } from './cards.ts';

export interface QuickAttempt { docId: string; blockId: string; hash: string; markdown: string; title: string }
export interface QuickDraft { text: string; notebookId: string; attempt?: QuickAttempt }
export function localMarkdown(text: string, blockId: string, hash: string, now: string) {
  const safe = text.replace(/\{:/g, '\\{:').replace(/\{\{\{/g, '\\{\\{\\{').replace(/\}\}\}/g, '\\}\\}\\}');
  return versionMarkdown(safe, blockId, hash, now).replace('custom-underline-hash=', 'custom-underline-local=');
}
function hasLocal(markdown: string, attempt: QuickAttempt) {
  return [...markdown.matchAll(/\{:[^\n]*?\}/g)].some(([ial]) => ial.includes(`id="${attempt.blockId}"`) && ial.includes(`custom-underline-local="${attempt.hash}"`));
}
export function validateQuickDraft(value: unknown): QuickDraft {
  const draft = value as QuickDraft;
  if (!draft || typeof draft.text !== 'string' || typeof draft.notebookId !== 'string' || (draft.notebookId && !SIYUAN_ID.test(draft.notebookId))) throw new Error('随手记草稿格式异常');
  if (draft.attempt && (!SIYUAN_ID.test(draft.attempt.docId) || !SIYUAN_ID.test(draft.attempt.blockId) || !/^[a-f0-9]{64}$/.test(draft.attempt.hash) || typeof draft.attempt.title !== 'string' || typeof draft.attempt.markdown !== 'string' || !SIYUAN_ID.test(draft.notebookId))) throw new Error('随手记保存状态异常');
  return draft;
}
export class QuickNoteStore {
  draft: QuickDraft;
  private request: Request;
  private persist: (data: QuickDraft) => Promise<unknown>;
  private writes: Promise<unknown> = Promise.resolve();
  private pending?: Promise<string>;
  constructor(draft: QuickDraft, request: Request, persist: (data: QuickDraft) => Promise<unknown>) { this.draft = draft; this.request = request; this.persist = persist; }
  private save() {
    const snapshot = structuredClone(this.draft);
    const next = this.writes.catch(() => {}).then(() => this.persist(snapshot)); this.writes = next; return next;
  }
  async edit(text: string, notebookId: string) {
    if (this.draft.attempt || this.pending) throw new Error('上次记录结果待确认，请先重试。');
    if (notebookId && !SIYUAN_ID.test(notebookId)) throw new Error('请选择有效的笔记本。');
    this.draft = { text, notebookId }; await this.save();
  }
  submit(): Promise<string> {
    if (this.pending) return this.pending;
    this.pending = this.commit().finally(() => { this.pending = undefined; }); return this.pending;
  }
  private async commit() {
    const draft = this.draft;
    if (!draft.text.trim()) throw new Error('请先写下想法。');
    if (!SIYUAN_ID.test(draft.notebookId)) throw new Error('请选择保存到哪个笔记本。');
    if (!draft.attempt) {
      const hash = await contentHash(draft.text), blockId = newSiyuanId();
      const title = Array.from(draft.text.trim().split('\n')[0].replace(/^#+\s*/, '').replace(/[\u0000-\u001f]/g, ' ')).slice(0, 48).join('').trim();
      draft.attempt = { docId: newSiyuanId(), blockId, hash, title: !title || ['.', '..'].includes(title) ? '随手记' : title, markdown: localMarkdown(draft.text, blockId, hash, new Date().toISOString()) };
    }
    await this.save(); // Never create a document without a durable request identity.
    const attempt = draft.attempt;
    const exists = async () => {
      const result = await this.request<{ documents: { id: string }[]; missingIDs: string[] }>('/api/filetree/getDocPaths', { notebook: draft.notebookId, ids: [attempt.docId] });
      if (!Array.isArray(result?.documents) || !Array.isArray(result?.missingIDs)) throw new Error('无法核对随手记是否已保存，请重试。');
      if (result.documents.some(doc => doc.id === attempt.docId)) {
        const block = await this.request<{ kramdown: string }>('/api/block/getBlockKramdown', { id: attempt.docId });
        if (!hasLocal(block.kramdown, attempt)) throw new Error('目标文档已变化，草稿已保留，请打开文档核对。');
        return true;
      }
      if (result.missingIDs.includes(attempt.docId)) return false;
      throw new Error('无法核对随手记是否已保存，请重试。');
    };
    if (!await exists()) {
      try { await this.request('/api/filetree/createDocByParent', { notebook: draft.notebookId, parentID: null, id: attempt.docId, title: { format: 'plain', text: attempt.title }, markdown: attempt.markdown }); }
      catch (error) { if (!await exists().catch(() => false)) throw error; }
    }
    this.draft = { text: '', notebookId: draft.notebookId };
    try { await this.save(); } catch (error) { this.draft = draft; throw error; }
    return attempt.docId;
  }
}
