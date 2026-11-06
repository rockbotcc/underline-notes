import { database, getDirectory } from './db';
import { articleCards, articleMarkdown, dayMarkdown, indexMarkdown, managedCardPart, personalCardPart, LEGACY_PERSONAL_TEMPLATE, imageAttachmentPath } from '../../shared/markdown';
import { cardStructure, mergeNote, readCardNote } from '../../shared/note-sync';

export type DirectoryHandle = FileSystemDirectoryHandle & {
  queryPermission(options: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission(options: { mode: 'readwrite' }): Promise<PermissionState>;
};

async function hashText(text: string) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, '0')).join('');
}

async function parentDirectory(root: FileSystemDirectoryHandle, path: string) {
  const parts = path.split('/');
  const name = parts.pop()!;
  let directory = root;
  for (const part of parts) directory = await directory.getDirectoryHandle(part, { create: true });
  return { directory, name };
}

// Cards own only the prefix; the personal suffix belongs to the Obsidian user.
async function writeFile(root: FileSystemDirectoryHandle, path: string, text: string | null) {
  const db = await database;
  const { directory, name } = await parentDirectory(root, path);
  const record = await db.get('files', path);
  let handle: FileSystemFileHandle | undefined;
  let current: string | undefined;
  try {
    handle = await directory.getFileHandle(name);
    current = await (await handle.getFile()).text();
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
  }
  const card = path.startsWith('Cards/');
  const managed = (value: string) => card ? managedCardPart(value) : value;
  let currentManaged: string | undefined;
  try { currentManaged = current === undefined ? undefined : managed(current); }
  catch { throw new Error(`文件存在外部修改：${path}。内容分界标记被移除，请恢复标记后重试。`); }
  if (text !== null && currentManaged === managed(text)) {
    await db.put('files', { path, hash: await hashText(managed(text)), ...(card ? { base: managed(text) } : {}) });
    return;
  }
  if (currentManaged !== undefined && (!record || await hashText(currentManaged) !== record.hash)) {
    throw new Error(`文件存在外部修改：${path}。请将修改移到独立笔记，再移走此文件并重试。`);
  }
  if (text === null) {
    // A card with handwritten thoughts becomes an independent note on deletion.
    const tail = card && current !== undefined ? personalCardPart(current).trim() : '';
    const hasThoughts = tail && tail !== LEGACY_PERSONAL_TEMPLATE;
    if (handle && !hasThoughts) await directory.removeEntry(name);
    await db.delete('files', path);
    return;
  }
  if (card && current !== undefined) text = managed(text) + personalCardPart(current);
  handle ??= await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  try {
    // Recheck after acquiring the writer: never knowingly overwrite a newer edit.
    if (current !== undefined && await (await handle.getFile()).text() !== current) throw new Error(`文件刚刚有新的修改：${path}。下次同步会重试。`);
    await writable.write(text);
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => undefined);
    throw error;
  }
  await db.put('files', { path, hash: await hashText(managed(text)), ...(card ? { base: managed(text) } : {}) });
}

async function conflictCopy(root: FileSystemDirectoryHandle, path: string, base: string, browser: string | null, obsidian: string) {
  const instructions = browser === null
    ? '浏览器已删除此记录，而 Obsidian 有未同步的修改。请将原卡片移到 Reading/Cards 之外作为独立笔记，再同步完成删除。'
    : '请合并下面的内容，将相同的最终笔记分别保存到浏览器和 Obsidian 的“我的批注”，然后同步。';
  const contents = '# 笔记同步冲突\n\n卡片：' + path + '\n\n' + instructions + '原卡片不会被覆盖。此副本会保留供核对。\n\n## 上次同步\n\n' + base + '\n\n## 浏览器版本\n\n' + (browser ?? '（浏览器已删除此记录）') + '\n\n## Obsidian 版本\n\n' + obsidian + '\n';
  const name = 'Conflicts/' + await hashText(contents) + '.md';
  const target = await parentDirectory(root, name);
  // Identical conflicts are recorded once. Existing copies belong to the user.
  try { await target.directory.getFileHandle(target.name); }
  catch (error) {
    if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
    const handle = await target.directory.getFileHandle(target.name, { create: true });
    const writer = await handle.createWritable();
    try { await writer.write(contents); await writer.close(); }
    catch (error) { await writer.abort().catch(() => undefined); throw error; }
  }
  return name;
}

