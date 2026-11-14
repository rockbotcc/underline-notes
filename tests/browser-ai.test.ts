import test from 'node:test';
import assert from 'node:assert/strict';
import { autoTagNote, selectKnownTags, tagEndpoint, tagsIn, readVaultTags } from '../browser/src/ai-tags.ts';
import { normalizeTags, parseVaultTags } from '../shared/vault-tags.ts';

test('模型只能选择完整已有标签，丢弃未知、注入、大小写变体和重复项', () => {
  assert.deepEqual(selectKnownTags(JSON.stringify({ tags: ['新标签', '领域/AI', '领域/AI', '领域/ai', '领域', '#领域/AI', '<script>', '已有'] }), ['领域/AI', '已有'], '笔记 #已有'), ['领域/AI']);
  assert.deepEqual(selectKnownTags('{"tags":["未知"]}', [], ''), []);
  assert.throws(() => selectKnownTags('{"tags":"错误"}', ['错误'], ''));
  assert.deepEqual(tagsIn('思考 #技术/AI #技术/AI #noting/摘录'), ['技术/AI', 'noting/摘录']);
  assert.deepEqual(normalizeTags(['#技术/AI/Agent', '技术/ai/agent', '写作']), ['写作', '技术/AI/Agent']);
});

test('浏览器只读取 Obsidian 全仓库标签快照，缺失或格式错误不能回退', async () => {
  const snapshot = JSON.stringify({ schemaVersion: 1, source: 'obsidian-vault', tags: ['工作', '技术/AI/Agent'] });
  assert.equal(parseVaultTags(snapshot).length, 2);
  assert.throws(() => parseVaultTags('{"tags":["浏览器"]}'));
  await assert.rejects(readVaultTags(), /连接 Obsidian/);
  await assert.rejects(readVaultTags({ getDirectoryHandle: async () => { throw new Error('missing'); } } as any), /无法读取/);
  const directory = { getDirectoryHandle: async () => ({ getFileHandle: async () => ({ getFile: async () => new File([snapshot], 'vault-tags.json') }) }) } as any;
  assert.deepEqual(await readVaultTags(directory), parseVaultTags(snapshot));
});

test('请求有界且不携带浏览器凭据；无候选或未开启时不请求', async () => {
  const ai = { enabled: true, baseUrl: 'https://model.example/v1', apiKey: 'secret', model: 'test' };
  const input = { title: '题'.repeat(300), note: '注'.repeat(2000), quote: '摘'.repeat(2000) };
  let calls = 0;
  const request = async (url: any, options: any) => {
    calls++;
    assert.equal(url, 'https://model.example/v1/chat/completions');
    assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
    const payload = JSON.parse(JSON.parse(options.body).messages[1].content);
    assert.equal(payload.title.length, 200); assert.equal(payload.note.length, 1800); assert.equal(payload.quote.length, 1200);
    assert.deepEqual(payload.allowedTags, ['写作']);
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"tags":["写作","未知"]}' } }] }));
  };
  assert.equal(await autoTagNote(ai, input, ['写作'], request), input.note + '\n\n#写作');
  assert.equal(await autoTagNote(ai, input, [], request), input.note);
  assert.equal(await autoTagNote({ ...ai, enabled: false }, input, ['写作'], request), input.note);
  assert.equal(calls, 1);
  await assert.rejects(autoTagNote(ai, input, ['写作'], async () => new Response('', { status: 401 })));
  assert.throws(() => tagEndpoint('https://user:pass@example.com/v1'));
  assert.throws(() => tagEndpoint('file:///tmp/model'));
});


test('模型接口禁止远程明文传输，保留本机模型支持', () => {
  for (const host of ['example.com', '192.168.1.2', 'localhost.example.com']) assert.throws(() => tagEndpoint('http://' + host + '/v1'));
  for (const host of ['localhost', '127.0.0.1', '[::1]']) assert.equal(tagEndpoint('http://' + host + ':8080/v1'), 'http://' + host + ':8080/v1/chat/completions');
});
