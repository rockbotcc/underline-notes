import { database, dirty, getDirectory, getSettings, saveArticle, type WriteTransaction } from './db';
import { flushOutput } from './output';
import { checkedSiyuanUrl, siyuanProfile, SIYUAN_ID, SiyuanClient } from './siyuan-api';
import { queueSiyuan, pendingSiyuan, recreateMissing } from './siyuan-output';
import { checkedFlomoUrl, flomoContent } from './flomo-api';
import { validateBackup } from './backup';
import { autoTagNote, DEFAULT_TAG_AI, tagEndpoint, readVaultTags } from './ai-tags';
import { articleId, publicationDate, normalizeUrl, isExcluded, checkedImage, COLORS, type Article, type PageInfo, type Annotation, type Session, type Settings } from '../../shared/model';

function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max) throw new Error('输入内容无效或过长');
  return value;
}

function requireExtensionPage(sender: chrome.runtime.MessageSender) {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) throw new Error('此操作仅能从扩展设置执行');
}

async function pageInfo(input: unknown, sender: chrome.runtime.MessageSender): Promise<PageInfo> {
  if (sender.tab?.incognito) throw new Error('无痕模式已停用记录');
  const value = input as PageInfo;
  const url = normalizeUrl(text(value?.url, 10000));
  if (!sender.tab || normalizeUrl(sender.tab.url || sender.url || '') !== url) throw new Error('页面已切换，请重试');
  return { url, publishedDate: publicationDate(value.publishedDate), faviconUrl: sender.tab.favIconUrl, title: text(value.title, 2000), bodyText: value.bodyText ? text(value.bodyText, 1000000) : '', bodyMarkdown: value.bodyMarkdown ? text(value.bodyMarkdown, 1000000) : '' };
}

async function ensureArticle(tx: WriteTransaction, page: PageInfo, id: string): Promise<Article> {
  const existing = await tx.objectStore('articles').get(id);
  if (existing && !existing.deletedAt) {
    const upgradeSnapshot = !existing.bodyMarkdown && Boolean(page.bodyMarkdown);
    return {
      ...existing, publishedDate: page.publishedDate || existing.publishedDate, faviconUrl: page.faviconUrl || existing.faviconUrl, title: page.title || existing.title,
      bodyText: upgradeSnapshot ? page.bodyText || existing.bodyText : existing.bodyText || page.bodyText || '',
      bodyMarkdown: existing.bodyMarkdown || page.bodyMarkdown || '',
      bodyCapturedAt: upgradeSnapshot ? new Date().toISOString() : existing.bodyCapturedAt,
    };
  }
  const now = new Date().toISOString();
  return { id, url: page.url, publishedDate: page.publishedDate, faviconUrl: page.faviconUrl, title: page.title || new URL(page.url).hostname, hostname: new URL(page.url).hostname, createdAt: now, updatedAt: now, pageNote: '', bodyText: page.bodyText || '', bodyMarkdown: page.bodyMarkdown || '', ...(page.bodyText ? { bodyCapturedAt: now } : {}), annotations: [] };
}

function checkedAnnotation(input: unknown): Annotation {
  const value = input as Annotation;
  if (!value || !/^h_[a-f0-9-]{36}$/.test(value.id)) throw new Error('划线 ID 无效');
  const exact = text(value.anchor?.exact, 50000);
  const start = value.anchor.start;
  const end = value.anchor.end;
  if (!exact.trim() || !Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(end) || end - start !== exact.length) throw new Error('划线位置无效');
  if (!COLORS.includes(value.color)) throw new Error('划线颜色无效');
  const now = new Date().toISOString();
  return { id: value.id, anchor: { exact, prefix: text(value.anchor.prefix, 200), suffix: text(value.anchor.suffix, 200), start, end }, ...(value.image !== undefined ? { image: checkedImage(value.image) } : {}), color: value.color, note: text(value.note, 100000), createdAt: now, updatedAt: now };
}

