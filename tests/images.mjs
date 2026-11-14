import { exposeExtensionUI } from './extension-ui.mjs';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const server = createServer((request, response) => {
  if (request.url.startsWith('/diagram.svg')) {
    response.setHeader('Content-Type', 'image/svg+xml');
    response.end('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="180"><rect width="400" height="180" fill="#e2eadb"/><text x="100" y="100" font-size="24">Noting image</text></svg>');
    return;
  }
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end('<title>图片笔记测试</title><style>body{margin:100px;font:18px system-ui}img{display:block;margin:40px 0}</style><h1>图片笔记测试</h1><p>架构图</p><a href="/original" id="linked"><img id="diagram" src="/diagram.svg" alt="架构图"></a><img id="second" src="/diagram.svg?second" alt="另一张图"><img id="temporary" width="100" height="100" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E">');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const profile = await mkdtemp(path.join(tmpdir(), 'noting-images-'));
let context;
const errors = [];
async function call(page, message) {
  const response = await page.evaluate(message => chrome.runtime.sendMessage(message), message);
  assert.equal(response.ok, true, response.error);
  return response.data;
}
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
    channel: process.env.CHROMIUM_EXECUTABLE ? undefined : 'chromium', headless: true,
    args: [`--disable-extensions-except=${path.resolve('dist')}`, `--load-extension=${path.resolve('dist')}`],
    viewport: { width: 1280, height: 1000 },
  });
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const options = await context.newPage();
  await options.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);
  // Connect a real filesystem handle to exercise Markdown and JSON export.
  await options.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle('image-vault', { create: true });
    const db = await new Promise(resolve => { const request = indexedDB.open('noting'); request.onsuccess = () => resolve(request.result); });
    const tx = db.transaction('meta', 'readwrite');
    tx.objectStore('meta').put(directory, 'directory');
    await new Promise(resolve => { tx.oncomplete = resolve; });
    db.close();
  });
  const page = await context.newPage();
  await page.goto(base + '/article');
  await exposeExtensionUI(page);
  const hover = async selector => {
    const toolbar = page.getByRole('toolbar', { name: '划线笔记图片工具', exact: true });
    // The extension can still be loading page settings on the first hover.
    for (let attempt = 0; attempt < 10; attempt++) {
      await page.mouse.move(0, 0);
      await page.locator(selector).hover();
      try { await toolbar.waitFor({ timeout: 500 }); return; }
      catch (error) { if (error.name !== 'TimeoutError' || attempt === 9) throw error; }
    }
  };
  await hover('#diagram');
  await page.getByRole('toolbar', { name: '划线笔记图片工具' }).getByRole('button', { name: '记笔记', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '编辑图片笔记', exact: true });
  await editor.locator('img').waitFor();
  assert.equal(await editor.locator('img').getAttribute('src'), base + '/diagram.svg');
  await page.getByRole('textbox', { name: '图片笔记', exact: true }).fill('图中的模块通过事件协作。');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await editor.waitFor({ state: 'hidden' });
  let backup = await call(options, { type: 'BACKUP' });
  assert.equal(backup.articles[0].annotations[0].note, '图中的模块通过事件协作。');
  assert.equal(backup.articles[0].annotations[0].image.url, base + '/diagram.svg');
  assert.equal(await page.evaluate(() => CSS.highlights.get('noting-yellow')?.size), 0, '图片不能把同名文字标成高亮');
  await hover('#second');
  await page.getByRole('button', { name: '收录图片', exact: true }).click();
  await page.getByRole('toolbar', { name: '划线笔记图片工具', exact: true }).waitFor({ state: 'hidden' });
  backup = await call(options, { type: 'BACKUP' });
  assert.equal(backup.articles[0].annotations.length, 2);
  assert.equal(backup.articles[0].annotations[1].note, '');
  await page.reload();
  await exposeExtensionUI(page);
  await hover('#diagram');
  await page.getByRole('button', { name: '查看笔记', exact: true }).click();
  const reader = page.getByRole('dialog', { name: '查看图片笔记', exact: true });
  await reader.getByText('图中的模块通过事件协作。', { exact: true }).waitFor();
  await reader.getByRole('button', { name: '关闭笔记编辑器' }).click();
  await page.route('**/diagram.svg*', route => route.abort());
  await page.reload();
  await exposeExtensionUI(page);
  await worker.evaluate(async () => {
    const tab = (await chrome.tabs.query({})).find(tab => tab.url?.endsWith('/article'));
    await chrome.tabs.sendMessage(tab.id, { type: 'NOTING_TOGGLE' });
  });
  const card = page.locator(`.card[data-annotation-id="${backup.articles[0].annotations[0].id}"]`);
  await card.locator('img').waitFor();
  assert.ok(await card.locator('img').evaluate(async img => { await img.decode(); return img.src.startsWith('data:image/'); }));
  await card.getByRole('button', { name: '编辑笔记', exact: true }).click();
  await page.getByRole('textbox', { name: '图片笔记', exact: true }).fill('更新后的图片理解 #架构');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await editor.waitFor({ state: 'hidden' });
  await call(options, { type: 'FLUSH' });
  const files = await options.evaluate(async () => {
    const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle('image-vault');
    const cards = await directory.getDirectoryHandle('Cards');
    const result = [];
    for await (const [, folder] of cards.entries()) for await (const [, file] of folder.entries()) result.push(await (await file.getFile()).text());
    return result;
  });
  assert.equal(files.length, 2);
  const article = backup.articles[0];
  const attachment = article.annotations[0].id + '.svg';
  assert.ok(files.some(text => text.includes(`![架构图](<../../Attachments/${article.id}/${attachment}>)`) && text.includes('更新后的图片理解 #架构')));
  const saved = await options.evaluate(async ([id, name]) => {
    let directory = await navigator.storage.getDirectory();
    for (const part of ['image-vault', 'Attachments', id]) directory = await directory.getDirectoryHandle(part);
    return (await (await directory.getFileHandle(name)).getFile()).text();
  }, [article.id, attachment]);
  assert.equal(saved, Buffer.from(article.annotations[0].image.data.split(',')[1], 'base64').toString());
  assert.equal((await call(options, { type: 'STATUS' })).pending.length, 0);
  backup = await call(options, { type: 'BACKUP' });
  await call(options, { type: 'IMPORT', backup });
  assert.deepEqual((await call(options, { type: 'BACKUP' })).articles[0].annotations, backup.articles[0].annotations);
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/image-notes.png' });
  await options.evaluate(async ([articleId, annotationId]) => {
    const vault = await (await navigator.storage.getDirectory()).getDirectoryHandle('image-vault');
    const folder = await (await vault.getDirectoryHandle('Cards')).getDirectoryHandle(articleId);
    for await (const [name, file] of folder.entries()) {
      if (!name.endsWith('--' + annotationId + '.md')) continue;
      const text = await (await file.getFile()).text();
      const writer = await file.createWritable();
      await writer.write(text + '\n在 Obsidian 补写的内容');
      await writer.close();
      return;
    }
    throw new Error('未找到目标测试卡片');
  }, [article.id, article.annotations[0].id]);
  await card.getByRole('button', { name: '编辑笔记', exact: true }).click();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '删除图片笔记', exact: true }).click();
  await card.waitFor({ state: 'hidden' });
  await call(options, { type: 'REQUEUE' });
  await call(options, { type: 'FLUSH' });
  const remaining = await options.evaluate(async id => {
    const vault = await (await navigator.storage.getDirectory()).getDirectoryHandle('image-vault');
    const folder = await (await vault.getDirectoryHandle('Cards')).getDirectoryHandle(id);
    return Array.fromAsync(folder.keys());
  }, article.id);
  assert.equal(remaining.length, 1);
  assert.ok(remaining[0].endsWith('--' + article.annotations[1].id + '.md'));
  assert.equal((await call(options, { type: 'BACKUP' })).articles[0].annotations.length, 1);
  await page.getByRole('button', { name: '关闭侧边栏', exact: true }).click();
  await hover('#temporary');
  await page.getByRole('button', { name: '收录图片', exact: true }).click();
  await page.getByText('暂时只支持 HTTP / HTTPS 图片链接', { exact: true }).waitFor();
  assert.equal((await call(options, { type: 'BACKUP' })).articles[0].annotations.length, 1);
  // The image's original link still works after adding hover controls.
  await page.locator('#diagram').click();
  await page.waitForURL(base + '/original');
  assert.deepEqual(errors, []);
  console.log('PASS 图片悬停、批注、直接保存、刷新、编辑、删除、备份、Obsidian 导出与原链接');
} finally {
  await context?.close();
  await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