async function pullNotes(root: FileSystemDirectoryHandle): Promise<Set<string>> {
  const db = await database;
  const blocked = new Set<string>();
  const changed = new Set<string>();
  for (const record of await db.getAll('files')) {
    const match = /^Cards\/(a_[^/]+)\/.*--([^/]+)\.md$/.exec(record.path);
    if (!match) continue;
    const [, articleId, cardId] = match;
    try {
      let file: FileSystemFileHandle;
      try {
        const parent = await parentDirectory(root, record.path);
        file = await parent.directory.getFileHandle(parent.name);
      } catch (error) {
        if (error instanceof DOMException && error.name === 'NotFoundError') continue;
        throw error;
      }
      const current = await (await file.getFile()).text();
      const managed = managedCardPart(current);
      const hash = await hashText(managed);
      // Upgrade old exports only when their last recorded hash still matches.
      const base = record.base ?? (hash === record.hash ? managed : undefined);
      if (base === undefined || cardStructure(current) !== cardStructure(base)) throw new Error('文件存在外部修改：' + record.path + '。摘录、来源和分界标记属于引用材料，请恢复这些部分后同步。');
      const localNote = readCardNote(current);
      const baseNote = readCardNote(base);
      if (localNote.length > 100000) throw new Error('笔记过长：' + record.path);
      if (localNote === baseNote && hash === record.hash) continue;
      // Merge against the latest database value, not an earlier file-scan snapshot.
      const tx = db.transaction(['articles', 'sessions', 'pending', 'files'], 'readwrite');
      const article = await tx.objectStore('articles').get(articleId);
      const annotation = article?.annotations.find(item => item.id === cardId);
      const isPage = cardId === articleId + '-note';
      const browserNote = !article || article.deletedAt || (!annotation && !isPage) ? null : (isPage ? article.pageNote : annotation!.note).trim();
      const merged = browserNote === null ? { note: '', conflict: true } : mergeNote(baseNote, browserNote, localNote);
      if (merged.conflict) {
        await tx.done;
        const copy = await conflictCopy(root, record.path, baseNote, browserNote, localNote);
        throw new Error('笔记同步冲突：' + record.path + '。两个版本已保留在 ' + copy + '，请合并后将两边保存为相同内容，再同步。');
      }
      if (article && browserNote !== merged.note) {
        const now = new Date().toISOString();
        if (isPage) { article.pageNote = merged.note; article.pageNoteCard = true; }
        else { annotation!.note = merged.note; annotation!.updatedAt = now; }
        article.updatedAt = now;
        await tx.objectStore('articles').put(article);
        changed.add(article.url);
      }
      await tx.objectStore('files').put({ ...record, hash, base: managed });
      await tx.objectStore('pending').put({ key: 'article:' + articleId, version: crypto.randomUUID() });
      await tx.objectStore('pending').put({ key: 'index', version: crypto.randomUUID() });
      const visits = await tx.objectStore('sessions').index('articleId').getAll(articleId);
      for (const day of new Set(visits.map(visit => visit.day))) await tx.objectStore('pending').put({ key: 'day:' + day, version: crypto.randomUUID() });
      await tx.done;
    } catch (error) {
      blocked.add(articleId);
      const message = error instanceof Error ? error.message : String(error);
      await db.put('pending', { key: 'article:' + articleId, version: crypto.randomUUID(), error: message });
      await db.put('meta', message, 'syncError');
    }
  }
  if (changed.size) {
    for (const tab of await chrome.tabs.query({})) {
      if (tab.id && tab.url) {
        // Let the content script normalize its URL; refreshing other pages is harmless.
        if (tab.url.startsWith('http')) void chrome.tabs.sendMessage(tab.id, { type: 'NOTING_REFRESH' }).catch(() => undefined);
      }
    }
  }
  return blocked;
}

let inFlight: Promise<void> | undefined;
export function flushFiles(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = runLocked().finally(() => { inFlight = undefined; });
  return inFlight;
}

async function runLocked() {
  await navigator.locks.request('noting-file-output', flush);
}

