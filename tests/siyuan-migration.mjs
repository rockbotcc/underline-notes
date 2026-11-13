import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

for (const version of [1, 2]) {
  const root = await mkdtemp(path.join(tmpdir(), 'noting-migration-'));
  const extension = path.join(root, 'extension');
  await cp(path.resolve('dist'), extension, { recursive: true, dereference: true });
  const background = await readFile(path.join(extension, 'background.js'));
  const legacy = `const req = indexedDB.open('noting', ${version});
req.onupgradeneeded = () => {
  const db = req.result;
  for (const name of ['articles', 'sessions']) db.createObjectStore(name, {keyPath: 'id'});
  const tx = req.transaction;
  tx.objectStore('sessions').createIndex('articleId', 'articleId');
  tx.objectStore('sessions').createIndex('day', 'day');
  for (const name of ['pending'${version === 2 ? ", 'flomo'" : ''}]) db.createObjectStore(name, {keyPath:'key'});
  for (const name of ['files', 'meta']) db.createObjectStore(name);
};
req.onsuccess = () => req.result.close();`;
  await writeFile(path.join(extension, 'background.js'), legacy);
  let context;
  async function launch() {
    context = await chromium.launchPersistentContext(path.join(root, 'profile'), { channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    return worker;
  }
  try {
    let worker = await launch();
    await worker.evaluate(async version => {
      const db = await new Promise((resolve, reject) => { const r = indexedDB.open('noting'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      const tx = db.transaction(version === 2 ? ['meta', 'articles', 'flomo'] : ['meta', 'articles'], 'readwrite');
      tx.objectStore('meta').put('keep-me', 'migrationSentinel');
      tx.objectStore('articles').put({id: 'legacy-note', title: '必须保留', annotations: [], pageNote: '旧笔记'});
      if (version === 2) tx.objectStore('flomo').put({key: 'legacy-job', articleId: 'legacy-note', version: '1', content: '旧flomo笔记', sentContent: '旧flomo笔记'});
      await new Promise(resolve => { tx.oncomplete = resolve; }); db.close();
    }, version);
    await context.close();
    await writeFile(path.join(extension, 'background.js'), background);
    const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
    manifest.version = '0.4.2';
    await writeFile(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
    await rm(path.join(root, 'profile', 'Default', 'Service Worker'), { recursive: true, force: true });
    worker = await launch();
    const page = await context.newPage();
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);
    await page.waitForFunction(async () => (await chrome.runtime.sendMessage({type:'STATUS'}).catch(() => null))?.ok === true);
    const result = await worker.evaluate(async () => {
      const db = await new Promise((resolve, reject) => { const r = indexedDB.open('noting'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      const value = await new Promise(resolve => { const r = db.transaction('meta').objectStore('meta').get('migrationSentinel'); r.onsuccess = () => resolve(r.result); });
      const article = await new Promise(resolve => { const r = db.transaction('articles').objectStore('articles').get('legacy-note'); r.onsuccess = () => resolve(r.result); });
      const flomo = await new Promise(resolve => { const r = db.transaction('flomo').objectStore('flomo').get('legacy-job'); r.onsuccess = () => resolve(r.result); });
      const result = { version: db.version, stores: [...db.objectStoreNames], value, article, flomo }; db.close(); return result;
    });
    assert.equal(result.version, 3); assert.equal(result.value, 'keep-me');
    assert.equal(result.article.pageNote, '旧笔记');
    if (version === 2) assert.equal(result.flomo.sentContent, '旧flomo笔记');
    for (const store of ['articles', 'sessions', 'meta', 'pending', 'files', 'flomo', 'siyuanJobs', 'siyuanBindings']) assert.ok(result.stores.includes(store));
    console.log(`PASS IndexedDB v${version} → v3 保留旧数据并建立思源存储`);
  } finally { await context?.close(); await rm(root, { recursive: true, force: true }); }
}
