import type { Annotation, Article } from '../../shared/model.ts';

export interface FlomoJob {
  key: string;
  articleId: string;
  version: string;
  content: string;
  sentContent?: string;
  error?: string;
  retryAfter?: number;
}

export function checkedFlomoUrl(value: string): string {
  try {
    const url = new URL(value.trim());
    if (url.protocol === 'https:' && ['flomoapp.com', 'www.flomoapp.com'].includes(url.hostname) &&
      !url.port && !url.username && !url.password && !url.search && !url.hash && /^\/iwh\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\/?$/.test(url.pathname)) return url.href;
  } catch { /* Use a fixed error so the secret URL never reaches logs or web pages. */ }
  throw new Error('请填写 flomo 提供的完整 HTTPS API URL（https://flomoapp.com/iwh/…/…/）。');
}

export function flomoContent(article: Article, annotation?: Annotation): string {
  const note = (annotation ? annotation.note : article.pageNote).trim();
  const quote = annotation
    ? annotation.image
      ? [annotation.image.alt.trim(), annotation.image.url].filter(Boolean).join('\n')
      : `“${annotation.anchor.exact.trim()}”`
    : '';
  return [
    note,
    quote,
    `${article.title} #划线笔记/${new URL(article.url).hostname}`,
    article.url,
  ].filter(Boolean).join('\n');
}

export async function postFlomo(apiUrl: string, content: string, request: typeof fetch = fetch): Promise<void> {
  const url = checkedFlomoUrl(apiUrl);
  if (content.length > 5000) throw new Error('笔记连同摘录和来源超过 5000 字，请缩短后重新保存。完整内容仍保存在浏览器。');
  let response: Response;
  try {
    response = await request(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }),
      credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(20000),
    });
  } catch { throw new Error('flomo 网络请求失败或超时，将稍后重试；若 flomo 已收到记录，重试可能重复。'); }
  if (!response.ok) throw new Error(`flomo 写入失败（HTTP ${response.status}），请检查 API URL 或稍后重试。`);
  let result: { code?: unknown } | null;
  try { result = await response.json(); }
  catch { throw new Error('flomo 返回了无法识别的响应，请稍后重试。'); }
  if (result?.code !== 0) throw new Error('flomo 未接受笔记，请检查 API URL、会员权限及调用额度后重试。');
}