async function flush() {
  const db = await database;
  if (await db.get('meta', 'outputVersion') !== 4) {
    const migration = db.transaction(['articles', 'sessions', 'pending', 'meta'], 'readwrite');
    const articles = await migration.objectStore('articles').getAllKeys();
    const sessions = await migration.objectStore('sessions').getAll();
    for (const key of [...articles.map(id => `article:${id}`), ...new Set(sessions.map(session => `day:${session.day}`)), 'index']) {
      await migration.objectStore('pending').put({ key, version: crypto.randomUUID() });
    }
    await migration.objectStore('meta').put(4, 'outputVersion');
    await migration.done;
  }
  const directory = await getDirectory() as DirectoryHandle | undefined;
  if (!directory) return;
  if (await directory.queryPermission({ mode: 'readwrite' }) !== 'granted') {
    await db.put('meta', '需要重新授权文件夹，请打开设置。', 'syncError');
    return;
  }
  await db.delete('meta', 'syncError');
  const blocked = await pullNotes(directory);
  const jobs = await db.getAll('pending');
  // Read a consistent snapshot; newer revisions remain queued after this batch.
  const read = db.transaction(['articles', 'sessions'], 'readonly');
  const [articles, sessions] = await Promise.all([read.objectStore('articles').getAll(), read.objectStore('sessions').getAll()]);
  await read.done;
  let failed = blocked.size > 0;
  for (const job of jobs) {
    if (job.key.startsWith('article:') && blocked.has(job.key.slice(8))) continue;
    try {
      if (job.key.startsWith('article:')) {
        const article = articles.find(item => item.id === job.key.slice(8));
        if (!article) throw new Error('找不到待写入的文章');
        const cards = articleCards(article);
        for (const annotation of article.annotations) {
          const data = annotation.image?.data;
          if (!data) continue;
          const target = await parentDirectory(directory, imageAttachmentPath(article.id, annotation));
          const file = await target.directory.getFileHandle(target.name, { create: true });
          const blob = await (await fetch(data)).blob();
          const existing = await file.getFile();
          if (existing.size) {
            const before = new Uint8Array(await existing.arrayBuffer());
            const after = new Uint8Array(await blob.arrayBuffer());
            if (before.length === after.length && before.every((byte, index) => byte === after[index])) continue;
            throw new Error('图片附件存在外部修改：' + target.name);
          }
          const writer = await file.createWritable();
          try { await writer.write(blob); await writer.close(); }
          catch (error) { await writer.abort().catch(() => undefined); throw error; }
        }
        for (const card of cards) await writeFile(directory, card.path, card.markdown);
        const paths = new Set(cards.map(card => card.path));
        for (const path of await db.getAllKeys('files')) {
          if (path.startsWith(`Cards/${article.id}/`) && !paths.has(path)) await writeFile(directory, path, null);
        }
        await writeFile(directory, `Data/articles/${article.id}.json`, JSON.stringify({ schemaVersion: 1, article }, null, 2) + '\n');
        await writeFile(directory, `Articles/${article.id}.md`, article.deletedAt ? null : articleMarkdown(article, sessions));
      } else if (job.key.startsWith('day:')) {
        const day = job.key.slice(4);
        await writeFile(directory, `Daily/${day}.md`, dayMarkdown(day, sessions, articles));
        const rows = sessions.filter(session => session.day === day).map(session => JSON.stringify({ schemaVersion: 1, ...session }));
        await writeFile(directory, `Data/history/${day}.jsonl`, rows.length ? rows.join('\n') + '\n' : '');
      } else if (job.key === 'index') {
        await writeFile(directory, '卡片盒.md', indexMarkdown(articles, sessions));
        await writeFile(directory, '阅读索引.md', indexMarkdown(articles, sessions));
      }
      const tx = db.transaction('pending', 'readwrite');
      if ((await tx.store.get(job.key))?.version === job.version) await tx.store.delete(job.key);
      await tx.done;
    } catch (error) {
      failed = true;
      const message = error instanceof Error ? error.message : String(error);
      const tx = db.transaction('pending', 'readwrite');
      if ((await tx.store.get(job.key))?.version === job.version) await tx.store.put({ ...job, error: message });
      await tx.done;
      await db.put('meta', message, 'syncError');
    }
  }
  if (jobs.length && !failed) await db.put('meta', new Date().toISOString(), 'lastSync');
}
