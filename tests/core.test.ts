import test from 'node:test';
import assert from 'node:assert/strict';
import { articleId, normalizeUrl, isExcluded, obsidianUrl } from '../shared/model.ts';
import { locateText } from '../browser/src/anchors.ts';
import { articleCards, articleMarkdown, dayMarkdown, indexMarkdown, managedCardPart, personalCardPart, PERSONAL_TEMPLATE } from '../shared/markdown.ts';
import { validateBackup } from '../browser/src/backup.ts';

test('URL 身份保留业务参数和 hash 路由，仅去掉追踪参数', async () => {
  assert.equal(normalizeUrl('https://example.com/read?id=7&utm_source=x#/part2'), 'https://example.com/read?id=7#/part2');
  assert.equal(await articleId('https://example.com/read?utm_source=x'), await articleId('https://example.com/read'));
  assert.notEqual(await articleId('https://example.com/read?id=1'), await articleId('https://example.com/read?id=2'));
  assert.throws(() => normalizeUrl('javascript:alert(1)'));
  assert.equal(isExcluded('https://sub.example.com/a', ['example.com']), true);
  assert.equal(isExcluded('https://notexample.com/a', ['example.com']), false);
});

test('划线在内容移动后按上下文恢复，对重复且歧义的文字保留待定位状态', () => {
  const anchor = { exact: 'important', prefix: 'before ', suffix: ' after', start: 7, end: 16 };
  assert.equal(locateText('new banner before important after', anchor), 18);
  assert.equal(locateText('important then before important after', anchor), 22);
  assert.equal(locateText('before important after before important after', anchor), null);
  assert.equal(locateText('completely changed', anchor), null);
});

test('完整备份可恢复，拒绝路径注入、非法 ID 和不完整的引用', async () => {
  const id = await articleId('https://example.com/article');
  const article = {
    id, url: 'https://example.com/article', title: '文章', hostname: 'example.com',
    createdAt: '2026-11-05T00:00:00Z', updatedAt: '2026-11-05T00:00:00Z',
    pageNote: '笔记', bodyText: '', annotations: [],
  };
  const backup = { schemaVersion: 1, articles: [article], sessions: [] };
  assert.equal((await validateBackup(backup)).articles[0].id, id);
  await assert.rejects(validateBackup({ ...backup, articles: [{ ...article, id: '../../escape' }] }));
  await assert.rejects(validateBackup({ ...backup, sessions: [{ id: 'abc', articleId: 'missing', day: '2026-11-05' }] }));
  await assert.rejects(validateBackup({ ...backup, articles: [article, article] }));
});

test('Markdown 保留用户笔记，转义网页内容，阅读时间合并到同一篇文章', async () => {
  const id = await articleId('https://example.com/article');
  const article = {
    id, url: 'https://example.com/article', title: '标题 [链接]', hostname: 'example.com',
    createdAt: '2026-11-05T00:00:00Z', updatedAt: '2026-11-05T00:00:00Z',
    pageNote: '**我的想法**', bodyText: '<script>bad()</script>',
    annotations: [{ id: 'h_abc', anchor: { exact: '[点击](javascript:evil)', prefix: '', suffix: '', start: 0, end: 23 }, color: 'yellow' as const, note: '保留批注', createdAt: '', updatedAt: '' }],
  };
  const sessions = [1, 2].map(index => ({ id: String(index), articleId: id, day: '2026-11-05', startedAt: '', updatedAt: '2026-11-05T01:00:00Z', activeMs: 60000, progress: 50 }));
  const markdown = articleMarkdown(article, sessions);
  assert.match(markdown, /reading_minutes: 2/);
  const cards = articleCards(article);
  assert.equal(cards.length, 2);
  assert.match(cards[1].markdown, /\*\*我的想法\*\*/);
  assert.ok(cards[0].markdown.includes('\\[点击\\]'));
  assert.match(cards[0].markdown, /保留批注/);
  assert.ok(cards[0].markdown.includes('../../Articles/' + id + '.md#保存的正文'));
  assert.equal(personalCardPart(cards[0].markdown), PERSONAL_TEMPLATE);
  assert.equal(managedCardPart(cards[0].markdown + '\n新想法'), managedCardPart(cards[0].markdown));
  assert.ok(indexMarkdown([article], sessions).includes('![['));
  assert.ok(markdown.includes('![['));
  assert.ok(markdown.includes('\\<script\\>'));
  assert.match(dayMarkdown('2026-11-05', sessions, [article]), /2 分钟 · 2 次阅读/);
  const uri = obsidianUrl({ recordHistory: true, excludedDomains: [], vaultName: '我的 笔记', vaultFolder: 'Reading' }, id);
  assert.equal(new URL(uri).searchParams.get('file'), `Reading/Articles/${id}.md`);
});

