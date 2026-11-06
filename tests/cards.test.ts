import test from 'node:test';
import assert from 'node:assert/strict';
import { articleCards, managedCardPart } from '../shared/markdown.ts';
import { filterMemos, filterSourceGroups, groupMemosBySource, localMemo, memoExcerpt, memoImage, parseMemo, reviewMemos, sourceKey, updateThoughts, type Memo } from '../obsidian/cards.ts';

test('原生卡片视图提取摘录与批注，保留用户 Markdown 和标签', () => {
  const article = { id: 'a_abc', title: '文章', url: 'https://example.com', hostname: 'example.com', createdAt: '2026-11-05', updatedAt: '2026-11-05', pageNote: '', bodyText: '前文很重要。保持 **思考**。后文也很重要。', annotations: [{ id: 'h_abc', color: 'yellow' as const, note: '## 来源\n这是我写的标题。 #架构/边界', createdAt: '2026-11-05', updatedAt: '2026-11-05', anchor: { exact: '保持 **思考**。', prefix: '', suffix: '', start: 6, end: 16 } }] };
  const card = articleCards(article)[0];
  const memo = parseMemo(card.path, card.markdown, { card_id: card.id, title: card.title, article_id: article.id });
  assert.ok(memo);
  assert.equal(memo.quote, article.annotations[0].anchor.exact);
  assert.equal(memo.note, article.annotations[0].note);
  assert.equal(memo.context, article.bodyText);
  assert.deepEqual(memo.tags, ['架构/边界']);
  const saved = updateThoughts(card.markdown, memo.tail, '我的新理解 #实践');
  assert.equal(managedCardPart(saved), managedCardPart(card.markdown));
  assert.match(saved, /我的新理解 #实践/);
  assert.throws(() => updateThoughts(saved, memo.tail, '过时内容'), /新的修改/);
  assert.equal(parseMemo('a.md', 'ordinary note', {}), null);
});

test('独立想法、组合搜索、待消化筛选与稳定每日回顾', () => {
  const memos = Array.from({ length: 12 }, (_, index) => {
    const text = localMemo('抽象边界 ' + index + ' #架构', 'n_' + index, '2026-11-05T00:00:00Z');
    return parseMemo('Cards/n_' + index + '.md', text, { card_id: 'n_' + index, created_at: '2026-11-05T00:00:00Z' })!;
  });
  assert.equal(filterMemos(memos, '边界 10', '架构', 'all').length, 1);
  assert.equal(filterMemos(memos, '', '', 'inbox').length, 0);
  assert.equal(reviewMemos(memos, '2026-11-05').length, 8);
  assert.deepEqual(reviewMemos(memos, '2026-11-05'), reviewMemos([...memos].reverse(), '2026-11-05'));
  assert.equal(new Set(reviewMemos(memos, '2026-11-05').map(memo => memo.id)).size, 8);
});

function sourceMemo(id: string, overrides: Partial<Memo> = {}): Memo {
  return { path: 'Cards/' + id + '.md', id, articleId: 'a_memory', title: '摘录', source: 'Managed Agents Memory', url: 'https://claude.com/resources/articles/memory', createdAt: '2026-11-01T08:00:00Z', updatedAt: '2026-11-01T08:00:00Z', quote: '', note: '', context: '', personal: '', tail: '', tags: [], ...overrides };
}

test('同篇两条笔记与图片自动归组，同名同域不同文章不合并，随手记保留', () => {
  const memos = [sourceMemo('note1', { quote: '跨会话记忆' }), sourceMemo('note2', { note: '关于持久化的理解', createdAt: '2026-11-02T08:00:00Z' }), sourceMemo('image', { note: '![架构图](https://example.com/diagram.png)', createdAt: '2026-11-03T08:00:00Z', updatedAt: '2026-11-04T08:00:00Z' }), sourceMemo('other', { articleId: 'a_other', url: 'https://claude.com/other' }), sourceMemo('local', { articleId: '', url: '', source: '随手记' })];
  const groups = groupMemosBySource(memos.reverse());
  assert.equal(groups.length, 3);
  assert.equal(groups[0].key, 'article:a_memory');
  assert.equal(groups[0].updatedAt, '2026-11-04T08:00:00Z');
  assert.deepEqual(groups[0].memos.map(memo => memo.id), ['note1', 'note2', 'image']);
  assert.equal(groups.find(group => group.key === 'local')?.title, '无来源的随手记');
  assert.equal(filterSourceGroups(groups, '持久化')[0].memos.length, 3, '搜索命中单条笔记时保留同源上下文');
  assert.equal(filterSourceGroups(groups, '跨会话 持久化').length, 1);
  assert.equal(filterSourceGroups(groups, 'claude.com').length, 2);
  assert.equal(filterSourceGroups(groups, '不存在').length, 0);
});

test('无文章 ID 时按去除跟踪参数的完整 URL 分组，保留查询与 hash 路由', () => {
  const a = sourceMemo('a', { articleId: '', url: 'https://example.com/read?id=1&utm_source=test' });
  const b = sourceMemo('b', { articleId: '', url: 'https://example.com/read?id=1' });
  const c = sourceMemo('c', { articleId: '', url: 'https://example.com/read?id=2' });
  const d = sourceMemo('d', { articleId: '', url: 'https://example.com/read?id=1#/other' });
  assert.equal(sourceKey(a), sourceKey(b));
  assert.equal(groupMemosBySource([a, b, c, d]).length, 3);
  assert.doesNotThrow(() => groupMemosBySource([sourceMemo('bad', { articleId: '', url: 'not a url' })]));
  assert.deepEqual(groupMemosBySource([]), []);
});

test('来源预览保留 Markdown 与 Obsidian 图片引用，不将代码示例当图片', () => {
  const memo = sourceMemo('image', { personal: '先理解结构。\n![架构图](<../Attachments/a b.png>)' });
  assert.equal(memoImage(memo), '![架构图](<../Attachments/a b.png>)');
  assert.equal(memoExcerpt(memo), '先理解结构。');
  assert.equal(memoImage(sourceMemo('wiki', { note: '![[架构图.png|240]]' })), '![[架构图.png|240]]');
  assert.equal(memoImage(sourceMemo('embed', { note: '![[另一篇笔记]]\n![[架构图.png]]' })), '![[架构图.png]]');
  assert.equal(memoImage(sourceMemo('pdf', { note: '![[参考.pdf]]' })), '');
  assert.equal(memoImage(sourceMemo('code', { note: '```md\n![示例](example.png)\n```' })), '');
  assert.equal(memoImage(sourceMemo('url', { note: '![图](https://example.com/a_(1).png "图")' })), '![图](https://example.com/a_(1).png "图")');
});
