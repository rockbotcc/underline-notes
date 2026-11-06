import type { Annotation, Article, Session } from './model';

export const PERSONAL_MARKER = '<!-- noting:personal -->';
export const PERSONAL_TEMPLATE = '\n';
export const LEGACY_PERSONAL_TEMPLATE = '## 延伸思考\n\n<!-- 在这里补充自己的理解，也可以用 [[笔记名]] 关联其他卡片。 -->';
export interface Card { id: string; path: string; title: string; createdAt: string; markdown: string }

export function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_{}\[\]<>#!|])/g, '\\$1');
}
export function imageAttachmentPath(articleId: string, annotation: Annotation): string {
  const subtype = annotation.image!.data!.slice('data:image/'.length).split(';', 1)[0];
  const extension = subtype === 'svg+xml' ? 'svg' : subtype === 'x-icon' ? 'ico' : subtype;
  return `Attachments/${articleId}/${annotation.id}.${extension}`;
}
function quote(value: string): string {
  return value.split('\n').map(line => '> ' + escapeMarkdown(line)).join('\n');
}
function shortTitle(value: string): string {
  const text = value.trim().replace(/\s+/g, ' ');
  return text.length > 48 ? text.slice(0, 48) + '…' : text;
}
function cardFileName(title: string, id: string): string {
  const slug = title.replace(/[\\/:*?"<>|#\[\]\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').replace(/^\.+|[. ]+$/g, '').slice(0, 40).trim() || '阅读卡片';
  return slug + '--' + id + '.md';
}
function cardEmbed(card: Card): string {
  return '![[' + card.path.split('/').at(-1)!.slice(0, -3) + ']]';
}
function fileLink(label: string, path: string): string {
  return '[' + escapeMarkdown(label) + '](<' + path.replace(/>/g, '%3E').replace(/</g, '%3C') + '>)';
}
function annotationContext(article: Article, annotation: Annotation): string {
  const text = article.bodyText.replace(/\s+/g, ' ');
  const exact = annotation.anchor.exact.replace(/\s+/g, ' ');
  if (!exact.trim()) return '';
  const index = text.indexOf(exact);
  let before = annotation.anchor.prefix.replace(/\s+/g, ' ');
  let after = annotation.anchor.suffix.replace(/\s+/g, ' ');
  if (index >= 0 && text.indexOf(exact, index + exact.length) < 0) {
    before = text.slice(0, index);
    after = text.slice(index + exact.length);
  }
  const segmenter = new Intl.Segmenter('zh', { granularity: 'sentence' });
  const sentences = (value: string) => Array.from(segmenter.segment(value)).filter(item => item.segment.trim());
  // A partial sentence touching the selection counts as the adjacent sentence.
  const prefix = Array.from((sentences(before).at(-1)?.segment ?? '').trimStart());
  const suffix = Array.from((sentences(after)[0]?.segment ?? '').trimEnd());
  // Share unused space with the other side; count ellipses within the 150-character budget.
  const prefixLimit = Math.min(prefix.length, Math.max(75, 150 - suffix.length));
  const suffixLimit = Math.min(suffix.length, 150 - prefixLimit);
  before = prefix.length > prefixLimit ? '…' + prefix.slice(-(prefixLimit - 1)).join('') : prefix.join('');
  after = suffix.length > suffixLimit ? suffix.slice(0, suffixLimit - 1).join('') + '…' : suffix.join('');
  return before || after ? before + exact + after : '';
}

export function articleCards(article: Article): Card[] {
  if (article.deletedAt) return [];
  const definitions: { id: string; title: string; createdAt: string; updatedAt: string; annotation?: Annotation; note: string }[] = article.annotations.map(annotation => ({
    id: annotation.id, title: shortTitle(annotation.anchor.exact), createdAt: annotation.createdAt,
    updatedAt: annotation.updatedAt, annotation, note: annotation.note,
  }));
  if (article.pageNote.trim() || article.pageNoteCard) definitions.push({
    id: article.id + '-note', title: '读后笔记 · ' + shortTitle(article.title),
    createdAt: article.createdAt, updatedAt: article.updatedAt, note: article.pageNote,
  });
  return definitions.map(definition => {
    const { id, title, createdAt, updatedAt, annotation, note } = definition;
    const lines = [
      '---', 'schema_version: 2', 'card_id: ' + id, 'article_id: ' + article.id,
      'title: ' + JSON.stringify(title), 'aliases: [' + JSON.stringify(title) + ']',
      'source_title: ' + JSON.stringify(article.title), 'source_url: ' + JSON.stringify(article.url),
      'created_at: ' + createdAt, 'updated_at: ' + updatedAt, 'tags: [noting/' + (annotation ? '摘录' : '读后笔记') + ']',
      '---', '', '# ' + escapeMarkdown(title), '',
    ];
    if (annotation) lines.push('<!-- noting:quote:start -->', '> [!quote] 摘录', quote(annotation.anchor.exact), '<!-- noting:quote:end -->', '');
    if (annotation?.image) {
      const alt = escapeMarkdown(annotation.image.alt.replace(/\s+/g, ' '));
      const url = annotation.image.data ? '../../' + imageAttachmentPath(article.id, annotation) : annotation.image.url.replace(/[<>\s]/g, character => encodeURIComponent(character));
      lines.push('<!-- noting:image:start -->', '![' + alt + '](<' + url + '>)', '<!-- noting:image:end -->', '');
    }
    lines.push('<!-- noting:note:start -->', '## 我的批注', '', note.trim().replace(/<!-- noting:/g, '&lt;!-- noting:'), '<!-- noting:note:end -->', '');
    const context = annotation && !annotation.image ? annotationContext(article, annotation) : '';
    if (context && context !== annotation?.anchor.exact) lines.push('<!-- noting:context:start -->', '> [!abstract]- 原文上下文', quote(context), '<!-- noting:context:end -->', '');
    lines.push('## 来源', '', fileLink(article.title + ' · 本地全文', '../../Articles/' + article.id + '.md#保存的正文'), '',
      escapeMarkdown(article.hostname) + ' · ' + createdAt.slice(0, 10) + ' · ' + fileLink('网页来源', article.url), '');
    const siblings = definitions.filter(item => item.id !== id);
    if (siblings.length) lines.push('## 同篇卡片', '', ...siblings.map(item => '- ' + fileLink(item.title, cardFileName(item.title, item.id))), '');
    const generated = lines.join('\n').replaceAll(PERSONAL_MARKER, '&lt;!-- noting:personal --&gt;');
    return { id, title, createdAt, path: 'Cards/' + article.id + '/' + cardFileName(title, id), markdown: generated + PERSONAL_MARKER + PERSONAL_TEMPLATE };
  });
}

export function articleMarkdown(article: Article, sessions: Session[]): string {
  const visits = sessions.filter(session => session.articleId === article.id);
  const minutes = Math.round(visits.reduce((sum, session) => sum + session.activeMs, 0) / 60000);
  const latestRead = visits.map(session => session.updatedAt).sort().at(-1);
  const lines = [
    '---', 'schema_version: 2', 'article_id: ' + article.id, 'title: ' + JSON.stringify(article.title),
    'aliases: [' + JSON.stringify(article.title) + ']', 'source_url: ' + JSON.stringify(article.url),
    'created_at: ' + article.createdAt, 'updated_at: ' + article.updatedAt,
    'reading_minutes: ' + minutes, 'reading_sessions: ' + visits.length, 'tags: [noting/文章]',
  ];
  if (latestRead) lines.push('last_read_at: ' + latestRead);
  if (article.bodyCapturedAt) lines.push('captured_at: ' + article.bodyCapturedAt);
  lines.push('---', '', '# ' + escapeMarkdown(article.title), '', '[卡片盒](../卡片盒.md) · ' + escapeMarkdown(article.hostname) + ' · 阅读 ' + minutes + ' 分钟', '');
  const cards = articleCards(article);
  if (cards.length) lines.push('## 本篇卡片', '', ...cards.flatMap(card => [cardEmbed(card), '']));
  lines.push('## 保存的正文', '', article.bodyMarkdown || (article.bodyText ? escapeMarkdown(article.bodyText) : '这条旧记录还没有保存正文。重新打开网页阅读后，可补存正文。'), '',
    '---', '', fileLink('网页来源', article.url), '');
  return lines.join('\n');
}

export function dayMarkdown(day: string, sessions: Session[], articles: Article[]): string {
  const grouped = new Map<string, Session[]>();
  for (const session of sessions.filter(item => item.day === day)) {
    grouped.set(session.articleId, [...grouped.get(session.articleId) ?? [], session]);
  }
  const lines = ['# ' + day + ' 阅读回顾', '', '[卡片盒](../卡片盒.md)', ''];
  for (const [id, visits] of grouped) {
    const article = articles.find(item => item.id === id && !item.deletedAt);
    if (!article) continue;
    const seconds = Math.round(visits.reduce((sum, visit) => sum + visit.activeMs, 0) / 1000);
    const duration = seconds < 60 ? seconds + ' 秒' : Math.round(seconds / 60) + ' 分钟';
    lines.push('## ' + escapeMarkdown(article.title), '', duration + ' · ' + visits.length + ' 次阅读 · ' + article.annotations.length + ' 条划线', '');
    const cards = articleCards(article);
    if (cards.length) lines.push(...cards.flatMap(card => [cardEmbed(card), '']));
    else if (article.bodyText) lines.push('> [!abstract] 正文预览', quote(article.bodyText.slice(0, 1200)), '');
    lines.push(fileLink('继续阅读本地全文', '../Articles/' + id + '.md#保存的正文'), '');
  }
  return lines.join('\n') + '\n';
}

export function indexMarkdown(articles: Article[], sessions: Session[]): string {
  const days = [...new Set(sessions.map(session => session.day))].sort().reverse();
  const active = articles.filter(article => !article.deletedAt).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const cards = active.flatMap(articleCards).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const lines = ['# 卡片盒', '', cards.length + ' 张卡片 · ' + active.length + ' 篇文章', '', '## 我的卡片', ''];
  if (cards.length) lines.push(...cards.flatMap(card => [cardEmbed(card), '']));
  else lines.push('划线或写下文章笔记后，你的卡片会在这里展开。', '');
  const withoutCards = active.filter(article => articleCards(article).length === 0);
  if (withoutCards.length) {
    lines.push('## 读过的文章', '');
    for (const article of withoutCards) {
      lines.push('### ' + escapeMarkdown(article.title), '');
      if (article.bodyText) lines.push(quote(article.bodyText.slice(0, 600)), '');
      lines.push(fileLink('阅读本地全文', 'Articles/' + article.id + '.md#保存的正文'), '');
    }
  }
  lines.push('## 按日回顾', '', ...days.map(day => '- [' + day + '](Daily/' + day + '.md)'), '');
  return lines.join('\n');
}

export function managedCardPart(text: string): string {
  const index = text.indexOf(PERSONAL_MARKER);
  if (index < 0) throw new Error('卡片缺少内容分界标记');
  return text.slice(0, index + PERSONAL_MARKER.length);
}
export function personalCardPart(text: string): string {
  return text.slice(managedCardPart(text).length);
}
