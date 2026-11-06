import type { Anchor } from '../../shared/model';

interface TextEntry { node: Text; start: number; end: number }
export interface TextIndex { text: string; entries: TextEntry[] }

export function buildTextIndex(root: HTMLElement): TextIndex {
  const entries: TextEntry[] = [];
  let text = '';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || parent.closest('script, style, noscript, textarea, input, select, [contenteditable]:not([contenteditable="false"]), [data-noting-root], [hidden], [aria-hidden="true"]')) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    entries.push({ node, start: text.length, end: text.length + node.length });
    text += node.data;
  }
  return { text, entries };
}

export function anchorFromRange(range: Range, index: TextIndex): Anchor | null {
  const selected = index.entries.filter(entry => range.intersectsNode(entry.node));
  if (!selected.length) return null;
  const first = selected[0];
  const last = selected[selected.length - 1];
  const start = first.start + (range.startContainer === first.node ? range.startOffset : 0);
  const end = last.start + (range.endContainer === last.node ? range.endOffset : last.node.length);
  const exact = index.text.slice(start, end);
  if (!exact.trim() || exact.length > 50000) return null;
  return { exact, prefix: index.text.slice(Math.max(0, start - 48), start), suffix: index.text.slice(end, end + 48), start, end };
}

export function locateText(text: string, anchor: Anchor): number | null {
  const positions: number[] = [];
  let position = text.indexOf(anchor.exact);
  while (position !== -1) {
    positions.push(position);
    position = text.indexOf(anchor.exact, position + 1);
  }
  if (positions.length === 1) return positions[0];
  const contextual = positions.filter(start =>
    (!anchor.prefix || text.slice(Math.max(0, start - anchor.prefix.length), start) === anchor.prefix) &&
    (!anchor.suffix || text.slice(start + anchor.exact.length, start + anchor.exact.length + anchor.suffix.length) === anchor.suffix),
  );
  if (contextual.length === 1) return contextual[0];
  return null;
}

export function rangeFromAnchor(anchor: Anchor, index: TextIndex): Range | null {
  const start = locateText(index.text, anchor);
  if (start === null) return null;
  const end = start + anchor.exact.length;
  const first = index.entries.find(entry => entry.start <= start && entry.end > start);
  const last = index.entries.find(entry => entry.start < end && entry.end >= end);
  if (!first || !last) return null;
  const range = document.createRange();
  range.setStart(first.node, start - first.start);
  range.setEnd(last.node, end - last.start);
  return range;
}
