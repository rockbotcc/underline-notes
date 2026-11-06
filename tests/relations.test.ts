import test from 'node:test';
import assert from 'node:assert/strict';
import { localMemo, parseMemo, updateThoughts, type Memo } from '../obsidian/cards.ts';
import { addRelation, memoVersion, pairKey, splitRelations, RELATIONS_START, RELATIONS_END } from '../obsidian/relations.ts';
import { apiRequest, candidatesByMeaning, cosine, DEFAULT_AI, discoverRelations, endpoint, localCandidates, parseSuggestions, parseVectors, type Transport } from '../obsidian/ai.ts';
import { managedCardPart, personalCardPart } from '../shared/markdown.ts';
import { updateCardNote } from '../shared/note-sync.ts';

function memo(id: string, text: string): Memo {
  return parseMemo('Reading/Cards/Local/' + id + '.md', localMemo(text, id, '2026-11-05'), { card_id: id, title: text.split('\n')[0] })!;
}
const source = memo('one', 'AI 提升编码效率\n代码生成速度越来越快。');
const target = memo('two', '代码评审的瓶颈\n审查时间限制了团队交付效率。');
const third = memo('three', '阅读带来新的视角。');
const response = { relations: [{ targetId: 'two', type: '观点补充', reason: '产出速度与审查速度共同影响团队效率。', sourceEvidence: '代码生成速度越来越快。', targetEvidence: '审查时间限制了团队交付效率。' }] };
const relation = () => parseSuggestions(JSON.stringify(response), source, [target], 'Reading')[0];
const settings = { ...DEFAULT_AI, baseUrl: 'http://localhost:9000/v1', model: 'chat-test' };

test('关联证据必须来自本次候选；未知 ID、自关联、伪造证据和重复结果不写入', () => {
  assert.equal(parseSuggestions('```json\n' + JSON.stringify(response) + '\n```', source, [target], 'Reading').length, 1);
  assert.throws(() => parseSuggestions('not json', source, [target], 'Reading'), /格式无效/);
  const row = response.relations[0];
  for (const invalid of [{ ...row, targetId: 'unknown' }, { ...row, targetId: 'one' }, { ...row, sourceEvidence: '模型虚构的依据' }, { ...row, type: '相似' }, { ...row, reason: '' }]) {
    assert.throws(() => parseSuggestions(JSON.stringify({ relations: [invalid] }), source, [source, target], 'Reading'), /缺少有效/);
  }
  assert.equal(parseSuggestions(JSON.stringify({ relations: [row, row, { ...row, targetId: 'unknown' }] }), source, [target], 'Reading').length, 1);
  assert.deepEqual(parseSuggestions('{"relations":[]}', source, [target], 'Reading'), []);
});

test('确认写入保留生成区，双向依据方向正确，重试不重复；浏览器同步保留关联区', () => {
  const r = relation();
  const original = localMemo(source.personal, source.id, '2026-11-05');
  const linked = addRelation(original, r, source, target);
  assert.equal(managedCardPart(linked), managedCardPart(original));
  assert.match(linked, /\[\[Reading\/Cards\/Local\/two\|代码评审的瓶颈\]\]/);
  assert.equal(addRelation(linked, r, source, target), linked);
  const reversed = addRelation(localMemo(target.personal, target.id, '2026-11-05'), r, target, source);
  assert.match(reversed, /本条依据：审查时间限制了团队交付效率。/);
  assert.match(reversed, /对方依据：代码生成速度越来越快。/);
  const parsed = parseMemo(source.path, linked, { card_id: source.id, title: source.title })!;
  assert.equal(parsed.personal, source.personal);
  assert.equal(memoVersion(parsed), memoVersion(source));
  const synced = managedCardPart(original) + personalCardPart(linked);
  assert.equal(synced, linked);
});

test('编辑延伸思考保留并发新增关联及其他尾部正文，拒绝并发正文修改和损坏区域', () => {
  const original = localMemo(source.personal, source.id, '2026-11-05');
  const snapshot = parseMemo(source.path, original, { card_id: source.id })!;
  const linked = addRelation(original, relation(), source, target);
  const saved = updateThoughts(linked, snapshot.tail, '新的思考');
  assert.equal(splitRelations(personalCardPart(saved)).block, splitRelations(personalCardPart(linked)).block);
  assert.equal(parseMemo(source.path, saved, { card_id: source.id })!.personal, '新的思考');
  assert.throws(() => updateThoughts(saved, snapshot.tail, '旧草稿'), /新的修改/);
  const extra = linked + '\n尾部的手写正文';
  const parsed = parseMemo(source.path, extra, { card_id: source.id })!;
  const updated = updateThoughts(extra, parsed.tail, parsed.personal + '\n补充');
  assert.match(updated, /尾部的手写正文\n补充/);
  assert.throws(() => splitRelations(RELATIONS_START), /标记不完整/);
  assert.throws(() => splitRelations(RELATIONS_END + RELATIONS_START), /标记不完整/);
  assert.throws(() => splitRelations(RELATIONS_START + RELATIONS_END + RELATIONS_START), /标记不完整/);
});

