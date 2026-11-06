import test from 'node:test';
import assert from 'node:assert/strict';
import { articleCards, personalCardPart } from '../shared/markdown.ts';
import { cardStructure, mergeNote, readCardNote, replaceCardNote, updateCardNote } from '../shared/note-sync.ts';

const article = { id: 'a_test', title: '文章', hostname: 'example.com', url: 'https://example.com', createdAt: '2026-11-05', updatedAt: '2026-11-05', pageNote: '原始笔记', bodyText: '参考正文', annotations: [] };

test('三方合并：单侧更新、相同更新、清空和不同更新', () => {
  assert.deepEqual(mergeNote('原文', '原文', '新理解'), { note: '新理解', conflict: false });
  assert.deepEqual(mergeNote('原文', '浏览器修改', '原文'), { note: '浏览器修改', conflict: false });
  assert.deepEqual(mergeNote('原文', '相同修改', '相同修改'), { note: '相同修改', conflict: false });
  assert.deepEqual(mergeNote('原文', '原文', ''), { note: '', conflict: false });
  assert.equal(mergeNote('原文', '修改甲', '修改乙').conflict, true);
});

test('编辑共享笔记保留引用和延伸思考，拒绝旧草稿，支持 Markdown 和标记文本', () => {
  const card = articleCards(article)[0].markdown + '\n延伸思考内的示例 <!-- noting:note:start -->';
  const next = '**新理解** #标签 [[关联]]\n<!-- noting:note:end -->';
  const updated = updateCardNote(card, '原始笔记', next);
  assert.equal(readCardNote(updated), next);
  assert.equal(cardStructure(updated), cardStructure(card));
  assert.equal(personalCardPart(updated), personalCardPart(card));
  assert.throws(() => updateCardNote(updated, '原始笔记', '旧草稿'), /新的修改/);
  assert.equal(readCardNote(updateCardNote(updated, next, '')), '');
});

test('旧空批注卡可添加笔记，损坏标记拒绝同步，清空文章笔记仍保留卡片', () => {
  const current = articleCards(article)[0].markdown;
  const legacy = current.replace(/<!-- noting:note:start -->[\s\S]*?<!-- noting:note:end -->\n\n/, '');
  assert.equal(readCardNote(legacy), '');
  const updated = replaceCardNote(legacy, '新增笔记');
  assert.equal(readCardNote(updated), '新增笔记');
  assert.equal(cardStructure(updated), cardStructure(legacy));
  assert.throws(() => readCardNote(current.replace('<!-- noting:note:end -->', '')), /分界标记/);
  assert.equal(articleCards({ ...article, pageNote: '', pageNoteCard: true }).length, 1);
});
