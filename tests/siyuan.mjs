import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const profile = await mkdtemp(path.join(tmpdir(), 'noting-siyuan-'));
const notebook = '20261112000000-testbox';
const otherNotebook = '20261112000000-otherxx';
const documents = new Map();
let writes = 0, offline = false, unsupported = false, loseResponse = false, holdWrite, heldWrite;
const calls = [];
const server = createServer(async (req, res) => {
  if (!req.url.startsWith('/api/')) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<title>思源测试 C/C++</title><article><h1>思源测试</h1><p id="quote">值得保留的原文摘录。</p><p>' + '阅读与思考。'.repeat(300) + '</p></article>'); return;
  }
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  calls.push({ path: req.url, body });
  const reply = data => { if (!res.destroyed) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ code: 0, data })); } };
  if (offline) { res.writeHead(503); res.end(); return; }
  if (req.headers.authorization !== 'Token test-secret') { res.writeHead(403); res.end(); return; }
  switch (req.url) {
    case '/api/system/version': reply('3.8.10'); break;
    case '/api/notebook/lsNotebooks': reply({ notebooks: [{ id: notebook, name: '测试笔记本', closed: false }, { id: otherNotebook, name: '另一笔记本', closed: false }] }); break;
    case '/api/notebook/getNotebookConf': reply({ documentCapabilities: { structuredPaths: !unsupported } }); break;
    case '/api/filetree/getDocPaths': reply({ documents: body.ids.filter(id => documents.get(id)?.notebook === body.notebook).map(id => ({ id })), missingIDs: body.ids.filter(id => documents.get(id)?.notebook !== body.notebook) }); break;
    case '/api/block/getBlockKramdown': reply({ id: body.id, kramdown: documents.get(body.id)?.markdown || '' }); break;
    case '/api/filetree/createDocByParent': {
      if (documents.has(body.id)) { res.end(JSON.stringify({ code: -1 })); return; }
      documents.set(body.id, { notebook: body.notebook, parentID: body.parentID, markdown: body.markdown, title: body.title.text }); writes++;
      if (holdWrite) { heldWrite?.(); await holdWrite; holdWrite = undefined; }
      if (loseResponse) { loseResponse = false; res.destroy(); return; }
      reply({ id: body.id }); break;
    }
    case '/api/block/appendBlock': {
      const doc = documents.get(body.parentID); assert.ok(doc);
      const ids = [...body.data.matchAll(/id="(\d{14}-[a-z0-9]{7})"/g)].map(match => match[1]);
      if (!ids.every(id => !doc.markdown.includes(id))) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({code:-1})); return; }
      doc.markdown += '\n\n' + body.data; writes++;
      if (holdWrite) { heldWrite?.(); await holdWrite; holdWrite = undefined; }
      if (loseResponse) { loseResponse = false; res.destroy(); return; }
      reply([{ doOperations: [{ id: ids[0] }] }]); break;
    }
    default: res.writeHead(404); res.end();
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
let context, options, worker, page;
async function launch() {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
    channel: process.env.CHROMIUM_EXECUTABLE ? undefined : 'chromium', headless: true,
    args: [`--disable-extensions-except=${path.resolve('dist')}`, `--load-extension=${path.resolve('dist')}`],
  });
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  options = await context.newPage();
  await options.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);
  await options.locator('#output-target').waitFor();
  options.setDefaultTimeout(10000);
}
async function call(message) {
  const response = await options.evaluate(message => chrome.runtime.sendMessage(message), message);
  assert.equal(response.ok, true, response.error); return response.data;
}
async function openArticle() {
  page = await context.newPage(); await page.goto(baseUrl + '/article');
  await page.locator('#noting-extension').waitFor({ state: 'attached' });
  await worker.evaluate(async () => {
    const tab = (await chrome.tabs.query({})).find(tab => tab.url?.includes('/article'));
    await chrome.tabs.sendMessage(tab.id, { type: 'NOTING_TOGGLE' });
  });
}
async function saveNote(note, flush = true) {
  await page.getByRole('button', { name: '编辑文章笔记', exact: true }).click();
  await page.getByRole('textbox', { name: '文章笔记', exact: true }).fill(note);
  await page.getByRole('button', { name: '保存文章笔记', exact: true }).click();
  await page.getByRole('textbox', { name: '文章笔记', exact: true }).waitFor({ state: 'hidden' });
  if (flush) await call({ type: 'FLUSH' });
}
try {
  await launch();
  await options.selectOption('#output-target', 'siyuan');
  await options.fill('#siyuan-base-url', 'not-a-url');
  await options.selectOption('#output-target', 'obsidian');
  await options.getByRole('button', { name: '保存写入设置', exact: true }).click();
  await options.getByText('设置已保存。', { exact: true }).waitFor();
  assert.equal((await call({ type: 'STATUS' })).settings.outputTarget, 'obsidian');
  await options.selectOption('#output-target', 'siyuan');
  await options.fill('#siyuan-base-url', baseUrl); await options.fill('#siyuan-token', 'test-secret');
  await options.getByRole('button', { name: '测试连接并读取笔记本' }).click();
  await options.getByText('已连接思源 3.8.10', { exact: false }).waitFor();
  await options.selectOption('#siyuan-notebook', notebook);
  await options.uncheck('#record-history');
  await options.getByRole('button', { name: '保存写入设置', exact: true }).click();
  await options.getByText('设置已保存。', { exact: true }).waitFor();
  await options.waitForFunction(() => document.querySelector('#connection-title').textContent === '写入思源笔记');
  const settings = (await call({ type: 'STATUS' })).settings;
  assert.equal(writes, 0, 'configuration/test must be read only');
  assert.equal(await options.locator('#local-flow').isVisible(), false);
  assert.equal(await options.locator('#siyuan-token').getAttribute('type'), 'password');
  await openArticle();
  await saveNote('最初的笔记 **重点**');
  assert.equal(documents.size, 2); assert.equal(writes, 2);
  let card = [...documents.values()].find(doc => doc.parentID);
  assert.ok(card.markdown.includes('最初的笔记'));
  card.markdown += '\n\n思源中补写的内容';
  await saveNote('最初的笔记 **重点**'); await call({ type: 'FLUSH' });
  assert.equal(writes, 2);
  await saveNote('第二版笔记');
  assert.equal(writes, 3); assert.ok(card.markdown.includes('思源中补写的内容'));
  assert.ok(card.markdown.includes('最初的笔记')); assert.ok(card.markdown.includes('第二版笔记'));
  // Response loss after commit: the next attempt must read the receipt and never append again.
  loseResponse = true;
  await saveNote('响应丢失后的笔记', false);
  await options.waitForFunction(async () => (await chrome.runtime.sendMessage({type: 'STATUS'})).data.pending.length === 0);
  await call({ type: 'FLUSH' });
  assert.equal(writes, 4); assert.equal((await call({ type: 'STATUS' })).pending.length, 0);
  offline = true;
  await saveNote('离线草稿一'); await saveNote('离线草稿二');
  assert.equal((await call({ type: 'STATUS' })).pending.length, 1);
  await context.close(); await launch(); await openArticle();
  offline = false;
  await call({ type: 'FLUSH' });
  assert.equal(writes, 5); assert.ok(card.markdown.includes('离线草稿二')); assert.ok(!card.markdown.includes('离线草稿一'));
  assert.ok(!JSON.stringify(await call({ type: 'BACKUP' })).includes('test-secret'));
  // Inspect actual content-script message response, rather than merely checking DOM.
  const session = await context.newCDPSession(page);
  const worlds = []; session.on('Runtime.executionContextCreated', event => worlds.push(event.context));
  await session.send('Runtime.enable');
  const world = worlds.find(item => item.origin.startsWith('chrome-extension://'));
  assert.ok(world, 'extension content-script world exists');
  const publicState = await session.send('Runtime.evaluate', { contextId: world.id, expression: `chrome.runtime.sendMessage({type:'GET_PAGE',page:{url:location.href,title:document.title}})`, awaitPromise: true, returnByValue: true });
  assert.ok(!JSON.stringify(publicState).includes('test-secret'));
  assert.ok(!JSON.stringify(publicState).includes('apiToken'));
  // New edit while an older append is in flight must survive the old receipt.
  let release;
  holdWrite = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { heldWrite = resolve; });
  await saveNote('发送中的版本', false); await started;
  await saveNote('发送期间的新修改', false); release();
  await call({ type: 'FLUSH' }); await call({ type: 'FLUSH' });
  assert.equal(writes, 7); assert.ok(card.markdown.includes('发送期间的新修改'));
  // Destination changes must not reassign an existing queue.
  offline = true; await saveNote('旧目的地待发'); offline = false;
  await call({ type: 'SAVE_SETTINGS', settings: { ...settings, siyuan: { ...settings.siyuan, notebookId: otherNotebook } } });
  await call({ type: 'FLUSH' }); assert.equal(writes, 7);
  await call({ type: 'SAVE_SETTINGS', settings }); await call({ type: 'FLUSH' }); assert.equal(writes, 8);
  // Deleted remote card is paused until explicitly recreated.
  const cardId = [...documents].find(([, doc]) => doc === card)[0]; documents.delete(cardId);
  await saveNote('目标删除后的修改');
  assert.match((await call({ type: 'STATUS' })).syncError, /已删除/); assert.equal(writes, 8);
  await call({ type: 'SIYUAN_RECREATE' });
  assert.equal(writes, 9); assert.equal((await call({ type: 'STATUS' })).pending.length, 0);
  // Cancel queued local deletions without removing anything remotely.
  offline = true; await saveNote('删除前未发送的草稿');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '移除本页记录', exact: true }).click();
  await page.getByText('你的摘录与想法会出现在这里。', { exact: false }).waitFor();
  offline = false; await call({ type: 'FLUSH' }); assert.equal(writes, 9);
  // A new highlight is a separate card, including highlights with no personal note.
  await page.getByRole('button', { name: '关闭侧边栏', exact: true }).click();
  await page.locator('#quote').evaluate(node => {
    const range = document.createRange(); range.selectNodeContents(node);
    window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
    node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.getByRole('button', { name: '黄色划线', exact: true }).click();
  await page.waitForFunction(() => CSS.highlights.get('noting-yellow')?.size === 1);
  await call({ type: 'FLUSH' }); assert.equal(writes, 10);
  assert.ok([...documents.values()].some(doc => doc.markdown.includes('值得保留的原文摘录。')));
  unsupported = true;
  const rejected = await options.evaluate(settings => chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings }),
    { ...settings, siyuan: { ...settings.siyuan, notebookId: otherNotebook } });
  assert.equal(rejected.ok, false); assert.match(rejected.error, /不支持/); assert.equal(writes, 10);
  unsupported = false;
  await mkdir('test-results', { recursive: true });
  await options.reload(); await options.waitForFunction(() => document.querySelector('#output-target').value === 'siyuan');
  await options.screenshot({ path: 'test-results/siyuan-settings.png', fullPage: true });
  console.log('PASS 思源设置、真实侧栏、去重、追加保留补写、丢响应核对、离线重启、并发编辑、目的地隔离、删除恢复、Token 隔离');
} catch (error) {
  console.error('Fetch diagnosis:', await worker.evaluate(async url => { try { return {ok: (await fetch(url + '/api/system/version', {method:'POST'})).status}; } catch(e) { return String(e); } }, baseUrl));
  console.error('UI notice:', await options?.locator('#notice').textContent().catch(() => ''), 'calls:', calls.slice(-5));
  throw error;
} finally {
  await context?.close();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
