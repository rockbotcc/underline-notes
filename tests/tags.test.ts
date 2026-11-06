import test from 'node:test';
import assert from 'node:assert/strict';
import { filterMemos, localMemo, parseMemo, updateThoughts } from '../obsidian/cards.ts';
import { generateTags, parseTags, splitTags, tagTree, tagVocabulary, tagVersion, writeTags } from '../obsidian/tags.ts';
import { DEFAULT_AI } from '../obsidian/ai.ts';
import { articleCards, managedCardPart, personalCardPart } from '../shared/markdown.ts';

const parse = (text: string) => parseMemo('Cards/a.md', text, { card_id: 'a', title: '标题' })!;
test('标签独立持久化，保留手写标签、笔记和旧关联；补写不丢自动标签', async () => {
  const original = localMemo('我的思考 #手写', 'a', '2026-11-05') + '\n<!-- noting:relations:start -->\n已有的关联\n<!-- noting:relations:end -->\n';
  const before = parse(original), version = await tagVersion(before);
  const tagged = writeTags(original, ['主题/架构'], version), memo = parse(tagged);
  assert.equal(memo.personal, before.personal);
  assert.deepEqual(memo.tags, ['手写', '主题/架构']);
  assert.equal(memo.tagVersion, version);
  assert.equal(await tagVersion(memo), version, '自身标签写入不导致重新请求');
  assert.equal(managedCardPart(tagged), managedCardPart(original));
  assert.equal(writeTags(tagged, ['主题/架构'], version), tagged, '幂等写入');
  const edited = updateThoughts(tagged, before.tail, '新的思考 #手写');
  assert.match(edited, /已有的关联/);
  assert.deepEqual(parse(edited).aiTags, ['主题/架构']);
  assert.notEqual(await tagVersion(parse(edited)), version);
  const cleared = writeTags(tagged, [], version);
  assert.deepEqual(parse(cleared).tags, ['手写']);
  assert.equal(parse(cleared).tagVersion, version);
  assert.throws(() => splitTags('<!-- noting:tags:start -->bad'), /标记不完整/);
});

test('自动标签随卡片尾部保留，浏览器重新生成引用区域不会丢失', async () => {
  const article = { id: 'abc', title: '标题', url: 'https://example.com', hostname: 'example.com', createdAt: '', updatedAt: '', bodyText: '', pageNote: '共享批注 #手动', annotations: [] };
  const card = articleCards(article)[0].markdown;
  const tagged = writeTags(card, ['知识管理'], await tagVersion(parse(card)));
  const next = articleCards({ ...article, pageNote: '更新后的共享批注 #手动' })[0].markdown;
  const synced = managedCardPart(next) + personalCardPart(tagged);
  assert.deepEqual(parse(synced).tags, ['手动', '知识管理']);
  assert.equal(parse(synced).note, '更新后的共享批注 #手动');
});

test('标签响应拒绝链接、标记注入、超限和保留命名空间', () => {
  assert.deepEqual(parseTags('```json\n{"tags":["架构","AI","ai","领域/主题"]}\n```'), ['架构', 'AI', '领域/主题']);
  for (const tags of [['[链接](evil)'], ['<!-- noting:personal -->'], ['#标签'], ['noting/摘录'], ['123'], ['长'.repeat(33)], ['a','b','c','d','e','f']]) assert.throws(() => parseTags(JSON.stringify({ tags })));
  assert.throws(() => parseTags('{"tags":"标签"}'));
});

test('标签请求仅包含当前卡片有限内容，排除手写重复标签', async () => {
  const memo = parse(localMemo('思考 #技术/手写', 'a', '2026-11-05'));
  memo.context = '禁止发送的上下文'; memo.note = '批注'.repeat(2000); memo.quote = '摘录'.repeat(1000);
  const tags = await generateTags(memo, { ...DEFAULT_AI, baseUrl: 'https://model.example/v1', model: 'test' }, async request => {
    const body = JSON.parse(request.body), input = JSON.parse(body.messages[1].content);
    assert.equal(input.note.length, 1800); assert.equal(input.quote.length, 1200);
    assert.ok(!request.body.includes(memo.context));
    assert.deepEqual(input.reusableTags, ['技术/AI']);
    return { status: 200, text: JSON.stringify({ choices: [{ message: { content: '{"tags":["技术/手写","技术/ai"]}' } }] }) };
  }, ['技术/AI']);
  assert.deepEqual(tags, ['技术/AI']);
});

test('父标签包含后代且卡片计数去重，兼容旧的多级标签', () => {
  const memos = [['技术', '技术/AI', '技术/架构'], ['技术/AI/Agent'], ['技术栈/前端']].map(tags => ({ ...parse(localMemo('思考', 'a', '2026-11-05')), tags }));
  const tree = tagTree(memos);
  assert.equal(tree[0].tag, '技术'); assert.equal(tree[0].count, 2);
  assert.equal(tree[0].children[0].tag, '技术/AI'); assert.equal(tree[0].children[0].count, 2);
  assert.equal(filterMemos(memos, '', '技术', 'all').length, 2);
  assert.equal(filterMemos(memos, '', '技术/ai', 'all').length, 2);
  assert.equal(filterMemos(memos, '', '技术/A', 'all').length, 0);
});

test('共享词表有界，排除系统标签和非法层级', () => {
  const vocabulary = tagVocabulary([{ tags: ['noting/想法', '散标签', '领域/主题/细节', '技术/AI', '技术/ai', ...Array.from({ length: 100 }, (_, i) => '技术/主题' + i)] }]);
  assert.equal(vocabulary.length, 80);
  assert.equal(vocabulary[0], '技术/AI');
  assert.ok(!vocabulary.includes('noting/想法'));
});

test('自动生成拒绝散标签、三级标签、未知领域和过量标签', async () => {
  const memo = parse(localMemo('思考', 'a', '2026-11-05'));
  for (const tags of [['散标签'], ['技术/AI/Agent'], ['随便新建领域/主题'], ['技术/A', '技术/B', '技术/C', '技术/D']]) {
    await assert.rejects(generateTags(memo, { ...DEFAULT_AI, baseUrl: 'https://model.example/v1', model: 'test' }, async () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ tags }) } }] }) })), /二级标签格式无效/);
  }
});
