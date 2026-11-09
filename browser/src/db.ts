import { openDB, type DBSchema, type IDBPTransaction } from 'idb';
import { DEFAULT_SETTINGS, type Article, type Session, type Pending, type Settings } from '../../shared/model';
import type { FlomoJob } from './flomo-api';

interface NotingDB extends DBSchema {
  flomo: { key: string; value: FlomoJob };
  articles: { key: string; value: Article };
  sessions: { key: string; value: Session; indexes: { articleId: string; day: string } };
  pending: { key: string; value: Pending };
  files: { key: string; value: { path: string; hash: string; base?: string } };
  meta: { key: string; value: unknown };
}

export const database = openDB<NotingDB>('noting', 2, {
  upgrade(db, oldVersion) {
    db.createObjectStore('flomo', { keyPath: 'key' });
    if (oldVersion >= 1) return;
    db.createObjectStore('articles', { keyPath: 'id' });
    const sessions = db.createObjectStore('sessions', { keyPath: 'id' });
    sessions.createIndex('articleId', 'articleId');
    sessions.createIndex('day', 'day');
    db.createObjectStore('pending', { keyPath: 'key' });
    db.createObjectStore('files', { keyPath: 'path' });
    db.createObjectStore('meta');
  },
});

export type WriteTransaction = IDBPTransaction<NotingDB, ('articles' | 'sessions' | 'pending' | 'flomo')[], 'readwrite'>;

export async function dirty(tx: WriteTransaction, key: string) {
  await tx.objectStore('pending').put({ key, version: crypto.randomUUID() });
}

export async function saveArticle(tx: WriteTransaction, article: Article) {
  article.updatedAt = new Date().toISOString();
  await tx.objectStore('articles').put(article);
  await dirty(tx, 'article:' + article.id);
  await dirty(tx, 'index');
  const visits = await tx.objectStore('sessions').index('articleId').getAll(article.id);
  for (const day of new Set(visits.map(visit => visit.day))) await dirty(tx, 'day:' + day);
}

export async function getSettings(): Promise<Settings> {
  return { ...DEFAULT_SETTINGS, ...await (await database).get('meta', 'settings') as Partial<Settings> };
}

export async function getDirectory(): Promise<FileSystemDirectoryHandle | undefined> {
  return await (await database).get('meta', 'directory') as FileSystemDirectoryHandle | undefined;
}
