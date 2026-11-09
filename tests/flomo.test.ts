import test from 'node:test';
import assert from 'node:assert/strict';
import { checkedFlomoUrl, flomoContent, postFlomo } from '../browser/src/flomo-api.ts';
import { DEFAULT_SETTINGS } from '../shared/model.ts';

const endpoint = 'https://flomoapp.com/iwh/test/secret/';
test('default output stays local; accept only official credential URLs', () => {
  assert.equal(DEFAULT_SETTINGS.outputTarget, 'obsidian');
  assert.equal(checkedFlomoUrl('  ' + endpoint + '  '), endpoint);
  for (const value of ['http://flomoapp.com/iwh/test/secret/', 'https://flomoapp.com.evil.test/iwh/test/secret/', endpoint + '?secret=1', 'https://user:secret@flomoapp.com/iwh/test/secret/', 'https://flomoapp.com/', 'invalid']) {
    assert.throws(() => checkedFlomoUrl(value), /完整 HTTPS API URL/);
  }
});

test('send only content, omit credentials, reject redirects and require business success', async () => {
  await postFlomo(endpoint, '想法 #阅读', async (url, init) => {
    assert.equal(url, endpoint);
    assert.equal(init?.method, 'POST');
    assert.equal(init?.credentials, 'omit');
    assert.equal(init?.redirect, 'error');
    assert.deepEqual(JSON.parse(init?.body as string), { content: '想法 #阅读' });
    return Response.json({ code: 0 });
  });
  for (const response of [Response.json({ code: -1, message: endpoint }), Response.json({}), Response.json(null), new Response('bad json'), new Response('', { status: 429 })]) {
    await assert.rejects(postFlomo(endpoint, 'note', async () => response), error => {
      assert.ok(!(error as Error).message.includes('secret'));
      return true;
    });
  }
  await assert.rejects(postFlomo(endpoint, 'note', async () => { throw new Error(endpoint); }), /网络请求失败/);
  await assert.rejects(postFlomo(endpoint, '字'.repeat(5001), async () => { assert.fail('must not truncate or send'); }), /超过 5000/);
});

test('memo contains quote, comment and source without full text or image data', () => {
  const article = { title: '文章', url: 'https://example.com/read', pageNote: '我的文章笔记', bodyText: 'PRIVATE FULL TEXT' } as Parameters<typeof flomoContent>[0];
  const annotation = { anchor: { exact: '原文摘录' }, note: '我的理解', image: undefined } as Parameters<typeof flomoContent>[1];
  const content = flomoContent(article, annotation);
  assert.equal(content, '我的理解\n“原文摘录”\n文章 #划线笔记/example.com\nhttps://example.com/read');
  assert.equal(flomoContent(article, { ...annotation!, note: '' }), '“原文摘录”\n文章 #划线笔记/example.com\nhttps://example.com/read');
  for (const text of ['文章', '原文摘录', '我的理解', article.url]) assert.ok(content.includes(text));
  assert.ok(!content.includes(article.bodyText));
  assert.equal(flomoContent(article), '我的文章笔记\n文章 #划线笔记/example.com\nhttps://example.com/read');
  const imageContent = flomoContent(article, { ...annotation!, image: { url: 'https://example.com/image.png', alt: '插图', data: 'PRIVATE IMAGE' } });
  assert.ok(imageContent.includes('https://example.com/image.png'));
  assert.equal(imageContent, '我的理解\n插图\nhttps://example.com/image.png\n文章 #划线笔记/example.com\nhttps://example.com/read');
  assert.ok(!imageContent.includes('PRIVATE IMAGE'));
});
