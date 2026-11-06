import test from 'node:test';
import assert from 'node:assert/strict';
import { articleId, checkedImage } from '../shared/model.ts';
import { validateBackup } from '../browser/src/backup.ts';
import { articleCards } from '../shared/markdown.ts';
import { memoImage, parseMemo } from '../obsidian/cards.ts';
import { readCardNote, replaceCardNote } from '../shared/note-sync.ts';

test('图片校验拒绝脚本、临时地址、凭据及过长信息', () => {
  for (const url of ['javascript:alert(1)', 'data:image/png;base64,abc', 'blob:https://example.com/id', 'https://user:secret@example.com/a.png']) {
    assert.throws(() => checkedImage({ url, alt: '' }));
  }
  assert.throws(() => checkedImage({ url: 'https://example.com/a.png', alt: 'x'.repeat(2001) }));
  assert.deepEqual(checkedImage({ url: 'https://example.com/a b.png?size=2&utm_source=original', alt: '架构图' }), { url: 'https://example.com/a%20b.png?size=2&utm_source=original', alt: '架构图' });
});

test('图片和批注备份往返，导出图片卡片并保留可编辑批注', async () => {
  const url = 'https://example.com/read';
  const exact = '架构 [图] <script>\n说明';
  const image = { url: 'https://example.com/image(a).png?x=1&y=2', alt: exact };
  const timestamp = '2026-11-05T00:00:00Z';
  const backup = { schemaVersion: 1, sessions: [], articles: [{
    id: await articleId(url), url, hostname: 'example.com', title: '文章', createdAt: timestamp, updatedAt: timestamp,
    pageNote: '', bodyText: '前一句。' + exact + '。后一句。', annotations: [{
      id: 'h_12345678-1234-1234-1234-123456789abc', image,
      anchor: { exact, prefix: '', suffix: '', start: 0, end: exact.length },
      color: 'yellow', note: '**我的理解**', createdAt: timestamp, updatedAt: timestamp,
    }],
  }] };
  const restored = await validateBackup(backup);
  assert.deepEqual(restored.articles[0].annotations[0].image, image);
  const card = articleCards(restored.articles[0])[0];
  assert.ok(card.markdown.includes('![架构 \\[图\\] \\<script\\> 说明](<https://example.com/image(a).png?x=1&y=2>)'));
  assert.doesNotMatch(card.markdown, /noting:context/);
  const memo = parseMemo(card.path, card.markdown, { card_id: card.id });
  assert.ok(memo);
  assert.match(memoImage(memo), /^!\[/);
  assert.equal(memo.note, '**我的理解**');
  const edited = replaceCardNote(card.markdown, '后来的理解');
  assert.equal(readCardNote(edited), '后来的理解');
  assert.equal(parseMemo(card.path, edited, { card_id: card.id })?.image, memo.image);
  const invalid = structuredClone(backup);
  invalid.articles[0].annotations[0].image.url = 'javascript:alert(1)';
  await assert.rejects(validateBackup(invalid));
});
