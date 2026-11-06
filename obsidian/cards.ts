import { normalizeUrl } from '../shared/model.ts';
import { readCardNote } from '../shared/note-sync.ts';
import { splitRelations } from './relations.ts';
import { splitTags, manualTags, matchesTag } from './tags.ts';

export const MARKER = '<!-- noting:personal -->';
export interface Memo {
  path: string; id: string; articleId: string; title: string; source: string; url: string; faviconUrl?: string; publishedDate?: string;
  createdAt: string; updatedAt: string; quote: string; note: string; context: string; personal: string; tail: string; tags: string[];
  aiTags?: string[]; tagVersion?: string;
  image?: string;
}
export interface SourceGroup {
  key: string; title: string; url: string; articleId: string; updatedAt: string; memos: Memo[];
}

export function sourceKey(memo: Memo): string {
  if (memo.articleId) return 'article:' + memo.articleId;
  if (memo.url) {
    try { return 'url:' + normalizeUrl(memo.url); } catch { return 'invalid:' + memo.url; }
  }
  return 'local';
}

// Use the stored article identity, never a title or domain that could merge unrelated pages.
export function groupMemosBySource(memos: Memo[]): SourceGroup[] {
  const groups = new Map<string, SourceGroup>();
  const ordered = [...memos].sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt) || a.id.localeCompare(b.id));
  for (const memo of ordered) {
    const key = sourceKey(memo);
    let group = groups.get(key);
    if (!group) {
      group = { key, title: key === 'local' ? '无来源的随手记' : memo.source || memo.url || '未命名来源', url: memo.url, articleId: memo.articleId, updatedAt: memo.updatedAt || memo.createdAt, memos: [] };
      groups.set(key, group);
    }
    group.memos.push(memo);
  }
  // Older cards do not contain reliable document positions; use recording order.
  for (const group of groups.values()) group.memos.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return [...groups.values()];
}

export function filterSourceGroups(groups: SourceGroup[], query: string): SourceGroup[] {
  const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  return groups.filter(group => {
    const text = [group.title, group.url, ...group.memos.flatMap(memo => [memo.quote, memo.note, memo.personal, ...memo.tags])].join('\n').toLocaleLowerCase();
    return words.every(word => text.includes(word));
  });
}

export function memoImage(memo: Memo): string {
  if (memo.image) return memo.image;
  // Let Obsidian resolve local attachments, wiki embeds and remote Markdown images.
  const text = [memo.note, memo.personal].join('\n').replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, '');
  const embeds = text.matchAll(/!\[\[([^\]\n]+)\]\]|!\[[^\]\n]*\]\((?:<[^>\n]+>|[^\s()]+(?:\([^()]*\)[^\s()]*)*)(?:\s+"[^"\n]*")?\)/g);
  for (const match of embeds) {
    if (!match[1] || /\.(?:png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(match[1].split('|')[0].trim())) return match[0];
  }
  return '';
}

export function memoExcerpt(memo: Memo): string {
  return [memo.note, memo.personal, memo.quote].filter(Boolean).join(' · ')
    .replace(/!\[\[[^\]]+\]\]|!\[[^\]]*\]\([^\n]*?\)/g, '')
    .replace(/[#>*_`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 160) || memo.title;
}

function section(text: string, name: string): string {
  const start = '<!-- noting:' + name + ':start -->';
  const end = '<!-- noting:' + name + ':end -->';
  const index = text.indexOf(start);
  if (index < 0) return '';
  const last = text.indexOf(end, index + start.length);
  return last < 0 ? '' : text.slice(index + start.length, last).trim();
}
function unquote(text: string): string {
  return text.replace(/^> \[![^\n]+\n/, '').split('\n').map(line => line.replace(/^> ?/, '').replace(/\\([\\`*_{}\[\]<>#!|])/g, '$1')).join('\n').trim();
}
export function thoughts(tail: string): string {
  const parts = splitRelations(splitTags(tail).body);
  return (parts.thoughts.replace(/^\s*## 延伸思考\s*/, '').replace('<!-- 在这里补充自己的理解，也可以用 [[笔记名]] 关联其他卡片。 -->', '') + parts.after).trim();
}
export function parseMemo(path: string, text: string, metadata: Record<string, unknown>): Memo | null {
  if (typeof metadata.card_id !== 'string' || !text.includes(MARKER)) return null;
  const get = (key: string) => typeof metadata[key] === 'string' ? metadata[key] as string : '';
  const tail = text.slice(text.indexOf(MARKER) + MARKER.length);
  const personal = thoughts(tail);
  const note = readCardNote(text);
  const quote = unquote(section(text, 'quote'));
  const context = unquote(section(text, 'context'));
  const automatic = splitTags(tail);
  const tags = [...new Set([...manualTags({ note, personal }), ...automatic.tags])];
  return { path, id: get('card_id'), articleId: get('article_id'), title: get('title'), source: get('source_title'), url: get('source_url'), faviconUrl: get('source_favicon'), publishedDate: get('published_date'), createdAt: get('created_at'), updatedAt: get('updated_at') || get('created_at'), quote, note, context, personal, tail, tags, aiTags: automatic.tags, tagVersion: automatic.version, image: section(text, 'image') || undefined };
}
export function updateThoughts(current: string, expectedTail: string, next: string): string {
  const index = current.indexOf(MARKER);
  if (index < 0) throw new Error('卡片格式已变化，请重新打开后再保存。');
  const boundary = index + MARKER.length;
  const tail = current.slice(boundary);
  if (thoughts(tail) !== thoughts(expectedTail)) throw new Error('这张卡片刚刚有新的修改。你的输入已保留，请复制后重新打开。');
  if (next.includes('<!-- noting:')) throw new Error('想法中不能包含「划线笔记 / Underline Notes」内容分界标记。');
  const automatic = splitTags(tail);
  const { block } = splitRelations(automatic.body);
  return current.slice(0, boundary) + '\n' + [next.trim(), block, automatic.block].filter(Boolean).map(part => '\n' + part + '\n').join('');
}
export function filterMemos(memos: Memo[], query: string, tag: string, mode: string): Memo[] {
  const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  return memos.filter(memo => (!tag || memo.tags.some(candidate => matchesTag(candidate, tag))) && (mode !== 'inbox' || (!memo.note.trim() && !memo.personal.trim())) && words.every(word => [memo.quote, memo.note, memo.personal, memo.source, ...memo.tags].join('\n').toLocaleLowerCase().includes(word)));
}
export function reviewMemos(memos: Memo[], day: string, limit = 8): Memo[] {
  const hash = (text: string) => { let value = 2166136261; for (const char of text) value = Math.imul(value ^ char.charCodeAt(0), 16777619); return value >>> 0; };
  return [...memos].sort((a, b) => hash(day + a.id) - hash(day + b.id) || a.id.localeCompare(b.id)).slice(0, limit);
}
export function localMemo(text: string, id: string, now: string): string {
  const title = text.trim().split('\n')[0].replace(/^#+\s*/, '').slice(0, 48) || '随手记';
  return ['---', 'schema_version: 2', 'card_id: ' + id, 'title: ' + JSON.stringify(title), 'source_title: "随手记"', 'created_at: ' + now, 'tags: [noting/想法]', '---', '', '# ' + title, '', MARKER, '', text.trim(), ''].join('\n');
}
