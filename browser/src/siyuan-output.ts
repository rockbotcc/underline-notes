import { database, type WriteTransaction } from './db';
import type { Annotation, Article, SiyuanSettings } from '../../shared/model';
import { newSiyuanId, SiyuanClient, SiyuanError } from './siyuan-api';
import { contentHash, hasVersion, siyuanContent, siyuanTitle, versionMarkdown } from './siyuan-content';

export interface SiyuanBinding {
  key: string;
  profileId: string;
  docId: string;
  confirmed: boolean;
  sentContent?: string;
}
export interface SiyuanAttempt { id: string; content: string; hash: string; timestamp: string }
export interface SiyuanJob {
  key: string;
  profileId: string;
  articleId: string;
  cardId: string;
  title: string;
  desired: string;
  active?: SiyuanAttempt;
  sentContent?: string;
  cancelled?: boolean;
  error?: string;
  errorCode?: string;
  blocked?: boolean;
  retryAt?: number;
  attempts: number;
}
export function pendingSiyuan(job: SiyuanJob): boolean { return !job.cancelled && (!!job.active || job.desired !== job.sentContent); }

export async function queueSiyuan(tx: WriteTransaction, config: SiyuanSettings | undefined, article: Article, annotation?: Annotation, savePage = false) {
  const store = tx.objectStore('siyuanJobs');
  // Deletions cancel all destinations, including paused ones. Preserve an in-flight identity.
  for (const job of await store.getAll()) {
    if (job.articleId !== article.id) continue;
    if (article.deletedAt || (job.cardId === 'page' ? !article.pageNote.trim() : !article.annotations.some(item => item.id === job.cardId))) {
      await store.put({ ...job, cancelled: true, desired: '' });
    }
  }
  if (!config || (!annotation && !savePage) || (!annotation && !article.pageNote.trim())) return;
  const cardId = annotation?.id || 'page';
  const key = `${config.profileId}:${article.id}:${cardId}`;
  const old = await store.get(key);
  await store.put({ ...old, key, profileId: config.profileId, articleId: article.id, cardId,
    title: siyuanTitle(article, annotation), desired: siyuanContent(article, annotation), cancelled: false,
    attempts: old?.attempts || 0, error: old?.blocked ? old.error : undefined, retryAt: undefined });
}

async function binding(key: string, profileId: string): Promise<SiyuanBinding> {
  const db = await database;
  let value = await db.get('siyuanBindings', key);
  if (!value) { value = { key, profileId, docId: newSiyuanId(), confirmed: false }; await db.put('siyuanBindings', value); }
  return value;
}
function missing(): never { throw new SiyuanError('missing', '思源目标文档已删除或移出笔记本；请在设置中重新创建缺失文档。'); }

async function ensureRoot(client: SiyuanClient, config: SiyuanSettings): Promise<string> {
  const db = await database;
  const root = await binding('root:' + config.profileId, config.profileId);
  const exists = await client.document(config.notebookId, root.docId);
  if (!exists) {
    if (root.confirmed) missing();
    try {
      await client.create(config.notebookId, null, root.docId, '划线笔记', `网页摘录与批注。\n{: custom-underline-profile="${config.profileId}"}`);
    } catch (error) {
      // A transport can replay a POST after a lost response. An ID-conflict response
      // may therefore mean the original create succeeded; read before reporting failure.
      if (!await client.document(config.notebookId, root.docId)) throw error;
    }
  }
  if (!root.confirmed) {
    const markdown = await client.markdown(root.docId);
    if (!markdown.includes(`custom-underline-profile="${config.profileId}"`)) throw new SiyuanError('conflict', '思源目录身份无法核对，请保留现有文档并检查配置。');
    await db.put('siyuanBindings', { ...root, confirmed: true });
  }
  return root.docId;
}

async function acknowledge(target: SiyuanBinding, attempt: SiyuanAttempt) {
  const db = await database;
  const receipt = db.transaction(['siyuanJobs', 'siyuanBindings', 'meta'], 'readwrite');
  await receipt.objectStore('siyuanBindings').put({ ...target, confirmed: true, sentContent: attempt.content });
  const current = await receipt.objectStore('siyuanJobs').get(target.key);
  if (current?.active?.id === attempt.id) await receipt.objectStore('siyuanJobs').put({ ...current, active: undefined,
    sentContent: attempt.content, error: undefined, errorCode: undefined, blocked: false, retryAt: undefined, attempts: 0 });
  await receipt.objectStore('meta').put(new Date().toISOString(), 'siyuanLastSync:' + target.profileId);
  await receipt.done;
}