test('卡片保留上下文，正文保留格式，旧格式备份无需正文也可生成卡片', () => {
  const article = {
    id: 'abc', url: 'https://example.com', title: '理解抽象', hostname: 'example.com',
    createdAt: '2026-11-05T00:00:00Z', updatedAt: '2026-11-05T00:00:00Z', pageNote: '',
    bodyText: '先观察需求。好的抽象来自对变化的理解。最后在实践中验证。', bodyMarkdown: '## 观察\n\n**变化**与验证',
    annotations: [{ id: 'h_abc', anchor: { exact: '好的抽象来自对变化的理解。', prefix: '', suffix: '', start: 6, end: 21 }, color: 'yellow' as const, note: '', createdAt: '', updatedAt: '' }],
  };
  assert.match(articleCards(article)[0].markdown, /先观察需求。好的抽象来自对变化的理解。最后在实践中验证。/);
  assert.ok(articleMarkdown(article, []).includes('## 观察\n\n**变化**与验证'));
  assert.match(articleMarkdown({ ...article, bodyText: '', bodyMarkdown: undefined }, []), /还没有保存正文/);
  assert.equal(articleCards({ ...article, deletedAt: article.updatedAt }).length, 0);
});

test('上下文仅补充相邻句子，文章级笔记和没有额外文字的摘录不生成上下文', () => {
  const cardContext = (bodyText: string, exact: string, prefix = '', suffix = '') => {
    const cards = articleCards({
      id: 'abc', url: 'https://example.com', title: '文章', hostname: 'example.com',
      createdAt: '', updatedAt: '', pageNote: '文章笔记', bodyText,
      annotations: [{ id: 'h_abc', anchor: { exact, prefix, suffix, start: 0, end: exact.length }, color: 'yellow', note: '', createdAt: '', updatedAt: '' }],
    });
    assert.doesNotMatch(cards[1].markdown, /noting:context|原文上下文/);
    assert.match(cards[1].markdown, /本地全文/);
    return cards[0].markdown.match(/<!-- noting:context:start -->\n> \[!abstract\]- 原文上下文\n> (.*?)\n<!-- noting:context:end -->/s)?.[1];
  };
  assert.equal(cardContext('更早一句。前一句。摘录。后一句。更晚一句。', '摘录。'), '前一句。摘录。后一句。');
  assert.equal(cardContext('更早一句。前半句包含摘录以及后半句。更晚一句。', '摘录'), '前半句包含摘录以及后半句。');
  assert.equal(cardContext('Earlier. Before. Selected. After. Later.', 'Selected.'), 'Before. Selected. After.');
  assert.equal(cardContext('他说：“前一句。”摘录。后一句。更晚一句。', '摘录。'), '他说：“前一句。”摘录。后一句。');
  assert.equal(cardContext('摘录。后一句。更晚一句。', '摘录。'), '摘录。后一句。');
  assert.equal(cardContext('更早一句。前一句。摘录。', '摘录。'), '前一句。摘录。');
  assert.equal(cardContext('摘录。', '摘录。'), undefined);
  assert.equal(cardContext('只有\n摘录。', '只有\n摘录。'), undefined);
  assert.equal(cardContext('', '摘录。', '更早一句。前一句。', '后一句。更晚一句。'), '前一句。摘录。后一句。');
  assert.equal(cardContext('错误前文。摘录。错误后文。摘录。', '摘录。', '正确前文。', '正确后文。'), '正确前文。摘录。正确后文。');

  const exact = '完整摘录'.repeat(60) + '。';
  const longBefore = '前'.repeat(180) + '。';
  const longAfter = '后'.repeat(180) + '。';
  for (const [before, after] of [[longBefore, longAfter], ['', longAfter], [longBefore, '短句。']]) {
    const context = cardContext(before + exact + after, exact)!;
    assert.ok(context.includes(exact), '完整保留长摘录');
    assert.equal(Array.from(context).length - Array.from(exact).length, 150);
    assert.ok(context.includes('…'), '超长句截断时显示省略号');
    if (after === '短句。') assert.ok(context.endsWith(after), '保留短句并将剩余额度分配给另一侧');
  }
  const fallback = cardContext('', '摘录。', longBefore, longAfter)!;
  assert.equal(Array.from(fallback).length - Array.from('摘录。').length, 150, '旧记录同样遵守上限');
});
