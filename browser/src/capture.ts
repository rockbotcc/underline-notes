import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';

export function captureArticle(source: Document): { bodyText: string; bodyMarkdown: string } {
  const clone = source.cloneNode(true) as Document;
  clone.querySelectorAll('[data-noting-root]').forEach(node => node.remove());
  const article = new Readability(clone).parse();
  if (!article?.content) return { bodyText: '', bodyMarkdown: '' };
  const body = new DOMParser().parseFromString(article.content, 'text/html');
  body.querySelectorAll('script, style, iframe, form, input, button, svg, audio, video, img').forEach(node => node.remove());
  for (const link of body.querySelectorAll('a')) {
    try {
      const url = new URL(link.getAttribute('href') || '', source.URL);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported link');
      link.setAttribute('href', url.href);
    } catch { link.replaceWith(...link.childNodes); }
  }
  const converter = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
  // Extract paragraphs separately so legacy plain-text readers also keep the structure.
  const paragraphs = [...body.querySelectorAll('h1, h2, h3, h4, h5, h6, p, pre, li, blockquote')]
    .filter(node => !node.parentElement?.closest('pre, li, blockquote'))
    .map(node => node.textContent?.trim()).filter(Boolean);
  return {
    bodyText: (paragraphs.join('\n\n') || article.textContent || '').slice(0, 1000000),
    bodyMarkdown: converter.turndown(body.body).slice(0, 1000000),
  };
}
