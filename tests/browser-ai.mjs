import { exposeExtensionUI } from './extension-ui.mjs';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

let fail = false;
const requests = [];
const server = createServer(async (req, res) => {
  if (req.url === '/v1/chat/completions') {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.writeHead(fail ? 503 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '{"tags":["写作","未知标签"]}' } }] }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<html><title>测试文章</title><body><article><p id="quote">写作帮助我们整理想法。</p></article></body></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const profile = await mkdtemp(path.join(tmpdir(), 'noting-ai-'));
let context;
try {
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${path.resolve('dist')}`, `--load-extension=${path.resolve('dist')}`] });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const options = await context.newPage();
  await options.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);
  const call = async message => {
    const result = await options.evaluate(message => chrome.runtime.sendMessage(message), message);
    assert.equal(result.ok, true, result.error);
    return result.data;
  };
  const page = await context.newPage();
  await page.goto(base + '/article');
  await exposeExtensionUI(page);
  await page.locator('#quote').evaluate(node => {
    const range = document.createRange(); range.selectNodeContents(node);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.getByRole('button', { name: '黄色划线', exact: true }).click();
  await page.waitForFunction(() => CSS.highlights.get('noting-yellow')?.size === 1);
  await worker.evaluate(async () => {
    const tab = (await chrome.tabs.query({})).find(tab => tab.url?.includes('/article'));
    await chrome.tabs.sendMessage(tab.id, { type: 'NOTING_TOGGLE' });
  });
  await page.getByRole('button', { name: '添加笔记', exact: true }).click();
  await page.getByRole('textbox', { name: '划线笔记', exact: true }).fill('初始笔记 #浏览器独有');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByText('初始笔记 #浏览器独有', { exact: true }).waitFor();
  // Model vocabulary comes from the Obsidian export, not the note above.
  await options.evaluate(async () => {
    const directory = await navigator.storage.getDirectory();
    const data = await directory.getDirectoryHandle('Data', { create: true });
    const writer = await (await data.getFileHandle('vault-tags.json', { create: true })).createWritable();
    await writer.write(JSON.stringify({ schemaVersion: 1, source: 'obsidian-vault', tags: ['写作', '仓库独有'] }));
    await writer.close();
    const db = await new Promise(resolve => { const req = indexedDB.open('noting'); req.onsuccess = () => resolve(req.result); });
    const tx = db.transaction('meta', 'readwrite'); tx.objectStore('meta').put(directory, 'directory');
    await new Promise(resolve => { tx.oncomplete = resolve; }); db.close();
  });
  await options.locator('#ai-enabled').check({ force: true });
  await options.locator('#ai-base-url').fill(base + '/v1');
  await options.locator('#ai-api-key').fill('test-secret');
  await options.locator('#ai-model').fill('test-model');
  await options.getByRole('button', { name: '保存模型设置', exact: true }).click();
  await options.getByText('设置已保存。', { exact: true }).waitFor();
  await options.reload();
  await options.locator('#ai-model').waitFor();
  assert.equal((await call({ type: 'STATUS' })).settings.ai.apiKey, 'test-secret');
  const edit = async (old, note) => {
    await page.getByText(old, { exact: true }).dblclick();
    await page.getByRole('textbox', { name: '划线笔记', exact: true }).fill(note);
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('dialog', { name: '编辑划线笔记', exact: true }).waitFor({ state: 'hidden' });
  };
  await edit('初始笔记 #浏览器独有', '整理表达');
  let backup = await call({ type: 'BACKUP' });
  assert.equal(backup.articles[0].annotations[0].note, '整理表达\n\n#写作');
  assert.ok(!JSON.stringify(backup).includes('test-secret'));
  assert.deepEqual(new Set(JSON.parse(requests[0].messages[1].content).allowedTags), new Set(['写作', '仓库独有']));
  fail = true;
  await edit('整理表达\n\n#写作', '失败时仍保存 #写作');
  backup = await call({ type: 'BACKUP' });
  assert.equal(backup.articles[0].annotations[0].note, '失败时仍保存 #写作');
  assert.match((await call({ type: 'STATUS' })).aiTagError, /自动标签未完成/);
  console.log('PASS 模型配置持久化、已有标签过滤、失败保存和备份凭据隔离');
} finally {
  await context?.close();
  await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
