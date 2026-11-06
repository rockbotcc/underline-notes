import { articleId, COLORS, normalizeUrl, checkedImage, type Article, type Backup, type Session } from '../../shared/model.ts';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('备份结构无效');
  return value as Record<string, unknown>;
}

function string(value: unknown, limit = 1000000): string {
  if (typeof value !== 'string' || value.length > limit) throw new Error('备份字段无效或过长');
  return value;
}

function date(value: unknown): string {
  const text = string(value, 40);
  if (!Number.isFinite(Date.parse(text))) throw new Error('备份日期无效');
  return new Date(text).toISOString();
}

function number(value: unknown, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) throw new Error('备份数值无效');
  return value;
}

export async function validateBackup(input: unknown): Promise<Backup> {
  const data = object(input);
  if (data.schemaVersion !== 1 || !Array.isArray(data.articles) || !Array.isArray(data.sessions)) throw new Error('不支持此备份格式');
  const articles: Article[] = [];
  const seenArticles = new Set<string>();
  const seenAnnotations = new Set<string>();
  for (const raw of data.articles) {
    const value = object(raw);
    const url = normalizeUrl(string(value.url, 10000));
    const id = await articleId(url);
    if (value.id !== id || seenArticles.has(id)) throw new Error('文章 ID 无效或重复');
    seenArticles.add(id);
    if (!Array.isArray(value.annotations)) throw new Error('缺少划线数据');
    const annotations = value.annotations.map(rawAnnotation => {
      const annotation = object(rawAnnotation);
      const anchor = object(annotation.anchor);
      const annotationId = string(annotation.id, 80);
      if (!/^h_[a-f0-9-]+$/.test(annotationId) || seenAnnotations.has(annotationId)) throw new Error('划线 ID 无效或重复');
      seenAnnotations.add(annotationId);
      if (!COLORS.includes(annotation.color as typeof COLORS[number])) throw new Error('高亮颜色无效');
      const exact = string(anchor.exact, 50000);
      const start = number(anchor.start, 100000000);
      const end = number(anchor.end, 100000000);
      if (!exact.trim() || !Number.isInteger(start) || !Number.isInteger(end) || end - start !== exact.length) throw new Error('划线位置无效');
      return {
        id: annotationId,
        anchor: { exact, prefix: string(anchor.prefix, 200), suffix: string(anchor.suffix, 200), start, end },
        ...(annotation.image !== undefined ? { image: checkedImage(annotation.image) } : {}),
        color: annotation.color as typeof COLORS[number],
        note: string(annotation.note, 100000),
        createdAt: date(annotation.createdAt),
        updatedAt: date(annotation.updatedAt),
      };
    });
    articles.push({
      id, url, hostname: new URL(url).hostname,
      title: string(value.title, 2000), pageNote: string(value.pageNote, 100000), bodyText: string(value.bodyText),
      ...(value.pageNoteCard === true ? { pageNoteCard: true } : {}),
      ...(value.bodyMarkdown !== undefined ? { bodyMarkdown: string(value.bodyMarkdown) } : {}),
      ...(value.bodyCapturedAt ? { bodyCapturedAt: date(value.bodyCapturedAt) } : {}),
      createdAt: date(value.createdAt), updatedAt: date(value.updatedAt), annotations,
      ...(value.deletedAt ? { deletedAt: date(value.deletedAt) } : {}),
    });
  }
  const seenSessions = new Set<string>();
  const sessions: Session[] = data.sessions.map(raw => {
    const value = object(raw);
    const id = string(value.id, 100);
    const article = string(value.articleId, 40);
    const day = string(value.day, 10);
    if (!/^[a-f0-9-]+$/.test(id) || seenSessions.has(id) || !seenArticles.has(article)) throw new Error('阅读记录 ID 无效');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || new Date(day).toISOString().slice(0, 10) !== day) throw new Error('阅读日期无效');
    seenSessions.add(id);
    return { id, articleId: article, day, startedAt: date(value.startedAt), updatedAt: date(value.updatedAt), activeMs: number(value.activeMs, 86400000), progress: number(value.progress, 100) };
  });
  return { schemaVersion: 1, exportedAt: new Date().toISOString(), articles, sessions };
}
