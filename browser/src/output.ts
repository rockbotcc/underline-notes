import { database, getSettings } from './db';
import { flushFiles } from './files';
import { flomoContent, postFlomo } from './flomo-api';
import { flushSiyuan } from './siyuan-output';

let inFlight: Promise<void> | undefined;
export async function flushOutput(force = false): Promise<void> {
  if (inFlight) {
    await inFlight;
    if (!force) return;
  }
  await (inFlight ??= run(force).finally(() => { inFlight = undefined; }));
}

async function run(force: boolean) {
  await navigator.locks.request('noting-output', async () => {
    const settings = await getSettings();
    if (settings.outputTarget === 'obsidian') { await flushFiles(); return; }
    if (settings.outputTarget === 'siyuan') { if (settings.siyuan) await flushSiyuan(settings.siyuan, force); return; }
    const db = await database;
    // Bound each batch so large queues do not monopolize the service worker.
    const jobs = (await db.getAll('flomo')).filter(job => job.content !== job.sentContent && (force || !job.retryAfter || job.retryAfter <= Date.now())).slice(0, 10);
    for (let job of jobs) {
      const current = await getSettings();
      if (current.outputTarget !== 'flomo' || current.flomoApiUrl !== settings.flomoApiUrl) return;
      // Imports and local edits may have changed a paused job's source. Send the
      // latest surviving note, never an obsolete snapshot or a deleted record.
      const read = db.transaction(['articles', 'flomo'], 'readwrite');
      const latestJob = await read.objectStore('flomo').get(job.key);
      const article = await read.objectStore('articles').get(job.articleId);
      const cardId = job.key.slice(job.articleId.length + 1);
      const annotation = article?.annotations.find(item => item.id === cardId);
      if (latestJob?.version !== job.version) { await read.done; continue; }
      if (!article || article.deletedAt || (cardId === 'page' ? !article.pageNote.trim() : !annotation)) {
        await read.objectStore('flomo').delete(job.key);
        await read.done;
        continue;
      }
      const content = flomoContent(article, annotation);
      if (content !== job.content) {
        job = { ...job, content, version: crypto.randomUUID(), error: undefined, retryAfter: undefined };
        await read.objectStore('flomo').put(job);
      }
      await read.done;
      if (job.content === job.sentContent) continue;
      try {
        await postFlomo(settings.flomoApiUrl, job.content);
        const tx = db.transaction('flomo', 'readwrite');
        const latest = await tx.store.get(job.key);
        if (latest) await tx.store.put({ ...latest, sentContent: job.content, error: undefined, retryAfter: undefined });
        await tx.done;
        await db.put('meta', new Date().toISOString(), 'flomoLastSync');
      } catch (error) {
        const tx = db.transaction('flomo', 'readwrite');
        const latest = await tx.store.get(job.key);
        if (latest?.version === job.version) await tx.store.put({ ...latest, error: (error as Error).message, retryAfter: Date.now() + 60000 });
        await tx.done;
        if (job.content.length <= 5000) break;
      }
    }
  });
}
