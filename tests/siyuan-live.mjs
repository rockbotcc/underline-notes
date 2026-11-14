import { exposeExtensionUI } from './extension-ui.mjs';
// Starts only an isolated kernel owned by this test. Never targets a user's running instance.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { SiyuanClient } from '../browser/src/siyuan-api.ts';

const executable = process.env.SIYUAN_TEST_KERNEL;
assert.ok(executable, 'Set SIYUAN_TEST_KERNEL to the official SiYuan-Kernel executable');
const root = await mkdtemp(path.join(tmpdir(), 'noting-siyuan-live-'));
const workspace = path.join(root, 'workspace');
const home = path.join(root, 'home');
await mkdir(workspace); await mkdir(home);
const reservation = createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
const baseUrl = `http://127.0.0.1:${port}`;
const log = await open(path.join(root, 'kernel.log'), 'a');
const password = randomUUID();
let kernel, token, context, options, worker;
const articleServer = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end('<title>思源真实内核 C/C++ 测试</title><article><h1>划线笔记联调</h1><p id="quote">值得保留的原文摘录。</p><p>' + '阅读与思考。'.repeat(300) + '</p></article>');
});
await new Promise(resolve => articleServer.listen(0, '127.0.0.1', resolve));
async function api(endpoint, body = {}) {
  const response = await fetch(baseUrl + '/api/' + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Token ' + token }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 200, endpoint);
  const result = await response.json(); assert.equal(result.code, 0, endpoint + ': ' + result.msg);
  return result.data;
}
async function startKernel() {
  kernel = spawn(executable, ['serve', '--home-dir', home, '--workspace', workspace, '--wd', process.env.SIYUAN_TEST_RESOURCES || path.dirname(path.dirname(executable)),
    '--port', String(port), '--fixed-port=false', '--accessAuthCode', password, '--lang', 'zh-CN'], { stdio: ['ignore', log.fd, log.fd] });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (kernel.exitCode !== null) throw new Error(`Isolated kernel exited: ${kernel.exitCode}; log: ${root}/kernel.log`);
    try {
      const conf = JSON.parse(await readFile(path.join(workspace, 'conf', 'conf.json'), 'utf8'));
      token = conf.api.token;
      if (await api('system/version')) return;
    } catch { /* Wait for the fresh workspace to finish initialization. */ }
    await delay(300);
  }
  throw new Error('Isolated kernel did not become ready; log: ' + root + '/kernel.log');
}
async function stopKernel() {
  if (!kernel || kernel.exitCode !== null) return;
  const stopped = new Promise(resolve => kernel.once('exit', resolve));
  kernel.kill('SIGTERM');
  await Promise.race([stopped, delay(8000).then(() => { if (kernel.exitCode === null) kernel.kill('SIGKILL'); })]);
}
async function call(message) {
  const result = await options.evaluate(message => chrome.runtime.sendMessage(message), message);
  assert.equal(result.ok, true, result.error); return result.data;
}
let completed = false;
try {
  await startKernel();
  const version = await api('system/version');
  console.log('Live kernel version:', version);
  const created = await api('notebook/createNotebook', { name: '划线笔记隔离验收' });
  const notebookId = created.notebook.id;
  const client = new SiyuanClient({ baseUrl, apiToken: token });
  await client.checkNotebook(notebookId);
  context = await chromium.launchPersistentContext(path.join(root, 'chrome'), { channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${path.resolve('dist')}`, `--load-extension=${path.resolve('dist')}`] });
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  options = await context.newPage(); await options.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);
  const settings = (await call({ type: 'STATUS' })).settings;
  await call({ type: 'SIYUAN_TEST', baseUrl, apiToken: token });
  await call({ type: 'SAVE_SETTINGS', settings: { ...settings, recordHistory: false, outputTarget: 'siyuan', siyuan: { baseUrl, apiToken: token, notebookId } } });
  const page = await context.newPage(); await page.goto(`http://127.0.0.1:${articleServer.address().port}/article`);
  await exposeExtensionUI(page);
  await worker.evaluate(async () => {
    const tab = (await chrome.tabs.query({})).find(tab => tab.url?.includes('/article'));
    await chrome.tabs.sendMessage(tab.id, { type: 'NOTING_TOGGLE' });
  });
  async function save(note, flush = true) {
    await page.getByRole('button', { name: '编辑文章笔记', exact: true }).click();
    await page.getByRole('textbox', { name: '文章笔记', exact: true }).fill(note);
    await page.getByRole('button', { name: '保存文章笔记', exact: true }).click();
    await page.getByRole('textbox', { name: '文章笔记', exact: true }).waitFor({ state: 'hidden' });
    if (flush) await call({ type: 'FLUSH' });
  }
  async function flushSuccess() {
    await call({ type: 'FLUSH' });
    const status = await call({ type: 'STATUS' });
    assert.equal(status.syncError, undefined, status.syncError);
    assert.equal(status.pending.length, 0);
  }
  async function bindings() {
    return options.evaluate(async () => {
      const db = await new Promise(resolve => { const r = indexedDB.open('noting'); r.onsuccess = () => resolve(r.result); });
      const values = await new Promise(resolve => { const r = db.transaction('siyuanBindings').objectStore('siyuanBindings').getAll(); r.onsuccess = () => resolve(r.result); });
      db.close(); return values;
    });
  }
  await save('第一版 **重点**\n\n- 中文列表\n- 第二项'); await flushSuccess();
  const card = (await bindings()).find(item => !item.key.startsWith('root:'));
  assert.ok(card?.confirmed);
  let markdown = await client.markdown(card.docId);
  assert.ok(markdown.includes('第一版')); assert.ok(markdown.includes('custom-underline-hash'));
  assert.equal((markdown.match(/custom-underline-hash=/g) || []).length, 1);
  await api('block/appendBlock', { parentID: card.docId, dataType: 'markdown', data: '思源中手动补写，必须保留。' });
  await save('第二版内容'); await flushSuccess();
  markdown = await client.markdown(card.docId);
  assert.ok(markdown.includes('思源中手动补写')); assert.ok(markdown.includes('第一版')); assert.ok(markdown.includes('第二版'));
  assert.equal((markdown.match(/custom-underline-hash=/g) || []).length, 2);
  await save('第二版内容'); await flushSuccess();
  assert.equal((await client.markdown(card.docId)).match(/custom-underline-hash=/g).length, 2);
  // Lose an actual successful kernel response, then reconcile its persistent block ID.
  await worker.evaluate(() => {
    const nativeFetch = fetch; let lost = false;
    globalThis.fetch = async (url, init) => {
      const response = await nativeFetch(url, init);
      if (!lost && String(url).endsWith('/api/block/appendBlock')) { lost = true; await response.text(); throw new TypeError('Simulated response loss after real commit'); }
      return response;
    };
  });
  await save('真实内核响应丢失测试'); await flushSuccess();
  assert.equal((await client.markdown(card.docId)).match(/custom-underline-hash=/g).length, 3);
  await stopKernel();
  await save('离线保存并等待内核重启');
  assert.equal((await call({ type: 'STATUS' })).pending.length, 1);
  await startKernel(); await flushSuccess();
  assert.ok((await client.markdown(card.docId)).includes('离线保存并等待内核重启'));
  assert.equal((await client.markdown(card.docId)).match(/custom-underline-hash=/g).length, 4);
  // Native deletion must pause, and an explicit recovery creates a new document.
  const location = await api('filetree/getPathByID', { id: card.docId });
  await api('filetree/removeDoc', { notebook: notebookId, path: location.path });
  await save('删除后的新版本');
  assert.match((await call({ type: 'STATUS' })).syncError, /已删除/);
  await call({ type: 'SIYUAN_RECREATE' }); await flushSuccess();
  const recovered = (await bindings()).find(item => item.key === card.key);
  assert.notEqual(recovered.docId, card.docId);
  assert.ok((await client.markdown(recovered.docId)).includes('删除后的新版本'));
  await mkdir('test-results', { recursive: true });
  await options.reload(); await options.waitForFunction(() => document.querySelector('#output-target').value === 'siyuan');
  await options.screenshot({ path: 'test-results/siyuan-live-settings.png', fullPage: true });
  await writeFile('test-results/siyuan-live-result.json', JSON.stringify({ version, testedAt: new Date().toISOString(), checks: ['create', 'native-markdown-ids', 'append-preserves-user-content', 'unchanged-dedup', 'lost-response', 'kernel-restart', 'deleted-target-recovery'], passed: true }, null, 2));
  console.log('PASS 真实思源内核：创建、Markdown/块 ID、追加保留补写、去重、响应丢失核对、内核重启、删除恢复');
  completed = true;
} finally {
  await context?.close(); await stopKernel(); await log.close();
  articleServer.closeAllConnections(); await new Promise(resolve => articleServer.close(resolve));
  if (completed) await rm(root, { recursive: true, force: true });
  else console.error('Isolated failure artifacts:', root);
}