async function handle(message: Record<string, unknown>, sender: chrome.runtime.MessageSender): Promise<unknown> {
  const db = await database;
  const settings = await getSettings();
  if (message.type === 'GET_PAGE') {
    const page = await pageInfo(message.page, sender);
    if (settings.outputTarget === 'obsidian') await flushOutput();
    const article = await db.get('articles', await articleId(page.url));
    return { article: article?.deletedAt ? null : article ?? null, settings: { outputTarget: settings.outputTarget, flomoApiUrl: '', recordHistory: settings.recordHistory, excludedDomains: settings.excludedDomains, vaultName: settings.vaultName, vaultFolder: settings.vaultFolder }, excluded: isExcluded(page.url, settings.excludedDomains) };
  }
  if (message.type === 'PAGE_OUTPUT_STATUS') {
    const page = await pageInfo(message.page, sender);
    const id = await articleId(page.url);
    const directory = await getDirectory();
    if (settings.outputTarget === 'siyuan') {
      const jobs = (await db.getAll('siyuanJobs')).filter(job => job.articleId === id && job.profileId === settings.siyuan?.profileId && !job.cancelled);
      const bindings = (await db.getAll('siyuanBindings')).filter(item => item.profileId === settings.siyuan?.profileId && item.key.startsWith(item.profileId + ':' + id + ':') && item.confirmed);
      return { target: 'siyuan', connected: Boolean(settings.siyuan?.notebookId), pending: jobs.some(pendingSiyuan), sent: bindings.length > 0,
        docId: bindings[0]?.docId, error: jobs.find(job => pendingSiyuan(job) && job.error)?.error || '' };
    }
    if (settings.outputTarget === 'flomo') {
      const jobs = (await db.getAll('flomo')).filter(job => job.articleId === id);
      return { target: 'flomo', connected: Boolean(settings.flomoApiUrl), pending: jobs.some(job => job.content !== job.sentContent), sent: jobs.some(job => job.sentContent), error: jobs.find(job => job.error)?.error || '' };
    }
    const pending = await db.get('pending', 'article:' + id);
    return { connected: Boolean(directory), vaultName: settings.vaultName, pending: Boolean(pending), error: pending?.error || await db.get('meta', 'syncError') || '' };
  }
  if (message.type === 'OPEN_OPTIONS') {
    await chrome.runtime.openOptionsPage();
    return null;
  }
  if (['SAVE_ANNOTATION', 'DELETE_ANNOTATION', 'SAVE_PAGE_NOTE', 'READING', 'DELETE_ARTICLE'].includes(String(message.type))) {
    const page = await pageInfo(message.page, sender);
    if (isExcluded(page.url, settings.excludedDomains)) throw new Error('此网站已在排除列表中');
    const id = await articleId(page.url);
    // Validate before opening a transaction. All following work is IndexedDB-only.
    const annotation = message.type === 'SAVE_ANNOTATION' ? checkedAnnotation(message.annotation) : undefined;
    if (annotation?.image && !annotation.image.data) {
      const response = await fetch(annotation.image.url, { credentials: 'include', signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error('图片下载失败，请检查原图后重试');
      const blob = await response.blob();
      if (!blob.size || blob.size > 12 * 1024 * 1024) throw new Error('图片为空或超过 12 MB');
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
      annotation.image = checkedImage({ ...annotation.image, data: 'data:' + blob.type.split(';')[0] + ';base64,' + btoa(binary) });
    }
    const note = message.type === 'SAVE_PAGE_NOTE' ? text(message.note, 100000) : undefined;
    const annotationToDelete = message.type === 'DELETE_ANNOTATION' ? text(message.id, 80) : undefined;
    if (settings.outputTarget === 'obsidian' && (annotation || note !== undefined || annotationToDelete || message.type === 'DELETE_ARTICLE')) await flushOutput();
    let session: Session | undefined;
    if (message.type === 'READING') {
      if (!settings.recordHistory) return null;
      const value = message.session as Session;
      if (!value || !/^[a-f0-9-]{36}$/.test(value.id) || !/^\d{4}-\d{2}-\d{2}$/.test(value.day)) throw new Error('阅读记录无效');
      if (!Number.isFinite(value.activeMs) || value.activeMs < 15000 || value.activeMs > 86400000 || !Number.isFinite(value.progress)) throw new Error('阅读时长无效');
      if (!Number.isFinite(Date.parse(value.startedAt)) || new Date(value.day).toISOString().slice(0, 10) !== value.day) throw new Error('阅读日期无效');
      session = { id: value.id, articleId: id, day: value.day, startedAt: new Date(value.startedAt).toISOString(), updatedAt: new Date().toISOString(), activeMs: Math.round(value.activeMs), progress: Math.max(0, Math.min(100, value.progress)) };
    }
    let taggedNote: string | undefined;
    if (settings.ai?.enabled && (annotation || note?.trim())) {
      try {
        taggedNote = await autoTagNote(settings.ai, { title: page.title, note: annotation?.note ?? note!, quote: annotation?.anchor.exact ?? '' }, await readVaultTags(await getDirectory()));
        await db.delete('meta', 'aiTagError');
      } catch {
        await db.put('meta', '笔记已保存，自动标签未完成；请检查模型配置、文件夹授权及 Obsidian 导出的 Data/vault-tags.json，下次保存时重试。', 'aiTagError');
      }
    }
    if (taggedNote !== undefined && JSON.stringify((await getSettings()).ai) !== JSON.stringify(settings.ai)) taggedNote = undefined;
    const tx = db.transaction(['articles', 'sessions', 'pending', 'flomo', 'siyuanJobs'], 'readwrite');
    const previous = await tx.objectStore('articles').get(id);
    if (message.type === 'READING' && previous?.deletedAt) { await tx.done; return null; }
    const article = await ensureArticle(tx, page, id);
    if (annotation || note !== undefined) {
      const existingNote = annotation ? article.annotations.find(item => item.id === annotation.id)?.note ?? '' : article.pageNote;
      const nextNote = annotation ? annotation.note : note!;
      if (typeof message.expectedNote !== 'string' || (existingNote !== message.expectedNote && existingNote !== nextNote)) {
        tx.abort();
        throw new Error('笔记已有新版本。你的输入已保留，请复制后重新打开笔记，合并后再保存。');
      }
    }
    if (annotation) {
      annotation.note = taggedNote ?? annotation.note;
      const index = article.annotations.findIndex(item => item.id === annotation.id);
      if (index === -1 && (message.annotation as Annotation).createdAt) {
        tx.abort();
        throw new Error('这条划线已删除，无法保存修改。');
      }
      if (index === -1) article.annotations.push(annotation);
      else article.annotations[index] = { ...annotation, createdAt: article.annotations[index].createdAt };
    }
    if (annotationToDelete) article.annotations = article.annotations.filter(item => item.id !== annotationToDelete);
    if (note !== undefined) { article.pageNote = taggedNote ?? note; article.pageNoteCard = true; }
    if (session) {
      const previousSession = await tx.objectStore('sessions').get(session.id);
      if (previousSession && (previousSession.articleId !== id || previousSession.day !== session.day)) { tx.abort(); throw new Error('阅读会话发生冲突'); }
      session.activeMs = Math.max(session.activeMs, previousSession?.activeMs ?? 0);
      session.progress = Math.max(session.progress, previousSession?.progress ?? 0);
      await tx.objectStore('sessions').put(session);
      await dirty(tx, 'day:' + session.day);
    }
    if (message.type === 'DELETE_ARTICLE') {
      const visits = await tx.objectStore('sessions').index('articleId').getAll(id);
      for (const visit of visits) { await tx.objectStore('sessions').delete(visit.id); await dirty(tx, 'day:' + visit.day); }
      article.annotations = [];
      article.pageNote = '';
      article.bodyText = '';
      article.bodyMarkdown = '';
      delete article.bodyCapturedAt;
      article.deletedAt = new Date().toISOString();
    }
    const flomo = tx.objectStore('flomo');
    if (annotationToDelete) await flomo.delete(id + ':' + annotationToDelete);
    if (message.type === 'DELETE_ARTICLE') {
      for (const job of await flomo.getAll()) if (job.articleId === id) await flomo.delete(job.key);
    }
    if (note !== undefined && !note.trim()) await flomo.delete(id + ':page');
    if (settings.outputTarget === 'flomo' && (annotation || note?.trim())) {
      const key = id + ':' + (annotation?.id || 'page');
      const previousJob = await flomo.get(key);
      const content = flomoContent(article, annotation);
      await flomo.put({ key, articleId: id, content, version: crypto.randomUUID(), sentContent: previousJob?.sentContent });
    }
    await queueSiyuan(tx, settings.outputTarget === 'siyuan' ? settings.siyuan : undefined, article, annotation, note !== undefined);
    await saveArticle(tx, article);
    await tx.done;
    void flushOutput().catch(console.error);
    if (message.type !== 'READING') void notifyPages(page.url);
    return article.deletedAt ? null : article;
  }

  requireExtensionPage(sender);
  switch (message.type) {
    case 'SIYUAN_TEST': {
      const baseUrl = checkedSiyuanUrl(text(message.baseUrl, 2000));
      const apiToken = text(message.apiToken, 4000).trim();
      if (!apiToken || /[\r\n]/.test(apiToken)) throw new Error('请填写有效的思源 API Token。');
      const client = new SiyuanClient({ baseUrl, apiToken });
      const version = await client.call<string>('system/version');
      if (typeof version !== 'string') throw new Error('无法读取思源版本。');
      return { version, notebooks: (await client.notebooks()).filter(item => !item.closed) };
    }
    case 'SIYUAN_RECREATE': {
      if (settings.outputTarget !== 'siyuan' || !settings.siyuan) throw new Error('请先配置思源。');
      await navigator.locks.request('noting-output', () => recreateMissing(settings.siyuan!));
      await flushOutput(true);
      return null;
    }
    case 'STATUS': {
      const articles = (await db.getAll('articles')).filter(article => !article.deletedAt);
      const directory = await getDirectory();
      const flomoPending = (await db.getAll('flomo')).filter(job => job.content !== job.sentContent);
      const isFlomo = settings.outputTarget === 'flomo';
      const isSiyuan = settings.outputTarget === 'siyuan';
      const siyuanPending = (await db.getAll('siyuanJobs')).filter(job => job.profileId === settings.siyuan?.profileId && pendingSiyuan(job));
      return {
        settings, aiTagError: await db.get('meta', 'aiTagError'), directoryName: directory?.name ?? '',
        articles: articles.length,
        annotations: articles.reduce((total, article) => total + article.annotations.length, 0),
        pending: isSiyuan ? siyuanPending : isFlomo ? flomoPending : await db.getAll('pending'),
        lastSync: await db.get('meta', isSiyuan ? 'siyuanLastSync:' + settings.siyuan?.profileId : isFlomo ? 'flomoLastSync' : 'lastSync'),
        syncError: isSiyuan ? siyuanPending.find(job => job.error)?.error : isFlomo ? flomoPending.find(job => job.error)?.error : await db.get('meta', 'syncError'),
      };
    }
    case 'SAVE_SETTINGS': {
      const value = message.settings as Settings;
      if (typeof value?.recordHistory !== 'boolean' || !Array.isArray(value.excludedDomains)) throw new Error('设置无效');
      const domains = value.excludedDomains.map(domain => {
        const raw = text(domain, 300).trim().toLowerCase();
        return new URL(raw.includes('://') ? raw : 'https://' + raw).hostname;
      });
      const folder = text(value.vaultFolder, 500).trim().replace(/^\/+|\/+$/g, '');
      if (folder.split('/').some(part => part === '..' || part === '.')) throw new Error('文件夹路径无效');
      const outputTarget = value.outputTarget ?? 'obsidian';
      if (!['obsidian', 'flomo', 'siyuan'].includes(outputTarget)) throw new Error('写入位置无效');
      const rawUrl = text(value.flomoApiUrl ?? '', 2000).trim();
      const flomoApiUrl = rawUrl || outputTarget === 'flomo' ? checkedFlomoUrl(rawUrl) : '';
      const next: Settings = { outputTarget, flomoApiUrl, recordHistory: value.recordHistory, excludedDomains: [...new Set(domains)], vaultName: text(value.vaultName, 200).trim(), vaultFolder: folder };
      if (value.siyuan) {
        const baseUrl = checkedSiyuanUrl(text(value.siyuan.baseUrl, 2000));
        const apiToken = text(value.siyuan.apiToken, 4000).trim();
        const notebookId = text(value.siyuan.notebookId, 100);
        if (!apiToken || /[\r\n]/.test(apiToken) || !SIYUAN_ID.test(notebookId)) throw new Error('请填写思源 Token，并测试连接后选择笔记本。');
        next.siyuan = { baseUrl, apiToken, notebookId, profileId: await siyuanProfile(baseUrl, notebookId) };
        const sameConnection = settings.siyuan?.profileId === next.siyuan.profileId && settings.siyuan.apiToken === apiToken;
        if (outputTarget === 'siyuan' && !sameConnection) next.siyuan.notebookName = await new SiyuanClient(next.siyuan).checkNotebook(notebookId);
        else if (sameConnection) next.siyuan.notebookName = settings.siyuan?.notebookName;
      }
      if (outputTarget === 'siyuan' && !next.siyuan) throw new Error('请先配置思源并选择笔记本。');
      const ai = value.ai ?? DEFAULT_TAG_AI;
      if (typeof ai.enabled !== 'boolean') throw new Error('自动标签设置无效');
      next.ai = { enabled: ai.enabled, baseUrl: text(ai.baseUrl, 2000).trim(), apiKey: text(ai.apiKey, 4000).trim(), model: text(ai.model, 200).trim() };
      if (next.ai.baseUrl) tagEndpoint(next.ai.baseUrl);
      if (ai.enabled && (!next.ai.baseUrl || !next.ai.model)) throw new Error('请填写模型接口地址和模型名称');
      await navigator.locks.request('noting-output', () => db.put('meta', next, 'settings'));
      void flushOutput().catch(console.error);
      void notifyPages();
      return next;
    }
    case 'FLUSH': await flushOutput(true); return null;
    case 'REQUEUE': {
      const tx = db.transaction(['articles', 'sessions', 'pending'], 'readwrite');
      for (const article of await tx.objectStore('articles').getAll()) await dirty(tx, 'article:' + article.id);
      for (const day of new Set((await tx.objectStore('sessions').getAll()).map(session => session.day))) await dirty(tx, 'day:' + day);
      await dirty(tx, 'index');
      await tx.done;
      return null;
    }
    case 'BACKUP': {
      const tx = db.transaction(['articles', 'sessions'], 'readonly');
      const [articles, sessions] = await Promise.all([tx.objectStore('articles').getAll(), tx.objectStore('sessions').getAll()]);
      await tx.done;
      return { schemaVersion: 1, exportedAt: new Date().toISOString(), articles, sessions };
    }
    case 'IMPORT': {
      const data = await validateBackup(message.backup);
      const tx = db.transaction(['articles', 'sessions', 'pending'], 'readwrite');
      for (const article of data.articles) {
        const existing = await tx.objectStore('articles').get(article.id);
        if (!existing || article.updatedAt > existing.updatedAt) {
          await tx.objectStore('articles').put(article);
          await dirty(tx, 'article:' + article.id);
          const oldSessions = await tx.objectStore('sessions').index('articleId').getAll(article.id);
          for (const visit of oldSessions) {
            if (article.deletedAt) await tx.objectStore('sessions').delete(visit.id);
            await dirty(tx, 'day:' + visit.day);
          }
        }
      }
      for (const session of data.sessions) {
        const article = await tx.objectStore('articles').get(session.articleId);
        if (article?.deletedAt) continue;
        const existing = await tx.objectStore('sessions').get(session.id);
        if (existing && (existing.articleId !== session.articleId || existing.day !== session.day)) { tx.abort(); throw new Error('阅读会话发生冲突'); }
        if (!existing || session.updatedAt > existing.updatedAt) {
          await tx.objectStore('sessions').put(session);
          await dirty(tx, 'day:' + session.day);
          await dirty(tx, 'article:' + session.articleId);
        }
      }
      await dirty(tx, 'index');
      await tx.done;
      void flushOutput().catch(console.error);
      void notifyPages();
      return { articles: data.articles.length, sessions: data.sessions.length };
    }
    default: throw new Error('未知操作');
  }
}

async function notifyPages(url?: string) {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.id && tab.url?.startsWith('http') && (!url || normalizeUrl(tab.url) === url)) {
      void chrome.tabs.sendMessage(tab.id, { type: 'NOTING_REFRESH' }).catch(() => undefined);
    }
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!message || typeof message.type !== 'string' || message.type.startsWith('NOTING_')) return;
  handle(message, sender).then(data => respond({ ok: true, data }), error => respond({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return true;
});

chrome.action.onClicked.addListener(tab => {
  if (!tab.id) return;
  chrome.tabs.sendMessage(tab.id, { type: 'NOTING_TOGGLE' }).catch(() => chrome.runtime.openOptionsPage());
});

async function scheduleFlush() {
  await chrome.alarms.create('noting-files', { periodInMinutes: 1 });
}
chrome.runtime.onInstalled.addListener(() => { void scheduleFlush(); void flushOutput().catch(console.error); });
chrome.runtime.onStartup.addListener(() => { void scheduleFlush(); void flushOutput().catch(console.error); });
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'noting-files') void flushOutput().catch(console.error); });
