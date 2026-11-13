import test from 'node:test';
import assert from 'node:assert/strict';
import { checkedSiyuanUrl, newSiyuanId, SIYUAN_ID, SiyuanClient, siyuanProfile } from '../browser/src/siyuan-api.ts';
import { contentHash, hasVersion, siyuanContent, versionMarkdown } from '../browser/src/siyuan-content.ts';
import type { Article, Annotation } from '../shared/model.ts';

test('思源地址只接受本机 HTTP 或 HTTPS origin，身份不包含 Token', async () => {
  for (const url of ['http://127.0.0.1:6806', 'http://localhost:6806/', 'http://[::1]:6806', 'https://notes.example.com/']) assert.equal(checkedSiyuanUrl(url), new URL(url).origin);
  for (const url of ['http://192.168.1.1:6806', 'https://user:secret@example.com', 'https://example.com/api', 'https://example.com/?token=secret', 'https://example.com/#secret', 'file:///tmp']) assert.throws(() => checkedSiyuanUrl(url));
  assert.equal(await siyuanProfile('http://localhost:6806', 'one'), await siyuanProfile('http://localhost:6806', 'one'));
  assert.notEqual(await siyuanProfile('http://localhost:6806', 'one'), await siyuanProfile('http://localhost:6806', 'two'));
  const ids = Array.from({ length: 500 }, newSiyuanId);
  assert.ok(ids.every(id => SIYUAN_ID.test(id)));
  assert.equal(new Set(ids).size, ids.length);
});

test('思源请求禁止跳转及 cookie，仅发送 Token 给固定接口，错误不回显密钥', async () => {
  const config = { baseUrl: 'http://127.0.0.1:6806', apiToken: 'private-secret' };
  const client = new SiyuanClient(config, async (url, options) => {
    assert.equal(url, config.baseUrl + '/api/system/version');
    assert.equal(options?.credentials, 'omit'); assert.equal(options?.redirect, 'error');
    assert.equal((options?.headers as Record<string, string>).Authorization, 'Token private-secret');
    return Response.json({ code: 0, data: '3.8.10' });
  });
  assert.equal(await client.call('system/version'), '3.8.10');
  await assert.rejects(client.call('file/removeFile'), /不支持/);
  for (const response of [Response.json({ code: -1, msg: config.apiToken }), Response.json(null), new Response(config.apiToken, { status: 403 }), new Response(config.apiToken)]) {
    await assert.rejects(new SiyuanClient(config, async () => response).call('system/version'), error => !String(error).includes(config.apiToken));
  }
  await assert.rejects(new SiyuanClient(config, async () => { throw new Error(config.apiToken); }).call('system/version'), /无法连接/);
});

test('文档查询只有明确 missingIDs 才算缺失，不把请求错误当不存在', async () => {
  const config = { baseUrl: 'http://127.0.0.1:6806', apiToken: 'secret' };
  const id = newSiyuanId();
  const client = (data: unknown) => new SiyuanClient(config, async () => Response.json({ code: 0, data }));
  assert.equal(await client({ documents: [], missingIDs: [id] }).document(id, id), false);
  assert.equal(await client({ documents: [{ id }], missingIDs: [] }).document(id, id), true);
  await assert.rejects(client({ documents: [], missingIDs: [] }).document(id, id));
  await assert.rejects(client(null).document(id, id));
});

test('内容保留摘录及批注，隔离全文、附件和块属性注入；版本标记必须属于同一块', async () => {
  const article = { title: 'C/C++ <标题>', url: 'https://example.com/a', pageNote: '**想法**', bodyText: 'PRIVATE BODY', createdAt: '2026-11-12T00:00:00Z' } as Article;
  const annotation = { note: '批注\n{: id="evil"}\n}}}', anchor: { exact: '> 摘录\n{: id="evil2"}' }, createdAt: article.createdAt } as Annotation;
  const content = siyuanContent(article, annotation);
  assert.ok(content.includes('批注')); assert.ok(!content.includes('PRIVATE BODY'));
  assert.ok(!content.includes('\n{: id="evil"}')); assert.ok(!content.includes('\n}}}'));
  const id = newSiyuanId(), hash = await contentHash(content);
  const markdown = versionMarkdown(content, id, hash, article.createdAt);
  assert.ok(hasVersion(markdown, id, hash));
  assert.ok(!hasVersion(`{: id="${id}"}\n{: custom-underline-hash="${hash}"}`, id, hash));
  const image = siyuanContent(article, { ...annotation, image: { url: 'https://example.com/img', alt: '插图', data: 'PRIVATE IMAGE' } });
  assert.ok(image.includes('图片文件尚未上传')); assert.ok(!image.includes('PRIVATE IMAGE'));
});