// Called under the shared output lock. Network work never holds an IndexedDB transaction.
export async function flushSiyuan(config: SiyuanSettings, force = false) {
  const db = await database;
  const jobs = (await db.getAll('siyuanJobs')).filter(job => job.profileId === config.profileId && pendingSiyuan(job) &&
    (force || !job.blocked && (!job.retryAt || job.retryAt <= Date.now()))).slice(0, 10);
  if (!jobs.length) return;
  const client = new SiyuanClient(config);
  for (const snapshot of jobs) {
    try {
      await client.checkNotebook(config.notebookId);
      const rootId = await ensureRoot(client, config);
      const target = await binding(snapshot.key, config.profileId);
      let job = await db.get('siyuanJobs', snapshot.key);
      if (!job || job.cancelled) continue;
      // Refresh paused work from the latest surviving source; imports alone never create jobs.
      const article = await db.get('articles', job.articleId);
      const annotation = article?.annotations.find(item => item.id === job!.cardId);
      if (!article || article.deletedAt || (job.cardId === 'page' ? !article.pageNote.trim() : !annotation)) {
        await db.put('siyuanJobs', { ...job, cancelled: true }); continue;
      }
      const content = siyuanContent(article, annotation);
      const hash = await contentHash(content);
      const tx = db.transaction('siyuanJobs', 'readwrite');
      const latest = await tx.store.get(job.key);
      if (!latest || latest.cancelled) { await tx.done; continue; }
      // A newer save wins over the source snapshot read above.
      if (latest.desired !== job.desired) { await tx.done; continue; }
      job = { ...latest, desired: content, title: siyuanTitle(article, annotation), sentContent: target.sentContent };
      if (!job.active && content !== target.sentContent) job.active = { id: newSiyuanId(), hash, content, timestamp: new Date().toISOString() };
      await tx.store.put(job); await tx.done;
      if (!job.active) continue;
      const attempt = job.active;
      let exists = await client.document(config.notebookId, target.docId);
      if (!exists && target.confirmed) missing();
      const data = versionMarkdown(attempt.content, attempt.id, attempt.hash, attempt.timestamp);
      if (!exists) {
        if ((await db.get('siyuanJobs', job.key))?.cancelled) continue;
        await client.create(config.notebookId, rootId, target.docId, job.title, data);
        exists = true;
      } else {
        const markdown = await client.markdown(target.docId);
        if (!hasVersion(markdown, attempt.id, attempt.hash)) {
          if (!target.confirmed) throw new SiyuanError('conflict', '思源文档内容无法核对，已暂停以避免重复写入。');
          if (markdown.includes(`id="${attempt.id}"`)) throw new SiyuanError('conflict', '思源中的版本标记已变化，请核对后重试。');
          if ((await db.get('siyuanJobs', job.key))?.cancelled) continue;
          await client.call('block/appendBlock', { parentID: target.docId, dataType: 'markdown', data });
        }
      }
      if (!hasVersion(await client.markdown(target.docId), attempt.id, attempt.hash)) throw new SiyuanError('conflict', '思源未保留版本标记，请检查内核兼容性；已暂停重复写入。');
      await acknowledge(target, attempt);
    } catch (error) {
      // Reconcile even an explicit rejection: a replayed create/append may have hit
      // the kernel's duplicate-ID guard after the first request committed.
      try {
        const current = await db.get('siyuanJobs', snapshot.key);
        const target = await db.get('siyuanBindings', snapshot.key);
        if (current?.active && target && await client.document(config.notebookId, target.docId) &&
          hasVersion(await client.markdown(target.docId), current.active.id, current.active.hash)) {
          await acknowledge(target, current.active); continue;
        }
      } catch { /* Preserve the original failure; unavailable reads never prove absence. */ }
      const failure = error instanceof SiyuanError ? error : new SiyuanError('internal', '思源写入未完成，请重试并检查配置。');
      const tx = db.transaction('siyuanJobs', 'readwrite');
      const current = await tx.store.get(snapshot.key);
      if (current) await tx.store.put({ ...current, error: failure.message, errorCode: failure.code, blocked: !failure.retryable,
        attempts: current.attempts + 1, retryAt: Date.now() + Math.min(60000 * 2 ** Math.min(current.attempts, 4), 900000) + Math.floor(Math.random() * 5000) });
      await tx.done;
      if (failure.code !== 'missing' && failure.code !== 'conflict') break;
    }
  }
}

export async function recreateMissing(config: SiyuanSettings): Promise<void> {
  const db = await database;
  const client = new SiyuanClient(config);
  await client.checkNotebook(config.notebookId);
  const root = await db.get('siyuanBindings', 'root:' + config.profileId);
  if (root && !await client.document(config.notebookId, root.docId)) await db.delete('siyuanBindings', root.key);
  for (const job of await db.getAll('siyuanJobs')) {
    if (job.profileId !== config.profileId || job.errorCode !== 'missing' || job.cancelled) continue;
    const target = await db.get('siyuanBindings', job.key);
    if (target && !await client.document(config.notebookId, target.docId)) await db.delete('siyuanBindings', target.key);
    await db.put('siyuanJobs', { ...job, active: undefined, sentContent: undefined, error: undefined, errorCode: undefined, blocked: false, retryAt: undefined });
  }
}
