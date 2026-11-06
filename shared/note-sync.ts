// The note is editable in both apps; everything else before the personal marker
// is generated reference material. Keep this parser shared with Obsidian.
const START = '<!-- noting:note:start -->';
const END = '<!-- noting:note:end -->';
const PERSONAL = '<!-- noting:personal -->';
export const DELETE_MARKER_SUFFIX = '.noting-delete';

function noteRange(text: string): [number, number] | null {
  const boundary = text.indexOf(PERSONAL);
  if (boundary < 0) throw new Error('卡片缺少内容分界标记');
  text = text.slice(0, boundary);
  const start = text.indexOf(START);
  const end = text.indexOf(END);
  if (start < 0 && end < 0) return null; // older cards without a note
  if (start < 0 || end < start || text.indexOf(START, start + START.length) >= 0 || text.indexOf(END, end + END.length) >= 0) {
    throw new Error('笔记分界标记已变化，请恢复标记后重试。');
  }
  return [start, end + END.length];
}

export function readCardNote(text: string): string {
  const range = noteRange(text);
  return range ? text.slice(range[0] + START.length, range[1] - END.length)
    .replace(/^\s*## 我的批注\s*/, '').trim().replaceAll('&lt;!-- noting:', '<!-- noting:') : '';
}

export function replaceCardNote(text: string, note: string): string {
  const range = noteRange(text);
  const block = START + '\n## 我的批注\n\n' + note.trim().replaceAll('<!-- noting:', '&lt;!-- noting:') + '\n' + END;
  if (range) return text.slice(0, range[0]) + block + text.slice(range[1]);
  const boundary = text.indexOf(PERSONAL);
  const match = /<!-- noting:context:start -->|^## 来源$/m.exec(text.slice(0, boundary));
  if (boundary < 0 || !match) throw new Error('卡片格式已变化，请重新打开后再保存。');
  return text.slice(0, match.index) + block + '\n\n' + text.slice(match.index);
}

export function cardStructure(text: string): string {
  const boundary = text.indexOf(PERSONAL);
  if (boundary < 0) throw new Error('卡片缺少内容分界标记');
  const managed = text.slice(0, boundary + PERSONAL.length);
  const range = noteRange(managed);
  return range ? managed.slice(0, range[0]) + managed.slice(range[1]).replace(/^\r?\n(?:\r?\n)?/, '') : managed;
}

export function mergeNote(base: string, browser: string, obsidian: string): { note: string; conflict: boolean } {
  if (browser === obsidian || obsidian === base) return { note: browser, conflict: false };
  if (browser === base) return { note: obsidian, conflict: false };
  return { note: browser, conflict: true };
}

export function updateCardNote(current: string, expected: string, next: string): string {
  if (readCardNote(current) !== expected) throw new Error('这条笔记刚刚有新的修改。你的输入已保留，请复制后重新打开合并。');
  if (next.length > 100000) throw new Error('笔记不能超过 100000 个字符。');
  return replaceCardNote(current, next);
}
