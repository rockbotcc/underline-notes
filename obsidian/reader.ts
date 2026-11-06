export interface QuoteContext { prefix: string; suffix: string }

function compact(text: string): string { return text.replace(/\s+/g, ''); }

export function contextForQuote(context: string, quote: string): QuoteContext | undefined {
  const text = compact(context), exact = compact(quote);
  const start = text.indexOf(exact);
  if (!exact || start < 0 || text.indexOf(exact, start + 1) >= 0) return;
  return { prefix: text.slice(0, start).replace(/^…/, ''), suffix: text.slice(start + exact.length).replace(/…$/, '') };
}

// Rendering changes whitespace and splits text across emphasis, links and paragraphs.
// Map the whitespace-insensitive match back to the original DOM text offsets.
export function locateReaderQuote(text: string, quote: string, contexts: QuoteContext[] = []): { start: number; end: number } | null {
  const exact = compact(quote);
  if (!exact) return null;
  const offsets: number[] = [], chars: string[] = [];
  for (let index = 0; index < text.length; index++) {
    if (!/\s/.test(text[index])) { offsets.push(index); chars.push(text[index]); }
  }
  const content = chars.join(''), matches: number[] = [];
  for (let start = content.indexOf(exact); start >= 0; start = content.indexOf(exact, start + 1)) matches.push(start);
  let match = matches.length === 1 ? matches[0] : undefined;
  if (match === undefined) {
    for (const context of contexts) {
      const prefix = compact(context.prefix), suffix = compact(context.suffix);
      if (!prefix && !suffix) continue;
      const candidates = matches.filter(start => content.slice(0, start).endsWith(prefix) && content.slice(start + exact.length).startsWith(suffix));
      if (candidates.length === 1) { match = candidates[0]; break; }
    }
  }
  return match === undefined ? null : { start: offsets[match], end: offsets[match + exact.length - 1] + 1 };
}

export function highlightReaderQuote(root: HTMLElement, quote: string, contexts: QuoteContext[] = []): HTMLElement[] {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: node => node.parentElement?.closest('script, style, button, [hidden], [aria-hidden="true"]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const entries: { node: Text; start: number; end: number }[] = [];
  let text = '';
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    entries.push({ node, start: text.length, end: text.length + node.length });
    text += node.data;
  }
  const match = locateReaderQuote(text, quote, contexts);
  if (!match) return [];
  const marks: HTMLElement[] = [];
  for (const entry of entries) {
    if (entry.end <= match.start || entry.start >= match.end) continue;
    const start = Math.max(0, match.start - entry.start), end = Math.min(entry.node.length, match.end - entry.start);
    if (end < entry.node.length) entry.node.splitText(end);
    const selected = start ? entry.node.splitText(start) : entry.node;
    const mark = doc.createElement('mark');
    mark.className = 'nt-reader-highlight';
    selected.replaceWith(mark); mark.append(selected); marks.push(mark);
  }
  return marks;
}
