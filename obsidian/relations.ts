import type { Memo } from './cards.ts';

export const RELATION_TYPES = ['观点补充', '观点冲突', '具体例子', '不同视角'] as const;
export type RelationType = typeof RELATION_TYPES[number];
export interface Relation {
  id: string; folder: string; sourceId: string; targetId: string;
  sourceVersion: string; targetVersion: string;
  type: RelationType; reason: string; sourceEvidence: string; targetEvidence: string;
  status: 'suggested' | 'ignored' | 'linking' | 'confirmed'; createdAt: string;
}
export const RELATIONS_START = '<!-- noting:relations:start -->';
export const RELATIONS_END = '<!-- noting:relations:end -->';

// Keep the entire original block, including user edits, when editing thoughts.
export function splitRelations(tail: string): { thoughts: string; block: string; after: string } {
  const start = tail.indexOf(RELATIONS_START), end = tail.indexOf(RELATIONS_END);
  if (start < 0 && end < 0) return { thoughts: tail, block: '', after: '' };
  if (start < 0 || end < start || tail.indexOf(RELATIONS_START, start + 1) >= 0 || tail.indexOf(RELATIONS_END, end + 1) >= 0) {
    throw new Error('关联区域标记不完整，请先恢复标记；原笔记未被覆盖。');
  }
  return { thoughts: tail.slice(0, start), block: tail.slice(start, end + RELATIONS_END.length), after: tail.slice(end + RELATIONS_END.length) };
}

export function pairKey(a: string, b: string): string { return JSON.stringify([a, b].sort()); }
export function memoVersion(memo: Memo): string {
  const text = JSON.stringify([memo.id, memo.title, memo.note, memo.personal, memo.quote, memo.context]);
  // Content signature, not a timestamp: relation writes and renames don't invalidate suggestions.
  let a = 2166136261, b = 5381;
  for (const char of text) { const code = char.codePointAt(0)!; a = Math.imul(a ^ code, 16777619); b = Math.imul(b, 33) ^ code; }
  return (a >>> 0).toString(16) + ':' + (b >>> 0).toString(16) + ':' + text.length;
}

function plain(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').replace(/([\\`*_{}\[\]<>#!|])/g, '\\$1');
}

export function addRelation(current: string, relation: Relation, self: Memo, other: Memo): string {
  const marker = '<!-- noting:personal -->';
  const boundary = current.indexOf(marker);
  if (boundary < 0) throw new Error('卡片缺少内容分界标记，未写入关联。');
  const tail = current.slice(boundary + marker.length);
  const parts = splitRelations(tail);
  if (!/^[\w-]+$/.test(relation.id)) throw new Error('关联 ID 无效。');
  const entryMarker = '<!-- noting:relation:' + relation.id + ' -->';
  if (parts.block.includes(entryMarker)) return current;
  if (/[\[\]|#^\r\n]/.test(other.path)) throw new Error('目标笔记路径含特殊链接字符，请先重命名后重试。');
  const label = other.title.replace(/[\[\]|\r\n]/g, ' ').trim() || '关联笔记';
  const mine = self.id === relation.sourceId ? relation.sourceEvidence : relation.targetEvidence;
  const theirs = self.id === relation.sourceId ? relation.targetEvidence : relation.sourceEvidence;
  const entry = '\n' + entryMarker + '\n- [[' + other.path.replace(/\.md$/, '') + '|' + label + ']] · ' + relation.type +
    '\n  - 关联理由：' + plain(relation.reason) + '\n  - 本条依据：' + plain(mine) + '\n  - 对方依据：' + plain(theirs) + '\n';
  const block = parts.block ? parts.block.replace(RELATIONS_END, entry + RELATIONS_END)
    : RELATIONS_START + '\n## 已建立的关联\n' + entry + RELATIONS_END;
  return current.slice(0, boundary + marker.length) + parts.thoughts + (parts.block ? '' : '\n') + block + (parts.block ? parts.after : '\n');
}
