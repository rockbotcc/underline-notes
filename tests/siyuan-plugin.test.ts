import assert from 'node:assert/strict';
import test from 'node:test';
import { collectCards, filterCards, hasThought, safeSource, thoughtMarkdown, ThoughtStore, type BlockRow, type Drafts, type Request } from '../siyuan/cards.ts';
const doc = '20261113090000-aaaaaaa';
const row = (id: string, markdown: string, name = 'custom-underline-hash'): BlockRow => ({ id, root_id: doc, title: '读书卡片', box: '20261113090000-bbbbbbb', markdown, name });
test('SiYuan plugin groups current version and thoughts; search excludes stale versions and parent tags include children', () => {
  const cards = collectCards([
    row('20261113130000-aaaaaaa', '### 更新 2026-11-13T09:00:00Z\n\n旧版 秘密'),
    row('20261113100000-aaaaaaa', '### 更新 2026-11-13T10:00:00Z\n\n新版 #阅读/技术\n来源：[a](<https://example.com/article>)'),
    row('20261113110000-aaaaaaa', thoughtMarkdown('自己的理解 #想法', '20261113110000-aaaaaaa', 'hash', '2026-11-13T11:00:00Z'), 'custom-underline-thought'),
  ]);
  assert.equal(cards.length, 1); assert.equal(cards[0].versionId, '20261113100000-aaaaaaa');
  assert.equal(cards[0].thoughts.length, 1); assert.equal(cards[0].source, 'https://example.com/article');
  assert.equal(filterCards(cards, '新版 理解', '阅读').length, 1);
  assert.equal(filterCards(cards, '秘密', '').length, 0);
  assert.equal(filterCards(cards, '', '', 'other').length, 0);
  assert.equal(filterCards(cards, '', '想法').length, 1);
  assert.equal(safeSource('来源：[a](<javascript:alert(1)>)'), '');
});
test('SiYuan thought isolates block-attribute and container injection', () => {
  const text = thoughtMarkdown('}}}\n{: id="20261113090000-bbbbbbb"}\n{{{row\n#标签', doc, 'hash', 'now');
  assert.equal((text.match(/^\}\}\}$/gm) || []).length, 1);
  assert.equal((text.match(/^\{:/gm) || []).length, 1);
  assert.ok(hasThought(text, { id: doc, hash: 'hash', markdown: text }));
});
test('SiYuan thought commits once after response loss and concurrent submit', async () => {
  let remote = '', appends = 0; const saved: Drafts[] = [];
  const request = (async (endpoint: string, body: Record<string, unknown>) => {
    if (endpoint.endsWith('getBlockKramdown')) return { kramdown: remote };
    appends++; assert.ok(saved.at(-1)?.[doc].attempt, 'identity persisted before mutation');
    remote += body.data; throw new Error('response lost');
  }) as Request;
  const store = new ThoughtStore({}, request, async drafts => { saved.push(structuredClone(drafts)); });
  await store.edit(doc, '补写想法');
  await Promise.all([store.submit(doc), store.submit(doc)]);
  assert.equal(appends, 1); assert.equal(store.drafts[doc], undefined);
});
test('SiYuan thought restart reuses uncertain attempt and preserves deleted target draft', async () => {
  let remote = '', offline = true, saved: Drafts = {}, appends = 0;
  const request = (async (endpoint: string, body: Record<string, unknown>) => {
    if (endpoint.endsWith('getBlockKramdown')) { if (offline) throw new Error('offline'); return { kramdown: remote }; }
    appends++; remote += body.data;
  }) as Request;
  const persist = async (drafts: Drafts) => { saved = structuredClone(drafts); };
  const store = new ThoughtStore({}, request, persist); await store.edit(doc, '不能丢失');
  await assert.rejects(store.submit(doc), /offline/); const id = saved[doc].attempt!.id;
  await assert.rejects(store.edit(doc, '覆盖'), /先重试/);
  const restarted = new ThoughtStore(saved, request, persist); offline = false;
  await restarted.submit(doc); assert.equal(appends, 1); assert.ok(remote.includes(id));
  await restarted.edit(doc, '文档已删除'); offline = true;
  await assert.rejects(restarted.submit(doc)); assert.equal(saved[doc].text, '文档已删除');
});
test('SiYuan never writes remote thoughts when durable draft save fails', async () => {
  let writes = 0;
  const store = new ThoughtStore({ [doc]: { text: 'draft' } }, (async () => { writes++; }) as Request, async () => { throw new Error('disk full'); });
  await assert.rejects(store.submit(doc), /disk full/); assert.equal(writes, 0); assert.equal(store.drafts[doc].text, 'draft');
});

test('SiYuan deletion resolves current document path and clears persisted draft after success', async () => {
  const calls: string[] = []; let persisted: Drafts = {};
  const request = (async (endpoint: string, body: Record<string, unknown>) => {
    calls.push(endpoint);
    if (endpoint.endsWith('/sql')) return [{ box: '20261113090000-bbbbbbb', path: `/20261113090000-ccccccc/${doc}.sy` }];
    if (endpoint.endsWith('/removeDoc')) assert.deepEqual(body, { notebook: '20261113090000-bbbbbbb', path: `/20261113090000-ccccccc/${doc}.sy` });
  }) as Request;
  const store = new ThoughtStore({ [doc]: { text: '草稿' } }, request, async drafts => { persisted = drafts; });
  await store.remove(doc);
  assert.deepEqual(calls, ['/api/sqlite/flushTransaction', '/api/query/sql', '/api/filetree/removeDoc']);
  assert.deepEqual(store.drafts, {}); assert.deepEqual(persisted, {});
});

test('SiYuan deletion failure preserves drafts and rejects invalid IDs before requests', async () => {
  let calls = 0;
  const request = (async (endpoint: string) => {
    calls++;
    if (endpoint.endsWith('/sql')) return [{ box: '20261113090000-bbbbbbb', path: `/${doc}.sy` }];
    if (endpoint.endsWith('/removeDoc')) throw new Error('离线');
  }) as Request;
  const store = new ThoughtStore({ [doc]: { text: '草稿' } }, request, async () => {});
  await assert.rejects(store.remove("bad'id"), /无效/); assert.equal(calls, 0);
  await assert.rejects(store.remove(doc), /离线/); assert.equal(store.drafts[doc].text, '草稿');
});

test('SiYuan deletion blocks concurrent saves and retries cleanup after the document is gone', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const request = (async (endpoint: string) => {
    if (endpoint.endsWith('/sql')) { await gate; return []; }
    assert.ok(!endpoint.endsWith('/removeDoc'));
  }) as Request;
  const store = new ThoughtStore({ [doc]: { text: '草稿' } }, request, async () => {});
  const deletion = store.remove(doc);
  await assert.rejects(store.submit(doc), /正在删除/);
  await assert.rejects(store.edit(doc, '新内容'), /正在删除/);
  await assert.rejects(store.remove(doc), /正在保存或删除/);
  release(); await deletion; assert.deepEqual(store.drafts, {});
});
