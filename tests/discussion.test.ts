import test from 'node:test';
import assert from 'node:assert/strict';
import { localMemo, parseMemo } from '../obsidian/cards.ts';
import { DEFAULT_AI, type Transport } from '../obsidian/ai.ts';
import { newDiscussion, discuss, distillDiscussion, parseDiscussionDraft, recentTurns, discussionCard, type DiscussionTurn } from '../obsidian/discussion.ts';

const memo = parseMemo('Reading/Cards/Local/source.md', localMemo('代码评审限制交付速度。', 'source', '2026-11-05'), { card_id: 'source', title: '评审瓶颈' })!;
const settings = { ...DEFAULT_AI, baseUrl: 'http://localhost/v1', model: 'test' };
const turn = (index: number): DiscussionTurn => ({ id: String(index), question: '问题 ' + index, answer: '答案 ' + index, createdAt: '2026-11-05' });

test('每张卡片的讨论使用独立快照，保留身份，不包含关联区和其他文件', () => {
  const a = newDiscussion(memo, 'Reading'), b = newDiscussion(memo, 'Other');
  assert.notEqual(a.id, b.id);
  assert.equal(a.context.personal, memo.personal);
  assert.equal(a.folder, 'Reading');
  assert.ok(!('tail' in a.context));
  assert.ok(!('path' in a.context));
  const original = a.context.personal;
  assert.equal(newDiscussion({ ...memo, personal: '改变的笔记' }, 'Reading').context.personal, '改变的笔记');
  assert.equal(a.context.personal, original);
});

test('多轮请求保留角色和上下文，失败的问题只发送一次，不把待处理问题作为历史', async () => {
  const session = newDiscussion(memo, 'Reading'); session.turns = [turn(1), { id: 'pending', question: '为什么？', createdAt: 'now', error: 'network' }];
  let body: any;
  const transport: Transport = async request => { body = JSON.parse(request.body); return { status: 200, text: JSON.stringify({ choices: [{ message: { content: '因为等待时间超过编码时间。' } }] }) }; };
  assert.equal(await discuss(session, '为什么？', settings, transport), '因为等待时间超过编码时间。');
  assert.deepEqual(body.messages.map((m: any) => m.role), ['system', 'user', 'assistant', 'user']);
  assert.ok(body.messages[0].content.includes(memo.personal));
  assert.equal(body.messages.filter((m: any) => m.content === '为什么？').length, 1);
  await assert.rejects(discuss(session, ' ', settings, transport), /问题需为/);
  await assert.rejects(discuss(session, 'a'.repeat(8001), settings, transport), /问题需为/);
  await assert.rejects(discuss(session, '解释一下', settings, async () => ({ status: 200, text: '{"choices":[{"message":{"content":""}}]}' })), /有效回复/);
});

test('上下文限制保留最近的完整问答，历史本身不被截断', () => {
  const turns = Array.from({ length: 20 }, (_, i) => turn(i));
  assert.deepEqual(recentTurns(turns).map(t => t.id), turns.slice(-12).map(t => t.id));
  assert.equal(turns.length, 20);
  const large = turns.map(t => ({ ...t, answer: 'a'.repeat(15000) }));
  assert.equal(recentTurns(large).length, 1);
});

test('整理草稿要求已完成讨论，验证标题和正文，不自动写文件', async () => {
  const session = newDiscussion(memo, 'Reading');
  const transport: Transport = async () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: '{"title":"评审才是瓶颈","body":"先观察等待时间，再优化流程。"}' } }] }) });
  await assert.rejects(distillDiscussion(session, settings, transport), /先完成/);
  session.turns = [turn(1)];
  const draft = await distillDiscussion(session, settings, transport);
  assert.equal(draft.title, '评审才是瓶颈');
  assert.equal(draft.turnCount, 1);
  assert.ok(!draft.savedPath);
  for (const text of ['{}', 'broken', '{"title":"a","body":""}', JSON.stringify({ title: 'a'.repeat(49), body: '正文' })]) assert.throws(() => parseDiscussionDraft(text, 1));
});

test('生成卡片保留编辑后的草稿和来源，特殊路径转义，标记注入不会损坏卡片', () => {
  const session = newDiscussion(memo, 'Reading');
  const draft = parseDiscussionDraft('{"title":"新结论","body":"人工确认的正文。\\n<!-- noting:personal -->"}', 2);
  const source = { ...memo, path: 'Reading/Cards/Renamed/含 空格#与[括号].md' };
  const content = discussionCard(session, draft, source, 'Reading/Cards/Local/' + draft.id + '.md');
  assert.equal(content.split('<!-- noting:personal -->').length, 2);
  assert.ok(content.includes('人工确认的正文。'));
  assert.ok(content.includes('source_card_id: "source"'));
  assert.ok(content.includes('discussion_id: "' + session.id + '"'));
  assert.ok(content.includes('../Renamed/' + encodeURIComponent('含 空格#与[括号].md')));
  assert.ok(parseMemo('saved.md', content, { card_id: draft.id, title: draft.title })?.personal.includes('讨论来源'));
  assert.throws(() => discussionCard(session, { ...draft, id: '../escape' }, source, 'x.md'), /ID 无效/);
});
