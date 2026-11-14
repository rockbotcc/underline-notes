// Capture the real packaged extension with disposable, authored sample content.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const output = path.resolve('output/playwright/store');
await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(tmpdir(), 'underline-store-'));
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>把读过的文字，变成自己的思考</title><style>body{margin:64px 480px 60px 80px;background:#faf9f5;color:#30372e;font:18px/2 system-ui}h1{font-size:34px;line-height:1.5}small{color:#758366;letter-spacing:2px}p{margin:25px 0}</style><article><small>READING NOTES · 阅读与思考</small><h1>把读过的文字，<br>变成自己的思考</h1><p>读书时，我们常常遇到值得停留的句子。记录它们，是为了日后重新遇见当时的想法。</p><p id="quote">好的笔记不只是保存原文，也留下我们为什么被这句话打动。</p><p>给重要的一句话划线，再写下一点自己的理解。下次回到文章时，阅读便有了可以继续的起点。</p><p>把摘录与批注带回自己的笔记库，让零散的想法逐渐产生联系。</p><p>这是用于展示划线笔记功能的原创示例文章。</p></article></html>`;
const server = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let context;
try {
 context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, args: [`--disable-extensions-except=${path.resolve('dist')}`, `--load-extension=${path.resolve('dist')}`] });
 const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
 const id = new URL(worker.url()).host;
 const page = await context.newPage();
 await page.goto(`http://127.0.0.1:${server.address().port}/reading`);
 await page.locator('#noting-extension').waitFor({ state: 'attached' });
 await page.locator('#quote').evaluate(node => { const range = document.createRange(); range.selectNodeContents(node); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); });
 await page.getByRole('button', { name: '记笔记', exact: true }).click();
 await page.getByRole('textbox', { name: '划线笔记', exact: true }).fill('回顾时先问自己：这句话与我的哪段经验有关？\n让摘录成为思考的起点。');
 await page.getByRole('button', { name: '保存', exact: true }).click();
 await page.waitForFunction(() => CSS.highlights.get('noting-yellow')?.size === 1);
 await worker.evaluate(async () => { const tab = (await chrome.tabs.query({})).find(tab => tab.url?.includes('/reading')); await chrome.tabs.sendMessage(tab.id, { type: 'NOTING_TOGGLE' }); });
 await page.locator('.panel').waitFor({ state: 'visible' });
 await page.mouse.move(10, 10);
 await page.screenshot({ path: path.join(output, '01-article.png') });
 const settings = await context.newPage();
 await settings.goto(`chrome-extension://${id}/options.html`);
 await settings.locator('#extension-version').filter({ hasText: /^v\d/ }).waitFor();
 await settings.screenshot({ path: path.join(output, '02-settings.png') });
 await settings.locator('#reading').scrollIntoViewIfNeeded();
 await settings.screenshot({ path: path.join(output, '03-reading-privacy.png') });
 for (const name of ['01-article.png', '02-settings.png', '03-reading-privacy.png']) await copyFile(path.join(output, name), path.resolve('store/chrome', name));
 console.log('Captured 3 real extension screenshots at 1280 × 800');
} finally { await context?.close(); await new Promise(resolve => server.close(resolve)); await rm(profile, { recursive: true, force: true }); }
