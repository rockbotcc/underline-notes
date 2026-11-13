import type { Annotation, Article } from '../../shared/model.ts';

function literal(value: string): string { return value.replace(/([\\`*_{}\[\]<>#!|])/g, '\\$1'); }
// Do not allow note text to introduce block IDs or close our version container.
function noteMarkdown(value: string): string {
  return value.replace(/\{:/g, '\\{:').replace(/\{\{\{/g, '\\{\\{\\{').replace(/\}\}\}/g, '\\}\\}\\}');
}
export function siyuanContent(article: Article, annotation?: Annotation): string {
  const note = (annotation ? annotation.note : article.pageNote).trim();
  const quote = annotation ? annotation.image
    ? `${literal(annotation.image.alt || '图片')}\n\n[原图链接](<${annotation.image.url.replace(/[<>]/g, encodeURIComponent)}>)（图片文件尚未上传）`
    : annotation.anchor.exact.split('\n').map(line => '> ' + literal(line)).join('\n') : '';
  return [noteMarkdown(note), quote, `来源：[${literal(article.title)}](<${article.url.replace(/[<>]/g, encodeURIComponent)}>)`,
    `摘录时间：${annotation?.createdAt || article.createdAt}`].filter(Boolean).join('\n\n');
}
export function siyuanTitle(article: Article, annotation?: Annotation): string {
  const title = Array.from((annotation?.image?.alt || annotation?.anchor.exact || article.title)
    .replace(/[\u0000-\u001f]/g, ' ').trim()).slice(0, 80).join('').trim();
  return !title || title === '.' || title === '..' ? '阅读笔记' : title;
}
export async function contentHash(content: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export function versionMarkdown(content: string, id: string, hash: string, timestamp: string): string {
  return `{{{row\n### 更新 ${timestamp}\n\n${content}\n}}}\n{: id="${id}" custom-underline-hash="${hash}"}`;
}
export function hasVersion(markdown: string, id: string, hash: string): boolean {
  // Both attributes must belong to the same IAL, not merely occur somewhere in the document.
  return [...markdown.matchAll(/\{:[^\n]*?\}/g)].some(([ial]) => ial.includes(`id="${id}"`) && ial.includes(`custom-underline-hash="${hash}"`));
}
