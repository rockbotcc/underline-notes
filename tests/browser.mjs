import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const output = path.resolve('test-results');
await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(tmpdir(), 'noting-chrome-'));
const paragraph = '阅读让我们有机会理解不同的想法。当我们记录一句话时，也是在记录自己此刻的思考。真正有价值的笔记会连接已有经验，并在下一次实践中得到验证。我们可以通过不断阅读、思考和回顾，建立属于自己的知识体系。'.repeat(4);
const html = `<!doctype html><html><head><meta charset="utf-8"><title>阅读，把想法留给未来</title><style>body{margin:70px auto;max-width:760px;font:18px/2 Georgia,serif;color:#30372e;background:#fcfcf7}h1{font:38px/1.5 system-ui}p{margin:25px 0}small{color:#8b927e}article{padding:0 30px}</style></head><body><article><small>ESSAYS / 随读随记</small><h1>阅读，把想法留给未来</h1><p id="quote">好的抽象来自对变化的理解。把读过的文字，变成自己的思考。</p><p id="cross">阅读的价值，<strong>也在于连接</strong>不同的想法。</p>${Array.from({ length: 5 }, () => `<p>${paragraph}</p>`).join('')}</article></body></html>`;
const server = createServer((request, response) => { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(html); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/article`;
let context;
const errors = [];

async function launch() {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
    channel: process.env.CHROMIUM_EXECUTABLE ? undefined : 'chromium',
    headless: !process.env.NOTING_NATIVE_PICKER,
    args: [`--disable-extensions-except=${path.resolve('dist')}`, `--load-extension=${path.resolve('dist')}`],
    viewport: { width: 1340, height: 1050 },
  });
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  return { worker, id };
}

async function call(page, message) {
  const response = await page.evaluate(message => chrome.runtime.sendMessage(message), message);
  assert.equal(response.ok, true, response.error);
  return response.data;
}

async function select(page, selector) {
  await page.locator(selector).evaluate(node => {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(node);
    selection.removeAllRanges();
    selection.addRange(range);
    node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.getByRole('toolbar', { name: '划线工具', exact: true }).waitFor({ state: 'visible' });
}

async function vaultFiles(page, edit) {
  return page.evaluate(async edit => {
    const root = await new Promise((resolve, reject) => {
      const request = indexedDB.open('noting');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const read = request.result.transaction('meta').objectStore('meta').get('directory');
        read.onsuccess = () => { resolve(read.result); request.result.close(); };
      };
    });
    if (edit) {
      const parts = edit.path.split('/');
      const name = parts.pop();
      let directory = root;
      for (const part of parts) directory = await directory.getDirectoryHandle(part);
      const writable = await (await directory.getFileHandle(name)).createWritable();
      await writable.write(edit.text);
      await writable.close();
    }
    const files = {};
    async function walk(directory, prefix = '') {
      for await (const [name, handle] of directory.entries()) {
        if (handle.kind === 'directory') await walk(handle, prefix + name + '/');
        else files[prefix + name] = await (await handle.getFile()).text();
      }
    }
    await walk(root);
    return files;
  }, edit);
}

function editNote(markdown, note) {
  return markdown.replace(/(<!-- noting:note:start -->\n## 我的批注\n\n)[\s\S]*?(\n<!-- noting:note:end -->)/, (_, start, end) => start + note + end);
}

async function waitForPageNote(options, note) {
  await options.waitForFunction(async expected => {
    const db = await new Promise(resolve => { const request = indexedDB.open('noting'); request.onsuccess = () => resolve(request.result); });
    const articles = await new Promise(resolve => { const request = db.transaction('articles').objectStore('articles').getAll(); request.onsuccess = () => resolve(request.result); });
    db.close();
    return articles[0]?.pageNote === expected;
  }, note);
}

try {
  let { worker, id } = await launch();
  const options = await context.newPage();
  await options.goto(`chrome-extension://${id}/options.html`);
  await options.locator('#choose-directory').waitFor();
  if (process.env.NOTING_NATIVE_PICKER) {
    console.log('NATIVE_PICKER_READY 请在系统弹窗选择测试仓库');
    await options.getByRole('button', { name: '选择笔记文件夹', exact: true }).click();
    await options.getByText('文件夹已连接', { exact: true }).waitFor({ timeout: 600000 });
    console.log('PASS 原生文件夹选择与授权');
  }
  const page = await context.newPage();
  await page.goto(url);
  await page.locator('#noting-extension').waitFor({ state: 'attached' });
  // Await initialization through the worker before exercising page interaction.
  await call(options, { type: 'STATUS' });
  await select(page, '#quote');
  await page.getByRole('button', { name: '黄色划线', exact: true }).click();
  await page.waitForFunction(() => CSS.highlights.get('noting-yellow')?.size === 1);
  console.log('PASS 选区浮动工具条与持久化划线');

  await worker.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find(tab => tab.url?.includes('/article'));
    await chrome.tabs.sendMessage(tab.id, { type: 'NOTING_TOGGLE' });
  });
  await page.getByRole('button', { name: '添加笔记', exact: true }).click();
  const highlightNote = page.getByRole('textbox', { name: '划线笔记', exact: true });
  const highlightEditor = page.getByRole('dialog', { name: '编辑划线笔记', exact: true });
  await highlightNote.click();
  assert.ok(await highlightNote.isVisible(), '点击弹窗内部不能关闭弹窗');
  assert.ok(await page.locator('.panel').isVisible(), '点击编辑器不能关闭笔记侧栏');
  await page.mouse.click(20, 20);
  await highlightNote.waitFor({ state: 'hidden' });
  await page.locator('.panel').waitFor({ state: 'hidden' });
  await worker.evaluate(async () => {
    const tab = (await chrome.tabs.query({})).find(tab => tab.url?.includes('/article'));
    await chrome.tabs.sendMessage(tab.id, { type: 'NOTING_TOGGLE' });
  });
  await page.getByRole('button', { name: '添加笔记', exact: true }).click();
  await highlightNote.fill('尚未保存的草稿');
  page.once('dialog', dialog => dialog.dismiss());
  await page.mouse.click(20, 20);
  assert.ok(await highlightNote.isVisible(), '取消放弃修改时应保留弹窗');
  assert.equal(await highlightNote.inputValue(), '尚未保存的草稿');
  page.once('dialog', dialog => dialog.accept());
  await page.mouse.click(20, 20);
  await highlightNote.waitFor({ state: 'hidden' });
  await page.locator('.panel').waitFor({ state: 'hidden' });
  await worker.evaluate(async () => {
    const tab = (await chrome.tabs.query({})).find(tab => tab.url?.includes('/article'));
    await chrome.tabs.sendMessage(tab.id, { type: 'NOTING_TOGGLE' });
  });
  await page.getByRole('button', { name: '添加笔记', exact: true }).click();
  console.log('PASS 点击笔记外部关闭、内部交互与未保存修改保护');
  assert.equal(await highlightEditor.locator('blockquote').count(), 0, '划线笔记弹窗不显示引用正文');
  assert.equal(await highlightEditor.locator('.note-hint').count(), 0, '复述提示仅显示在输入框占位符中');
  assert.equal(await highlightNote.getAttribute('placeholder'), '可以先用自己的话复述原文，再补充理解或评论。支持 Markdown。');
  await page.screenshot({ path: path.join(output, 'note-hint-empty.png') });
  await highlightNote.fill('这句话可以用在设计评审中。');
  await page.screenshot({ path: path.join(output, 'note-hint-filled.png') });
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.locator('.card .note').filter({ hasText: '这句话可以用在设计评审中。' }).waitFor();
  assert.equal(await page.locator('.panel textarea').count(), 0, '阅读笔记时不应显示输入框');
  const annotationText = page.locator('.card .note .note-text').first();
  await annotationText.dblclick();
  assert.equal(await highlightNote.inputValue(), '这句话可以用在设计评审中。');
  const longAnnotation = Array.from({ length: 24 }, (_, index) => `第 ${index + 1} 条理解：长笔记应完整展开，并保留换行。`).join('\n') + '\n' + 'longword'.repeat(80);
  await highlightNote.fill(longAnnotation);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await annotationText.filter({ hasText: longAnnotation }).waitFor();
  assert.ok(await annotationText.evaluate(node => node.clientHeight >= node.scrollHeight && node.clientWidth >= node.scrollWidth), '长批注应完整展开且长单词不溢出');
  await page.locator('.card').first().getByRole('button', { name: '编辑笔记', exact: true }).click();
  await highlightNote.fill('这句话可以用在设计评审中。');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  if (!process.env.NOTING_NATIVE_PICKER) await page.locator('.output-status').filter({ hasText: '连接笔记文件夹后可自动写入' }).waitFor();
  await page.getByRole('button', { name: '编辑文章笔记', exact: true }).click();
  const pageNote = page.getByRole('textbox', { name: '文章笔记', exact: true });
  const pageHint = page.locator('#page-note-hint');
  await pageHint.waitFor({ state: 'visible' });
  assert.match(await pageHint.textContent(), /复述文章的要点/);
  assert.equal(await pageNote.getAttribute('aria-describedby'), 'page-note-hint');
  await pageNote.fill('**待实践**：整理模块边界。');
  await pageNote.click();
  assert.ok(await page.locator('.panel').isVisible(), '点击文章笔记内部不能关闭侧栏');
  await page.mouse.click(20, 20);
  await page.locator('.panel').waitFor({ state: 'hidden' });
  await worker.evaluate(async () => {
    const tab = (await chrome.tabs.query({})).find(tab => tab.url?.includes('/article'));
    await chrome.tabs.sendMessage(tab.id, { type: 'NOTING_TOGGLE' });
  });
  await pageNote.waitFor({ state: 'visible' });
  assert.equal(await pageNote.inputValue(), '**待实践**：整理模块边界。', '外部点击关闭侧栏后应保留文章草稿');
  console.log('PASS 侧栏外部关闭与文章草稿保留');
  assert.ok(await pageHint.isVisible(), '输入文章笔记后复述提示仍应可见');
  await page.screenshot({ path: path.join(output, 'page-note-hint-filled.png') });
  console.log('PASS 划线笔记占位提示、简化弹窗与文章笔记提示');
  await page.getByRole('button', { name: '保存文章笔记', exact: true }).click();
  const pageNoteText = page.locator('.page-note-content .note-text');
  await pageNoteText.filter({ hasText: '**待实践**：整理模块边界。' }).waitFor();
  assert.equal(await page.locator('.panel textarea').count(), 0, '保存文章笔记后应回到阅读状态');
  await pageNoteText.dblclick();
  const longPageNote = Array.from({ length: 32 }, (_, index) => `第 ${index + 1} 段文章笔记：完整展示，不在文本框内滚动。`).join('\n');
  await pageNote.fill(longPageNote);
  await page.getByRole('button', { name: '保存文章笔记', exact: true }).click();
  await pageNoteText.filter({ hasText: longPageNote }).waitFor();
  assert.equal(await pageNoteText.textContent(), longPageNote);
  assert.ok(await pageNoteText.evaluate(node => node.clientHeight >= node.scrollHeight && node.clientHeight > 600), '长文章笔记应按全文自然撑高');
  await page.screenshot({ path: path.join(output, 'page-note-expanded.png') });
  await page.getByRole('button', { name: '编辑文章笔记', exact: true }).click();
  await pageNote.fill('取消时保留已保存的内容');
  page.once('dialog', dialog => dialog.accept());
  await page.locator('.page-note-actions').getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await pageNoteText.textContent(), longPageNote);
  await pageNoteText.dblclick();
  await pageNote.fill('**待实践**：整理模块边界。');
  await pageNote.press('Control+Enter');
  await pageNote.waitFor({ state: 'hidden' });
  console.log('PASS 默认文本阅读、长笔记完整展开、双击与铅笔编辑、取消和快捷保存');
  await page.getByRole('button', { name: '关闭侧边栏', exact: true }).click();
  await page.locator('#quote').click({ position: { x: 25, y: 15 } });
  const noteViewer = page.getByRole('dialog', { name: '查看划线笔记', exact: true });
  await noteViewer.waitFor();
  assert.equal(await noteViewer.locator('textarea').count(), 0, '点击高亮先阅读笔记');
  await noteViewer.locator('.note-text').dblclick();
  await highlightEditor.waitFor();
  await page.getByRole('button', { name: '关闭笔记编辑器', exact: true }).click();
  await select(page, '#cross');
  await page.getByRole('button', { name: '记笔记', exact: true }).click();
  await page.getByRole('textbox', { name: '划线笔记', exact: true }).fill('跨文本节点也应完整恢复。');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.waitForFunction(() => CSS.highlights.get('noting-yellow')?.size === 2);
  await page.reload();
  await page.waitForFunction(() => CSS.highlights.get('noting-yellow')?.size === 2);
  console.log('PASS 划线批注、文章笔记、跨节点选区、刷新恢复');

  await page.locator('article').evaluate(node => { const paragraph = document.createElement('p'); paragraph.textContent = '页面新增了一段导语。'; node.prepend(paragraph); });
  await page.waitForFunction(() => CSS.highlights.get('noting-yellow')?.size === 2);
  await page.mouse.move(300, 320);
  await options.screenshot({ path: path.join(output, 'settings.png'), fullPage: true });
  await page.bringToFront();
  await page.waitForTimeout(16500);
  const backup = await call(options, { type: 'BACKUP' });
  assert.equal(backup.articles.length, 1);
  assert.equal(backup.articles[0].annotations.length, 2);
  assert.equal(backup.articles[0].pageNote, '**待实践**：整理模块边界。');
  assert.ok(backup.sessions.length >= 1, '自动阅读会话应在 15 秒后保存');
  console.log('PASS 自动阅读会话');

  // Use a real browser filesystem handle (OPFS) to test the writer without a native picker.
  if (!process.env.NOTING_NATIVE_PICKER) await options.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle('e2e-vault', { create: true });
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open('noting'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const tx = db.transaction('meta', 'readwrite');
    tx.objectStore('meta').put(directory, 'directory');
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = reject; });
    db.close();
  });
  await call(options, { type: 'FLUSH' });
  let status = await call(options, { type: 'STATUS' });
  assert.equal(status.pending.length, 0, status.syncError);
  const exported = await options.evaluate(async articleId => {
    const root = await new Promise((resolve, reject) => {
      const request = indexedDB.open('noting');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const read = request.result.transaction('meta').objectStore('meta').get('directory');
        read.onsuccess = () => { resolve(read.result); request.result.close(); };
      };
    });
    const articles = await root.getDirectoryHandle('Articles');
    const file = await articles.getFileHandle(articleId + '.md');
    return (await file.getFile()).text();
  }, backup.articles[0].id);
  assert.ok(exported.includes('![['));
  assert.ok(exported.includes('**也在于连接**'), '正文需保留加粗格式');
  assert.ok(exported.includes('## 保存的正文'));
  let files = await vaultFiles(options);
  const cardPaths = Object.keys(files).filter(file => file.startsWith('Cards/'));
  assert.equal(cardPaths.length, 3);
  const personalPath = cardPaths.find(file => files[file].includes('这句话可以用在设计评审中。'));
  assert.ok(personalPath);
  assert.ok(cardPaths.some(file => files[file].includes('**待实践**：整理模块边界。')));
  assert.equal((files['卡片盒.md'].match(/!\[\[/g) || []).length, 3);
  assert.ok(Object.entries(files).some(([file, text]) => file.startsWith('Daily/') && text.includes('![[')));
  assert.ok(backup.articles[0].bodyMarkdown);
  const thoughts = '\n我的新理解：先确认变化的方向，再抽象边界。关联 [[模块设计]]。\n';
  await vaultFiles(options, { path: personalPath, text: files[personalPath] + thoughts });
  const revision = structuredClone(backup);
  revision.articles[0].updatedAt = new Date().toISOString();
  revision.articles[0].annotations[0].note += '\n补充：下次评审时验证。';
  revision.articles[0].annotations[0].updatedAt = revision.articles[0].updatedAt;
  await call(options, { type: 'IMPORT', backup: revision });
  await call(options, { type: 'FLUSH' });
  files = await vaultFiles(options);
  assert.ok(files[personalPath].includes(thoughts));
  assert.ok(files[personalPath].includes('补充：下次评审时验证。'));
  assert.equal((await call(options, { type: 'STATUS' })).pending.length, 0);
  console.log('PASS 独立卡片、格式化正文、卡片嵌入与 Obsidian 补写保留');

  // The same Markdown edit is produced by Obsidian's Vault.process editor.
  const remoteNote = '**Obsidian 整理后** #架构 [[模块设计]]';
  await vaultFiles(options, { path: personalPath, text: editNote(files[personalPath], remoteNote) });
  await call(options, { type: 'FLUSH' });
  let synced = await call(options, { type: 'BACKUP' });
  const annotationId = synced.articles[0].annotations.find(item => item.note === remoteNote)?.id;
  assert.ok(annotationId, 'Obsidian 修改必须回流浏览器');
  await worker.evaluate(async () => {
    const tab = (await chrome.tabs.query({})).find(tab => tab.url?.includes('/article'));
    await chrome.tabs.sendMessage(tab.id, { type: 'NOTING_TOGGLE' });
  });
  const sharedCard = page.locator(`.card[data-annotation-id="${annotationId}"]`);
  await sharedCard.locator('.note').filter({ hasText: remoteNote }).waitFor();
  await sharedCard.getByRole('button', { name: '编辑笔记', exact: true }).click();
  await highlightNote.fill('浏览器草稿不得覆盖新版本');
  files = await vaultFiles(options);
  await vaultFiles(options, { path: personalPath, text: editNote(files[personalPath], remoteNote + '\n再次整理') });
  await call(options, { type: 'FLUSH' });
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByText('笔记已有新版本。你的输入已保留，请复制后重新打开笔记，合并后再保存。', { exact: true }).waitFor();
  assert.equal(await highlightNote.inputValue(), '浏览器草稿不得覆盖新版本');
  assert.equal((await call(options, { type: 'BACKUP' })).articles[0].annotations.find(item => item.id === annotationId).note, remoteNote + '\n再次整理');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '关闭笔记编辑器', exact: true }).click();
  await sharedCard.getByRole('button', { name: '编辑笔记', exact: true }).click();
  const browserNote = '浏览器继续整理 #双向';
  await highlightNote.fill(browserNote);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('textbox', { name: '划线笔记', exact: true }).waitFor({ state: 'hidden' });
  await call(options, { type: 'FLUSH' });
  files = await vaultFiles(options);
  assert.ok(files[personalPath].includes(browserNote));
  assert.ok(files[personalPath].includes(thoughts));
  console.log('PASS Obsidian → 浏览器即时展示 → Obsidian 往返，以及旧草稿防覆盖');

  const pageCardPath = Object.keys(files).find(file => file.startsWith('Cards/') && file.endsWith('--' + backup.articles[0].id + '-note.md'));
  await vaultFiles(options, { path: pageCardPath, text: editNote(files[pageCardPath], '') });
  await call(options, { type: 'FLUSH' });
  assert.equal((await call(options, { type: 'BACKUP' })).articles[0].pageNote, '');
  assert.ok((await vaultFiles(options))[pageCardPath], '清空文章笔记不能删除卡片');
  await page.getByRole('button', { name: '编辑文章笔记', exact: true }).click();
  await pageNote.waitFor();
  assert.equal(await pageNote.inputValue(), '');
  await pageNote.fill('清空后从浏览器重新写入');
  await page.getByRole('button', { name: '保存文章笔记', exact: true }).click();
  await waitForPageNote(options, '清空后从浏览器重新写入');
  await call(options, { type: 'FLUSH' });
  assert.ok((await vaultFiles(options))[pageCardPath].includes('清空后从浏览器重新写入'));
  console.log('PASS 文章笔记双向同步与清空后继续编辑');

  await page.getByRole('button', { name: '编辑文章笔记', exact: true }).click();
  await pageNote.fill('未保存的文章草稿');
  files = await vaultFiles(options);
  await vaultFiles(options, { path: pageCardPath, text: editNote(files[pageCardPath], 'Obsidian 的新文章笔记') });
  await call(options, { type: 'FLUSH' });
  await page.getByRole('button', { name: '载入最新文章笔记', exact: true }).waitFor();
  assert.equal(await pageNote.inputValue(), '未保存的文章草稿');
  await page.getByRole('button', { name: '保存文章笔记', exact: true }).click();
  await page.getByText('笔记已有新版本。你的输入已保留，请复制后重新打开笔记，合并后再保存。', { exact: true }).waitFor();
  assert.equal((await call(options, { type: 'BACKUP' })).articles[0].pageNote, 'Obsidian 的新文章笔记');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '载入最新文章笔记', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#noting-extension').shadowRoot.querySelector('.page-note')?.value === 'Obsidian 的新文章笔记');
  await pageNote.fill('文章笔记合并完成');
  await page.getByRole('button', { name: '保存文章笔记', exact: true }).click();
  await waitForPageNote(options, '文章笔记合并完成');
  await call(options, { type: 'FLUSH' });
  console.log('PASS 文章旧草稿保留、载入最新版本并合并');

  // Simulate divergent edits while disconnected, then reconnect both versions.
  await navigatorConflict();
  async function navigatorConflict() {
    files = await vaultFiles(options);
    const divergent = await call(options, { type: 'BACKUP' });
    divergent.articles[0].updatedAt = new Date(Date.now() + 1000).toISOString();
    divergent.articles[0].annotations.find(item => item.id === annotationId).note = '冲突：浏览器版本';
    await vaultFiles(options, { path: personalPath, text: editNote(files[personalPath], '冲突：Obsidian 版本') });
    await call(options, { type: 'IMPORT', backup: divergent });
    await call(options, { type: 'FLUSH' });
    const conflictStatus = await call(options, { type: 'STATUS' });
    assert.match(conflictStatus.syncError, /笔记同步冲突/);
    files = await vaultFiles(options);
    const copies = Object.keys(files).filter(file => file.startsWith('Conflicts/'));
    assert.equal(copies.length, 1);
    assert.ok(files[copies[0]].includes('冲突：浏览器版本'));
    assert.ok(files[copies[0]].includes('冲突：Obsidian 版本'));
    assert.ok(files[personalPath].includes('冲突：Obsidian 版本'));
    assert.equal((await call(options, { type: 'BACKUP' })).articles[0].annotations.find(item => item.id === annotationId).note, '冲突：浏览器版本');
    await call(options, { type: 'FLUSH' });
    assert.equal(Object.keys(await vaultFiles(options)).filter(file => file.startsWith('Conflicts/')).length, 1, '重试不能重复生成冲突副本');
    await vaultFiles(options, { path: personalPath, text: editNote(files[personalPath], '冲突：浏览器版本') });
    await call(options, { type: 'FLUSH' });
    assert.equal((await call(options, { type: 'STATUS' })).pending.length, 0);
    files = await vaultFiles(options);
  }
  console.log('PASS 双边冲突副本、幂等重试与手动合并恢复');
  await page.getByRole('button', { name: '关闭侧边栏', exact: true }).click();

  // Save actual browser output for inspecting Obsidian's native rendering.
  for (const [file, text] of Object.entries(files)) {
    const target = path.join(output, 'CardPreviewVault', 'Reading', file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, text);
  }

  const validCard = files[personalPath];
  await vaultFiles(options, { path: personalPath, text: validCard.replace('> [!quote] 摘录', '> [!quote] 外部修改') });
  await call(options, { type: 'REQUEUE' });
  await call(options, { type: 'FLUSH' });
  assert.ok((await call(options, { type: 'STATUS' })).pending.some(job => job.error?.includes('外部修改')));
  assert.ok((await vaultFiles(options))[personalPath].includes('外部修改'));
  await vaultFiles(options, { path: personalPath, text: validCard });
  await call(options, { type: 'REQUEUE' });
  await call(options, { type: 'FLUSH' });
  assert.equal((await call(options, { type: 'STATUS' })).pending.length, 0);
  console.log('PASS Markdown/JSON/每日日志输出与幂等重试');

  // Simulate the prior output version without any pending user edits.
  await options.evaluate(async () => {
    const db = await new Promise(resolve => { const request = indexedDB.open('noting'); request.onsuccess = () => resolve(request.result); });
    const tx = db.transaction(['meta', 'pending', 'files'], 'readwrite');
    tx.objectStore('meta').put(1, 'outputVersion');
    tx.objectStore('pending').clear();
    const records = tx.objectStore('files').getAll();
    records.onsuccess = () => {
      for (const record of records.result) { delete record.base; tx.objectStore('files').put(record); }
    };
    await new Promise(resolve => { tx.oncomplete = resolve; });
    db.close();
  });
  await call(options, { type: 'FLUSH' });
  assert.equal((await call(options, { type: 'STATUS' })).pending.length, 0);
  assert.ok((await vaultFiles(options))[personalPath].includes(thoughts));
  const migrated = await vaultFiles(options);
  await vaultFiles(options, { path: personalPath, text: editNote(migrated[personalPath], '旧哈希记录升级后可回流') });
  await call(options, { type: 'FLUSH' });
  assert.equal((await call(options, { type: 'BACKUP' })).articles[0].annotations.find(item => item.id === annotationId).note, '旧哈希记录升级后可回流');
  console.log('PASS 无待办旧资料升级与补写保留');

  await options.evaluate(async articleId => {
    const root = await new Promise((resolve, reject) => {
      const request = indexedDB.open('noting');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const read = request.result.transaction('meta').objectStore('meta').get('directory');
        read.onsuccess = () => { resolve(read.result); request.result.close(); };
      };
    });
    const file = await (await root.getDirectoryHandle('Articles')).getFileHandle(articleId + '.md');
    const writable = await file.createWritable();
    await writable.write('用户在外部修改的内容');
    await writable.close();
  }, backup.articles[0].id);
  await call(options, { type: 'REQUEUE' });
  await call(options, { type: 'FLUSH' });
  status = await call(options, { type: 'STATUS' });
  assert.ok(status.pending.some(job => job.error?.includes('外部修改')));
  console.log('PASS 外部文件冲突保留与待重试状态');

  await call(options, { type: 'IMPORT', backup });
  await call(options, { type: 'IMPORT', backup });
  assert.equal((await call(options, { type: 'BACKUP' })).articles[0].annotations.length, 2);
  const badBackup = structuredClone(backup);
  badBackup.articles[0].id = '../../outside';
  const rejected = await options.evaluate(backup => chrome.runtime.sendMessage({ type: 'IMPORT', backup }), badBackup);
  assert.equal(rejected.ok, false);
  assert.equal((await call(options, { type: 'BACKUP' })).articles.length, 1);
  console.log('PASS 合并恢复去重与非法备份原子拒绝');

  await worker.evaluate(async () => {
    const tab = (await chrome.tabs.query({})).find(tab => tab.url?.includes('/article'));
    await chrome.tabs.sendMessage(tab.id, { type: 'NOTING_TOGGLE' });
  });
  await page.locator('#noting-extension .panel').waitFor({ state: 'visible' });
  await page.screenshot({ path: path.join(output, 'article.png'), fullPage: false });
  await context.close();
  ({ worker, id } = await launch());
  const restored = await context.newPage();
  await restored.goto(url);
  await restored.waitForFunction(() => CSS.highlights.get('noting-yellow')?.size === 2);
  console.log('PASS 浏览器重启后恢复');
  const restoredOptions = await context.newPage();
  await restoredOptions.goto(`chrome-extension://${id}/options.html`);
  const restoredSettings = (await call(restoredOptions, { type: 'STATUS' })).settings;
  await call(restoredOptions, { type: 'SAVE_SETTINGS', settings: { ...restoredSettings, excludedDomains: ['127.0.0.1'] } });
  await restored.waitForFunction(() => !CSS.highlights.has('noting-yellow'));
  await call(restoredOptions, { type: 'SAVE_SETTINGS', settings: restoredSettings });
  await restored.waitForFunction(() => CSS.highlights.get('noting-yellow')?.size === 2);
  console.log('PASS 网站排除与重新启用');
  await worker.evaluate(async () => {
    const tab = (await chrome.tabs.query({})).find(tab => tab.url?.includes('/article'));
    await chrome.tabs.sendMessage(tab.id, { type: 'NOTING_TOGGLE' });
  });
  restored.once('dialog', dialog => dialog.accept());
  await restored.getByRole('button', { name: '移除本页记录', exact: true }).click();
  await restored.getByText('你的摘录与想法会出现在这里。', { exact: false }).waitFor();
  await call(restoredOptions, { type: 'IMPORT', backup });
  const afterDelete = await call(restoredOptions, { type: 'BACKUP' });
  assert.ok(afterDelete.articles[0].deletedAt);
  assert.equal(afterDelete.articles[0].annotations.length, 0);
  assert.equal(afterDelete.sessions.length, 0);
  await call(restoredOptions, { type: 'FLUSH' });
  const remainingCards = Object.entries(await vaultFiles(restoredOptions)).filter(([file]) => file.startsWith('Cards/'));
  assert.equal(remainingCards.length, 1, '删除原记录只保留有手写思考的卡片');
  assert.equal(remainingCards[0][0], personalPath);
  assert.ok(remainingCards[0][1].includes(thoughts));
  console.log('PASS 删除联动与旧备份防复活');
  assert.deepEqual(errors, [], '页面不得出现未捕获异常');
  console.log('ALL BROWSER TESTS PASSED');
} finally {
  await context?.close();
  await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
