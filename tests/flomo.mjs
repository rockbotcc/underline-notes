import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const profile = await mkdtemp(path.join(tmpdir(), 'noting-flomo-'));
const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<title>flomo 测试文章</title><article><h1>多设备阅读笔记</h1><p id="quote">值得保留的原文摘录。</p><p>' + '阅读与思考。'.repeat(300) + '</p></article>'); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
    channel: process.env.CHROMIUM_EXECUTABLE ? undefined : 'chromium', headless: true,
    args: [`--disable-extensions-except=${path.resolve('dist')}`, `--load-extension=${path.resolve('dist')}`],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const options = await context.newPage();
  await options.goto(`chrome-extension://${id}/options.html`);
  async function call(message) {
    const response = await options.evaluate(message => chrome.runtime.sendMessage(message), message);
    assert.equal(response.ok, true, response.error);
    return response.data;
  }
  await options.locator('#output-target').waitFor();
  assert.equal((await call({ type: 'STATUS' })).settings.outputTarget, 'obsidian');
  // Intercept inside the real extension worker. No requests reach a flomo account.
  await worker.evaluate(() => {
    globalThis.flomoCalls = [];
    globalThis.flomoFail = false;
    const originalFetch = fetch;
    globalThis.fetch = async (url, init) => {
      if (!String(url).startsWith('https://flomoapp.com/iwh/')) return originalFetch(url, init);
      globalThis.flomoCalls.push(JSON.parse(init.body));
      return Response.json(globalThis.flomoFail ? { code: -1, message: String(url) } : { code: 0 });
    };
  });
  await options.selectOption('#output-target', 'flomo');
  await options.fill('#flomo-api-url', 'https://flomoapp.com/iwh/test/secret/');
  await options.uncheck('#record-history');
  await options.getByRole('button', { name: '保存写入设置', exact: true }).click();
  await options.getByText('设置已保存。', { exact: true }).waitFor();
  // flomo can optionally read vault tags, but sending notes needs no folder.
  await options.getByRole('button', { name: '连接 Obsidian 文件夹以读取标签', exact: true }).waitFor();
  assert.equal(await options.locator('#local-flow').isVisible(), false);
  assert.equal(await options.locator('#restore-directory').isVisible(), false);
  assert.equal((await call({ type: 'STATUS' })).directoryName, '');
  await options.reload();
  await options.waitForFunction(() => document.querySelector('#output-target').value === 'flomo');
  assert.equal(await options.inputValue('#flomo-api-url'), 'https://flomoapp.com/iwh/test/secret/');
  assert.equal(await options.locator('#flomo-api-url').getAttribute('type'), 'password');
  assert.equal(await worker.evaluate(() => flomoCalls.length), 0, 'configuration must not create a test memo');
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/article`);
  await page.locator('#noting-extension').waitFor({ state: 'attached' });
  await worker.evaluate(async () => {
    const tab = (await chrome.tabs.query({})).find(tab => tab.url?.includes('/article'));
    await chrome.tabs.sendMessage(tab.id, { type: 'NOTING_TOGGLE' });
  });
  async function saveNote(note) {
    await page.getByRole('button', { name: '编辑文章笔记', exact: true }).click();
    await page.getByRole('textbox', { name: '文章笔记', exact: true }).fill(note);
    await page.getByRole('button', { name: '保存文章笔记', exact: true }).click();
    await page.getByRole('textbox', { name: '文章笔记', exact: true }).waitFor({ state: 'hidden' });
    await call({ type: 'FLUSH' });
  }
  await saveNote('跨设备记录 #阅读');
  assert.equal(await worker.evaluate(() => flomoCalls.length), 1);
  assert.match(await worker.evaluate(() => flomoCalls[0].content), /跨设备记录 #阅读/);
  assert.match(await worker.evaluate(() => flomoCalls[0].content), /http:\/\/127.0.0.1/);
  assert.match(await worker.evaluate(() => flomoCalls[0].content), /#划线笔记\/127\.0\.0\.1\n/, 'default nested tag uses the source hostname without its port or path');
  assert.equal((await call({ type: 'STATUS' })).pending.length, 0);
  await saveNote('跨设备记录 #阅读');
  await Promise.all([call({ type: 'FLUSH' }), call({ type: 'FLUSH' })]);
  assert.equal(await worker.evaluate(() => flomoCalls.length), 1, 'unchanged notes and repeated flushes must not duplicate');
  await worker.evaluate(() => { flomoFail = true; });
  await saveNote('更新后的笔记');
  let status = await call({ type: 'STATUS' });
  assert.equal(status.pending.length, 1);
  assert.match(status.syncError, /flomo 未接受/);
  assert.ok(!status.syncError.includes('secret'));
  assert.ok(!JSON.stringify(await call({ type: 'BACKUP' })).includes('/iwh/'));
  await worker.evaluate(() => { flomoFail = false; });
  await call({ type: 'FLUSH' });
  status = await call({ type: 'STATUS' });
  assert.equal(status.pending.length, 0);
  assert.equal(status.syncError, undefined);
  await page.getByRole('button', { name: '关闭侧边栏', exact: true }).click();
  await page.locator('#quote').evaluate(node => {
    const range = document.createRange();
    range.selectNodeContents(node);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.getByRole('button', { name: '黄色划线', exact: true }).click();
  await page.waitForFunction(() => CSS.highlights.get('noting-yellow')?.size === 1);
  await call({ type: 'FLUSH' });
  assert.match(await worker.evaluate(() => flomoCalls.at(-1).content), /“值得保留的原文摘录。”/);
  assert.match(await worker.evaluate(() => flomoCalls.at(-1).content), /#划线笔记\/127\.0\.0\.1\n/);
  await worker.evaluate(async () => {
    const tab = (await chrome.tabs.query({})).find(tab => tab.url?.includes('/article'));
    await chrome.tabs.sendMessage(tab.id, { type: 'NOTING_TOGGLE' });
  });
  const sent = await worker.evaluate(() => flomoCalls.length);
  await options.reload();
  await call({ type: 'FLUSH' });
  assert.equal(await worker.evaluate(() => flomoCalls.length), sent, 'receipts survive page reloads');
  await mkdir('test-results', { recursive: true });
  await options.screenshot({ path: 'test-results/flomo-settings.png', fullPage: true });
  // The local destination resumes the existing file exporter and stops network output.
  await options.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('Reading', { create: true });
    const db = await new Promise(resolve => { const req = indexedDB.open('noting'); req.onsuccess = () => resolve(req.result); });
    const tx = db.transaction('meta', 'readwrite');
    tx.objectStore('meta').put(dir, 'directory');
    await new Promise(resolve => { tx.oncomplete = resolve; });
    db.close();
  });
  await call({ type: 'SAVE_SETTINGS', settings: { ...status.settings, outputTarget: 'obsidian' } });
  await call({ type: 'FLUSH' });
  assert.equal((await call({ type: 'STATUS' })).pending.length, 0);
  await saveNote('回到本地 Obsidian');
  assert.equal(await worker.evaluate(() => flomoCalls.length), sent);
  await call({ type: 'SAVE_SETTINGS', settings: status.settings });
  await call({ type: 'FLUSH' });
  assert.equal(await worker.evaluate(() => flomoCalls.length), sent, 'switching back does not bulk-send local changes');
  // Failed work is durable, pauses in local mode, and resumes with the latest note.
  await worker.evaluate(() => { flomoFail = true; });
  await saveNote('待重试的旧版本');
  await call({ type: 'SAVE_SETTINGS', settings: { ...status.settings, outputTarget: 'obsidian' } });
  await saveNote('暂停期间更新的版本');
  await worker.evaluate(() => { flomoFail = false; });
  await call({ type: 'SAVE_SETTINGS', settings: status.settings });
  await call({ type: 'FLUSH' });
  assert.match(await worker.evaluate(() => flomoCalls.at(-1).content), /暂停期间更新的版本/);
  assert.equal((await call({ type: 'STATUS' })).pending.length, 0);
  const sentBeforeDelete = await worker.evaluate(() => flomoCalls.length);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '移除本页记录', exact: true }).click();
  await page.getByText('你的摘录与想法会出现在这里。', { exact: false }).waitFor();
  await call({ type: 'FLUSH' });
  assert.equal(await worker.evaluate(() => flomoCalls.length), sentBeforeDelete, 'deletion does not call the append-only API');
  console.log('PASS flomo 设置持久化、真实侧栏保存、去重、失败重试、备份保密、切换本地输出和删除行为');
} finally {
  await context?.close();
  await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
