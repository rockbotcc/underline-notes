import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { exposeExtensionUI } from './extension-ui.mjs';

const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end('<html><title>Security fixture</title><body><p id="quote">A harmless article.</p></body></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const profile = await mkdtemp(path.join(tmpdir(), 'noting-security-'));
let context;
try {
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${path.resolve('dist')}`, `--load-extension=${path.resolve('dist')}`] });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const options = await context.newPage();
  await options.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);
  const call = async message => {
    const result = await options.evaluate(message => chrome.runtime.sendMessage(message), message);
    assert.equal(result.ok, true, result.error); return result.data;
  };
  const page = await context.newPage();
  // A website patch must not intercept shadow creation in the extension's isolated world.
  await page.addInitScript(() => {
    window.capturedRoots = [];
    const attachShadow = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (options) {
      const root = attachShadow.call(this, options);
      window.capturedRoots.push(root);
      return root;
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/article`);
  await exposeExtensionUI(page);
  const toggle = () => worker.evaluate(async () => {
    const tab = (await chrome.tabs.query({})).find(tab => tab.url?.endsWith('/article'));
    await chrome.tabs.sendMessage(tab.id, { type: 'NOTING_TOGGLE' });
  });
  await toggle();
  await page.getByRole('button', { name: '编辑文章笔记', exact: true }).click();
  const input = page.getByRole('textbox', { name: '文章笔记', exact: true });
  await input.fill('PRIVATE_NOTE');
  await input.press('Control+Enter');
  await page.getByText('PRIVATE_NOTE', { exact: true }).waitFor();
  assert.equal((await call({ type: 'BACKUP' })).articles[0].pageNote, 'PRIVATE_NOTE');

  // Reload removes the test-only DOM accessor. Exercise the original attack in the main world.
  await page.reload();
  await page.locator('#noting-extension').waitFor({ state: 'attached' });
  await toggle();
  const attack = await page.evaluate(() => {
    const host = document.querySelector('#noting-extension');
    const root = host.shadowRoot;
    if (root) {
      root.querySelector('[aria-label="查看本页笔记"]').click();
      root.querySelector('[aria-label="编辑文章笔记"]').click();
      root.querySelector('textarea.page-note').value = 'FORGED';
      root.querySelector('.save-page').click();
    }
    return { rootAccessible: !!root, rootIntercepted: window.capturedRoots.some(root => root.host === host), noteExposed: document.documentElement.textContent.includes('PRIVATE_NOTE'),
      inputExposed: !!document.querySelector('textarea.page-note') };
  });
  assert.deepEqual(attack, { rootAccessible: false, rootIntercepted: false, noteExposed: false, inputExposed: false });
  assert.equal((await call({ type: 'BACKUP' })).articles[0].pageNote, 'PRIVATE_NOTE');
  console.log('PASS website cannot read private notes or replay the DOM overwrite attack');

  // Defense in depth: use privileged test access to deliver synthetic events directly.
  await exposeExtensionUI(page);
  const edit = page.getByRole('button', { name: '编辑文章笔记', exact: true });
  await edit.evaluate(node => node.click());
  assert.equal(await input.count(), 0);
  await page.locator('.page-note-content .note-text').dispatchEvent('dblclick');
  assert.equal(await input.count(), 0);
  await edit.click();
  await input.fill('UNSAVED_DRAFT');
  await page.getByRole('button', { name: '保存文章笔记', exact: true }).evaluate(node => node.click());
  for (const modifier of ['ctrlKey', 'metaKey']) {
    await input.dispatchEvent('keydown', { key: 'Enter', [modifier]: true, bubbles: true, composed: true });
  }
  await input.dispatchEvent('keydown', { key: 'Escape', bubbles: true, composed: true });
  assert.ok(await input.isVisible());
  assert.equal((await call({ type: 'BACKUP' })).articles[0].pageNote, 'PRIVATE_NOTE');
  await input.press('Meta+Enter');
  await page.getByText('UNSAVED_DRAFT', { exact: true }).waitFor();
  assert.equal((await call({ type: 'BACKUP' })).articles[0].pageNote, 'UNSAVED_DRAFT');
  await page.getByRole('button', { name: '移除本页记录', exact: true }).evaluate(node => node.click());
  assert.equal((await call({ type: 'BACKUP' })).articles[0].deletedAt, undefined);
  console.log('PASS synthetic edit/save/delete/keyboard events blocked; real Ctrl/Meta+Enter preserved');
} finally {
  await context?.close(); await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
