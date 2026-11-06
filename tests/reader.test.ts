import test from 'node:test';
import assert from 'node:assert/strict';
import { contextForQuote, locateReaderQuote } from '../obsidian/reader.ts';

test('本地全文定位容忍换行和空白变化，并返回原文位置', () => {
  const text = '标题\n之前。对应的\n划线 穿过链接。之后。';
  const match = locateReaderQuote(text, '对应的划线穿过链接。');
  assert.ok(match);
  assert.equal(text.slice(match.start, match.end), '对应的\n划线 穿过链接。');
  assert.equal(locateReaderQuote(text, '不存在'), null);
  assert.equal(locateReaderQuote(text, ' \n'), null);
});

test('重复摘录使用前后文区分，歧义、重叠匹配或过期前后文不任意定位', () => {
  const text = '前文甲。摘录。后文甲。前文乙。摘录。后文乙。';
  assert.equal(locateReaderQuote(text, '摘录。'), null);
  const expected = { start: text.lastIndexOf('摘录。'), end: text.lastIndexOf('摘录。') + 3 };
  assert.deepEqual(locateReaderQuote(text, '摘录。', [{ prefix: '前文乙。', suffix: '后文乙。' }]), expected);
  assert.equal(locateReaderQuote(text, '摘录。', [{ prefix: '前文甲。', suffix: '后文乙。' }]), null);
  assert.equal(locateReaderQuote('哈哈哈', '哈哈'), null);
  const context = contextForQuote('…前文乙。摘\n录。后文乙。…', '摘录。');
  assert.deepEqual(context, { prefix: '前文乙。', suffix: '后文乙。' });
  assert.deepEqual(locateReaderQuote(text, '摘录。', [context!]), expected);
  assert.equal(contextForQuote('摘录。重复摘录。', '摘录。'), undefined);
});