test('编辑共享批注不碰关联；AI 文本不能注入 Markdown 链接或标记', () => {
  const original = '---\ncard_id: one\n---\n<!-- noting:note:start -->\n## 我的批注\n\n旧批注\n<!-- noting:note:end -->\n<!-- noting:personal -->\n## 延伸思考\n';
  const linked = addRelation(original, { ...relation(), reason: '![恶意](url)\n<!-- noting:relations:end -->' }, source, target);
  const changed = updateCardNote(linked, '旧批注', '新批注');
  assert.equal(personalCardPart(changed), personalCardPart(linked));
  assert.equal(linked.split(RELATIONS_END).length, 2);
  assert.ok(!linked.includes('![恶意](url)'));
});

test('内容签名忽略路径与关联写入时间，双向笔记对使用同一键', () => {
  assert.equal(memoVersion(source), memoVersion({ ...source, path: 'new.md', updatedAt: 'tomorrow' }));
  assert.notEqual(memoVersion(source), memoVersion({ ...source, personal: '已修改' }));
  assert.equal(pairKey('a', 'b'), pairKey('b', 'a'));
  assert.notEqual(pairKey('a:b', 'c'), pairKey('a', 'b:c'));
});

test('兼容接口构造与错误处理不泄漏密钥或服务响应正文，超时后不接受迟到结果', async () => {
  assert.equal(endpoint('https://example.com/v1/', 'embeddings'), 'https://example.com/v1/embeddings');
  assert.equal(endpoint('https://example.com/v1/chat/completions', 'embeddings'), 'https://example.com/v1/embeddings');
  assert.throws(() => endpoint('file:///tmp/key', 'embeddings'));
  assert.throws(() => endpoint('https://user:secret@example.com/v1', 'embeddings'));
  let seen: any;
  assert.deepEqual(await apiRequest({ ...settings, apiKey: 'secret' }, 'chat/completions', { model: 'test' }, async req => { seen = req; return { status: 200, text: '{"ok":true}' }; }), { ok: true });
  assert.equal(seen.headers.Authorization, 'Bearer secret');
  for (const status of [401, 429, 500]) await assert.rejects(apiRequest(settings, 'chat/completions', {}, async () => ({ status, text: 'SECRET' })), error => error instanceof Error && !error.message.includes('SECRET') && error.message.includes(String(status)));
  await assert.rejects(apiRequest(settings, 'chat/completions', {}, async () => { throw new Error('network SECRET'); }), /网络请求失败/);
  await assert.rejects(apiRequest(settings, 'chat/completions', {}, () => new Promise(() => {}), 5), /超过 60 秒/);
});

test('向量响应按 index 对齐，拒绝重复、无效数值、零向量、维度错误', () => {
  assert.deepEqual(parseVectors({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] }, 2), [[1, 0], [0, 1]]);
  for (const data of [[{ index: 0, embedding: [0, 0] }], [{ index: 0, embedding: [NaN, 1] }], [{ index: 1, embedding: [1] }]]) assert.throws(() => parseVectors({ data }, 1));
  assert.throws(() => parseVectors({ data: [{ index: 0, embedding: [1] }, { index: 0, embedding: [1] }] }, 2));
  assert.throws(() => cosine([1, 0], [1]));
});

test('语义检索缓存未变内容，修改后增量更新，变更模型后重建', async () => {
  let inputs = 0;
  const transport: Transport = async request => {
    const body = JSON.parse(request.body); inputs += body.input.length;
    return { status: 200, text: JSON.stringify({ data: body.input.map((text: string, index: number) => ({ index, embedding: text.includes('阅读') ? [0, 1] : [1, 0] })) }) };
  };
  const cache = new Map();
  const config = { ...settings, embeddingModel: 'vector-test' };
  const candidates = await candidatesByMeaning(source, [third, target], config, transport, cache, () => {});
  assert.equal(candidates[0].id, target.id);
  await candidatesByMeaning(source, [third, target], config, transport, cache, () => {});
  assert.equal(inputs, 3);
  await candidatesByMeaning({ ...source, personal: source.personal + '新内容' }, [third, target], config, transport, cache, () => {});
  assert.equal(inputs, 4);
  await candidatesByMeaning(source, [third, target], { ...config, embeddingModel: 'other' }, transport, cache, () => {});
  assert.equal(inputs, 7);
});

test('发现流程发送有限片段、验证依据，忽略与已确认双向排除；不同文件夹独立', async () => {
  let calls = 0;
  const transport: Transport = async request => {
    calls++;
    const body = JSON.parse(request.body), payload = JSON.parse(body.messages[1].content);
    assert.equal(payload.source.id, source.id);
    assert.equal(payload.candidates[0].id, target.id);
    assert.ok(!('path' in payload.source));
    return { status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify(response) } }] }) };
  };
  assert.equal((await discoverRelations(source, [source, target], [], 'Reading', settings, transport, new Map(), () => {})).length, 1);
  for (const status of ['ignored', 'confirmed', 'linking'] as const) {
    assert.deepEqual(await discoverRelations(source, [source, target], [{ ...relation(), sourceId: target.id, targetId: source.id, status }], 'Reading', settings, transport, new Map(), () => {}), []);
  }
  assert.equal(calls, 1);
  await discoverRelations(source, [source, target], [{ ...relation(), folder: 'Other', status: 'ignored' }], 'Reading', settings, transport, new Map(), () => {});
  assert.equal(calls, 2);
  assert.equal(localCandidates(source, [third, target])[0].id, target.id);
});
