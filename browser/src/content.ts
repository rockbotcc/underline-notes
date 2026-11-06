import { isProbablyReaderable } from '@mozilla/readability';
import { captureArticle } from './capture';
import { buildTextIndex, anchorFromRange, rangeFromAnchor } from './anchors';
import { rpc } from './rpc';
import { DEFAULT_SETTINGS, COLORS, localDay, normalizeUrl, obsidianUrl, checkedImage, type ImageReference, type Article, type Annotation, type Anchor, type Color, type Settings, type PageInfo } from '../../shared/model';
import css from './content.css';

const highlightColors = { yellow: '#f8df83', green: '#c3dfad', blue: '#bbdaf2', pink: '#f1c3d0' };
const host = document.createElement('div');
host.dataset.notingRoot = '';
host.id = 'noting-extension';
const shadow = host.attachShadow({ mode: 'open' });
const style = document.createElement('style');
style.textContent = css;
shadow.append(style);
document.documentElement.append(host);
const highlightStyle = document.createElement('style');
highlightStyle.dataset.notingRoot = '';
highlightStyle.textContent = COLORS.map(color => `::highlight(noting-${color}) { background-color: ${highlightColors[color]}; color: #20251b; }`).join('\n');
document.documentElement.append(highlightStyle);

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

function button(label: string, action: () => void | Promise<void>, className = '') {
  const node = element('button', className, label);
  node.type = 'button';
  node.addEventListener('click', () => {
    Promise.resolve(action()).catch(error => toast(error instanceof Error ? error.message : String(error), true));
  });
  return node;
}

function noteView(text: string, label: string, edit: () => void, className = '') {
  const view = element('div', 'note-view ' + className);
  const content = element('p', 'note-text' + (text ? '' : ' muted'), text || '还没有笔记，双击这里开始记录。');
  content.addEventListener('dblclick', edit);
  const pencil = button('', edit, 'edit-note');
  pencil.setAttribute('aria-label', label);
  pencil.title = label;
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'm16 3 5 5-12 12-6 1 1-6L16 3Zm-2 2 5 5');
  icon.append(path);
  pencil.append(icon);
  view.append(content, pencil);
  return view;
}

let currentUrl = location.href;
let article: Article | null = null;
let settings: Settings = DEFAULT_SETTINGS;
let excluded = false;
let ready = false;
let panelOpen = false;
let selectionAnchor: Anchor | null = null;
let selectionRect: DOMRect | null = null;
let ranges = new Map<string, Range>();
let cachedBody: string | undefined;
let publishedDate: string | undefined;
let cachedMarkdown: string | undefined;
let bodyAttempted = false;
let pageDraft: string | undefined;
let pageDraftBase: string | undefined;
let pageEditing = false;
let editorDraft = false;
let selectedColor: Color = 'yellow';
let savingSelection = false;
let imageTarget: HTMLImageElement | null = null;
let renderTimer: ReturnType<typeof setTimeout>;
let toastTimer: ReturnType<typeof setTimeout>;
let outputStatus: { connected: boolean; vaultName: string; pending: boolean; error: string } | undefined;

async function refreshOutputStatus(announce = false) {
  const url = currentUrl;
  const state = await rpc<NonNullable<typeof outputStatus>>({ type: 'PAGE_OUTPUT_STATUS', page: page() });
  if (url !== currentUrl) return;
  outputStatus = state;
  if (panelOpen) renderPanel();
  if (announce) toast(outputMessage(), Boolean(state.error));
}

function outputMessage() {
  if (!outputStatus?.connected) return '已保存在浏览器；连接笔记文件夹后可自动写入';
  if (outputStatus.error) return '同步需要处理：' + outputStatus.error;
  if (outputStatus.pending) return '已保存在浏览器，正在等待写入笔记文件夹';
  return `已写入笔记文件夹 · ${outputStatus.vaultName}`;
}

const toolbar = element('div', 'toolbar');
toolbar.hidden = true;
toolbar.setAttribute('role', 'toolbar');
toolbar.setAttribute('aria-label', '划线工具');
toolbar.addEventListener('pointerdown', event => event.preventDefault());
for (const color of COLORS) {
  const node = button('', async () => { await saveSelection(color); }, 'color');
  node.dataset.color = color;
  node.setAttribute('aria-label', { yellow: '黄色划线', green: '绿色划线', blue: '蓝色划线', pink: '粉色划线' }[color]);
  node.title = node.getAttribute('aria-label')!;
  toolbar.append(node);
}
toolbar.append(element('span', 'divider'));
toolbar.append(button('记笔记', () => {
  if (!selectionAnchor) return;
  openEditor({ id: 'h_' + crypto.randomUUID(), anchor: selectionAnchor, color: selectedColor, note: '', createdAt: '', updatedAt: '' }, selectionRect);
}));
toolbar.append(button('☰', () => togglePanel(true)));
toolbar.lastElementChild!.setAttribute('aria-label', '查看本页笔记');
const imageToolbar = element('div', 'toolbar image-toolbar');
imageToolbar.hidden = true;
imageToolbar.setAttribute('role', 'toolbar');
imageToolbar.setAttribute('aria-label', '划线笔记图片工具');
imageToolbar.append(element('span', 'toolbar-label', '划线笔记'), element('span', 'divider'));
const collectImage = button('收录图片', async () => {
  if (!imageTarget || savingSelection) return;
  const annotation = imageAnnotation(imageTarget);
  savingSelection = true;
  try { await persist(annotation); } finally { savingSelection = false; }
});
const openImageNote = button('记笔记', () => {
  if (!imageTarget) return;
  const saved = savedImageAnnotation(imageTarget);
  openEditor(saved ?? imageAnnotation(imageTarget), imageTarget.getBoundingClientRect(), !saved?.note);
});
imageToolbar.append(collectImage, openImageNote);
const editor = element('section', 'editor');
editor.hidden = true;
editor.setAttribute('role', 'dialog');
editor.setAttribute('aria-label', '编辑划线笔记');
const panel = element('aside', 'panel');
panel.hidden = true;
panel.setAttribute('aria-label', '划线笔记 / Underline Notes 当前文章');
const notification = element('div', 'toast');
notification.hidden = true;
notification.setAttribute('role', 'status');
shadow.append(toolbar, imageToolbar, editor, panel, notification);

function imageAnnotation(image: HTMLImageElement): Annotation {
  const reference = checkedImage({ url: image.currentSrc || image.src, alt: image.alt.slice(0, 2000) });
  const exact = reference.alt.trim() || '网页图片';
  return { id: 'h_' + crypto.randomUUID(), anchor: { exact, prefix: '', suffix: '', start: 0, end: exact.length }, image: reference, color: selectedColor, note: '', createdAt: '', updatedAt: '' };
}

function savedImageAnnotation(image: HTMLImageElement) {
  const url = image.currentSrc || image.src;
  const matches = article?.annotations.filter(item => item.image?.url === url).reverse();
  // Older versions allowed multiple records for one image. Prefer a written note.
  return matches?.find(item => item.note.trim()) ?? matches?.[0];
}

function imagePreview(reference: ImageReference): HTMLElement {
  const figure = element('figure', 'image-preview');
  const image = element('img');
  image.alt = reference.alt || '网页图片';
  image.referrerPolicy = 'no-referrer';
  const fallback = element('a', 'muted', '图片无法预览，打开原图 ↗');
  fallback.href = reference.url;
  fallback.target = '_blank';
  fallback.rel = 'noopener noreferrer';
  fallback.hidden = true;
  image.addEventListener('error', () => { image.hidden = true; fallback.hidden = false; });
  image.src = reference.data || reference.url;
  figure.append(image, fallback);
  return figure;
}

function findImage(annotation: Annotation): HTMLImageElement | undefined {
  return annotation.image ? [...document.images].find(image => image.currentSrc === annotation.image!.url || image.src === annotation.image!.url) : undefined;
}

function toast(message: string, error = false) {
  notification.textContent = message;
  notification.className = 'toast' + (error ? ' error' : '');
  notification.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { notification.hidden = true; }, error ? 7000 : 2500);
}

function page(withBody = false): PageInfo {
  if (withBody && !bodyAttempted) {
    bodyAttempted = true;
    try {
      const captured = captureArticle(document);
      cachedBody = captured.bodyText;
      cachedMarkdown = captured.bodyMarkdown;
      publishedDate = captured.publishedDate;
    } catch { cachedBody = ''; cachedMarkdown = ''; }
  }
  return { url: currentUrl, publishedDate, title: document.title.slice(0, 2000) || new URL(currentUrl).hostname, bodyText: withBody ? cachedBody : '', bodyMarkdown: withBody ? cachedMarkdown : '' };
}

async function refresh() {
  const url = currentUrl;
  const result = await rpc<{ article: Article | null; settings: Settings; excluded: boolean }>({ type: 'GET_PAGE', page: page() });
  if (url !== currentUrl) return;
  article = result.article;
  settings = result.settings;
  excluded = result.excluded;
  ready = true;
  if (excluded) { toolbar.hidden = true; imageToolbar.hidden = true; editor.hidden = true; }
  restoreHighlights();
  if (panelOpen) renderPanel();
  void refreshOutputStatus().catch(() => undefined);
}

function restoreHighlights() {
  if (!CSS.highlights) return;
  ranges = new Map();
  for (const color of COLORS) CSS.highlights.delete('noting-' + color);
  if (!article || excluded || !document.body) return;
  const index = buildTextIndex(document.body);
  const groups = Object.fromEntries(COLORS.map(color => [color, new Highlight()])) as Record<Color, Highlight>;
  for (const annotation of article.annotations) {
    if (annotation.image) continue;
    const range = rangeFromAnchor(annotation.anchor, index);
    if (range) { ranges.set(annotation.id, range); groups[annotation.color].add(range); }
  }
  for (const color of COLORS) CSS.highlights.set('noting-' + color, groups[color]);
}

function positionFloating(node: HTMLElement, rect: DOMRect | null) {
  const width = node.offsetWidth;
  const height = node.offsetHeight;
  const left = rect ? rect.left + rect.width / 2 - width / 2 : innerWidth / 2 - width / 2;
  const above = (rect?.top ?? 100) - height - 10;
  const top = above >= 8 ? above : (rect?.bottom ?? 100) + 10;
  node.style.left = Math.max(8, Math.min(innerWidth - width - 8, left)) + 'px';
  node.style.top = Math.max(8, Math.min(innerHeight - height - 8, top)) + 'px';
}

async function persist(annotation: Annotation, expectedNote = '') {
  const url = currentUrl;
  const result = await rpc<Article>({ type: 'SAVE_ANNOTATION', page: page(true), annotation, expectedNote });
  if (url !== currentUrl) return;
  article = result;
  toolbar.hidden = true;
  imageToolbar.hidden = true;
  editor.hidden = true;
  editorDraft = false;
  window.getSelection()?.removeAllRanges();
  restoreHighlights();
  if (panelOpen) renderPanel();
  toast('已保存在浏览器');
  void refreshOutputStatus(true).catch(() => undefined);
}

async function saveSelection(color: Color) {
  if (!selectionAnchor || savingSelection) return;
  savingSelection = true;
  selectedColor = color;
  const annotation: Annotation = { id: 'h_' + crypto.randomUUID(), anchor: selectionAnchor, color, note: '', createdAt: '', updatedAt: '' };
  try {
    await persist(annotation);
    selectionAnchor = null;
  } finally { savingSelection = false; }
}

function closeEditor(): boolean {
  if (editorDraft && !window.confirm('这条笔记还没保存，放弃修改？')) return false;
  editor.hidden = true;
  editorDraft = false;
  return true;
}

function openEditor(annotation: Annotation, rect: DOMRect | null = null, editing = true) {
  if (!editor.hidden && !closeEditor()) return;
  toolbar.hidden = true;
  imageToolbar.hidden = true;
  editor.replaceChildren();
  const header = element('header');
  const label = annotation.image ? '图片笔记' : '划线笔记';
  editor.setAttribute('aria-label', (editing ? '编辑' : '查看') + label);
  header.append(element('h3', '', label), button('×', () => { closeEditor(); }));
  header.lastElementChild!.setAttribute('aria-label', '关闭笔记编辑器');
  if (!editing) {
    editor.append(header);
    if (annotation.image) editor.append(imagePreview(annotation.image));
    editor.append(noteView(annotation.note, '编辑笔记', () => openEditor(annotation, rect)));
    editor.hidden = false;
    editorDraft = false;
    positionFloating(editor, rect);
    editor.querySelector<HTMLButtonElement>('.edit-note')?.focus();
    return;
  }
  const input = element('textarea');
  input.placeholder = annotation.image ? '这张图片表达了什么？写下你的理解…' : '可以先用自己的话复述原文，再补充理解或评论。支持 Markdown。';
  input.setAttribute('aria-label', label);
  input.value = annotation.note;
  input.addEventListener('input', () => { editorDraft = true; });
  let color = annotation.color;
  const colors = element('div', 'colors');
  for (const option of COLORS) {
    const node = button('', () => {
      color = option;
      editorDraft = true;
      for (const child of colors.children) child.setAttribute('aria-pressed', String((child as HTMLElement).dataset.color === color));
    }, 'color');
    node.dataset.color = option;
    node.setAttribute('aria-label', option);
    node.setAttribute('aria-pressed', String(option === color));
    colors.append(node);
  }
  const actions = element('div', 'actions');
  if (article?.annotations.some(item => item.id === annotation.id)) {
    actions.append(button(annotation.image ? '删除图片笔记' : '删除笔记', async () => {
      const target = annotation.image ? '这条图片笔记' : '这条笔记及对应的划线';
      if (!window.confirm('确定删除' + target + '吗？同步时也会删除 Obsidian 中对应的卡片，包括卡片里补写的内容。')) return;
      article = await rpc<Article>({ type: 'DELETE_ANNOTATION', page: page(), id: annotation.id });
      editorDraft = false;
      closeEditor();
      restoreHighlights();
      if (panelOpen) renderPanel();
    }, 'danger'));
  }
  const save = button('保存', async () => {
    save.disabled = true;
    try { await persist({ ...annotation, color, note: input.value }, annotation.note); }
    finally { save.disabled = false; }
  }, 'primary');
  input.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') save.click();
  });
  actions.append(save);
  editor.append(header);
  if (annotation.image) {
    const hint = element('p', 'muted note-hint', '保存时会一并收录图片。批注支持 Markdown。');
    hint.id = 'highlight-note-hint';
    input.setAttribute('aria-describedby', hint.id);
    editor.append(imagePreview(annotation.image), hint);
  } else editor.append(colors);
  editor.append(input, actions);
  if (!outputStatus?.connected) editor.append(button('连接笔记文件夹，开启自动写入', async () => { await rpc({ type: 'OPEN_OPTIONS' }); }, 'connect-obsidian'));
  editor.hidden = false;
  editorDraft = false;
  positionFloating(editor, rect);
  input.focus();
}

function focusHighlight(annotation: Annotation) {
  if (annotation.image) {
    const image = findImage(annotation);
    if (image) image.scrollIntoView({ block: 'center', behavior: 'smooth' });
    else toast('原图位置已变化，图片引用仍保留在笔记中。', true);
    return;
  }
  const range = ranges.get(annotation.id);
  if (!range) { toast('原文位置已变化，可在笔记中保留摘录。', true); return; }
  const parent = range.startContainer.parentElement;
  parent?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function renderPanel(focusNote = false) {
  const scrollTop = panel.querySelector('main')?.scrollTop ?? 0;
  const noteFocused = shadow.activeElement?.classList.contains('page-note');
  const selection = noteFocused ? [(shadow.activeElement as HTMLTextAreaElement).selectionStart, (shadow.activeElement as HTMLTextAreaElement).selectionEnd] : null;
  panel.replaceChildren();
  const header = element('header');
  const brand = element('div', 'brand', '划线笔记');
  brand.append(element('span', '', ' / Underline Notes'));
  header.append(brand, button('×', () => togglePanel(false)));
  header.lastElementChild!.setAttribute('aria-label', '关闭侧边栏');
  const main = element('main');
  main.append(element('div', 'eyebrow', new URL(currentUrl).hostname), element('h1', '', document.title));
  main.append(element('div', 'muted', excluded ? '此网站已暂停记录' : '本页笔记 · 本地保存'));
  if (excluded) {
    main.append(element('p', 'empty', '可以在设置中移除此网站，恢复划线和阅读记录。'));
  } else {
    main.append(element('div', 'section-head', '文章笔记'));
    if (!pageEditing) {
      main.append(noteView(article?.pageNote ?? '', '编辑文章笔记', () => {
        pageEditing = true;
        pageDraft = article?.pageNote ?? '';
        pageDraftBase = pageDraft;
        renderPanel(true);
      }, 'page-note-content'));
    } else {
      const note = element('textarea', 'page-note');
      note.value = pageDraft ?? article?.pageNote ?? '';
      note.placeholder = '这篇文章的主要观点是什么？试着用自己的话概括…';
      note.setAttribute('aria-label', '文章笔记');
      note.setAttribute('aria-describedby', 'page-note-hint');
      const hint = element('p', 'muted note-hint', '可以先复述文章的要点，再记下自己的理解或评论。');
      hint.id = 'page-note-hint';
      note.addEventListener('input', () => {
        if (pageDraft === undefined) pageDraftBase = article?.pageNote ?? '';
        pageDraft = note.value;
      });
      const saveNote = button('保存文章笔记', async () => {
        saveNote.disabled = true;
        try {
          article = await rpc<Article>({ type: 'SAVE_PAGE_NOTE', page: page(true), note: note.value, expectedNote: pageDraftBase ?? article?.pageNote ?? '' });
          pageDraft = undefined;
          pageDraftBase = undefined;
          pageEditing = false;
          toast('文章笔记已保存在浏览器');
          void refreshOutputStatus(true).catch(() => undefined);
          renderPanel();
        } finally { saveNote.disabled = false; }
      }, 'primary save-page');
      const cancelNote = button('取消', () => {
        if (pageDraft !== pageDraftBase && !window.confirm('文章笔记还没保存，放弃修改？')) return;
        pageDraft = undefined;
        pageDraftBase = undefined;
        pageEditing = false;
        renderPanel();
      });
      note.addEventListener('keydown', event => {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') saveNote.click();
      });
      const actions = element('div', 'actions page-note-actions');
      actions.append(cancelNote, saveNote);
      main.append(hint, note, actions);
      if (pageDraft !== undefined && pageDraftBase !== (article?.pageNote ?? '')) {
        main.append(element('p', 'muted', '文章笔记已有新版本，你的草稿仍保留在上方。请先复制需要保留的内容，再载入最新版本合并。'));
        main.append(button('载入最新文章笔记', async () => {
          if (!window.confirm('已复制要保留的草稿？载入最新版本会替换当前输入。')) return;
          pageDraft = undefined;
          pageDraftBase = undefined;
          await refresh();
        }));
      }
    }
    const heading = element('div', 'section-head', '摘录与批注');
    heading.append(element('span', '', String(article?.annotations.length ?? 0)));
    main.append(heading);
    if (!article?.annotations.length) main.append(element('p', 'empty', '选中文字划线，或将鼠标移到图片上收录图片、记笔记。\n你的摘录与想法会出现在这里。'));
    for (const annotation of article?.annotations ?? []) {
      const card = element('article', 'card');
      card.dataset.annotationId = annotation.id;
      card.style.setProperty('--highlight', highlightColors[annotation.color]);
      card.append(button(annotation.anchor.exact, () => focusHighlight(annotation), 'quote'));
      if (annotation.image) card.append(imagePreview(annotation.image));
      card.append(noteView(annotation.note, annotation.note ? '编辑笔记' : '添加笔记', () => openEditor(annotation, null), 'note'));
      const footer = element('footer');
      const resolved = annotation.image ? Boolean(findImage(annotation)) : ranges.has(annotation.id);
      footer.append(element('span', resolved ? 'muted' : 'unresolved', resolved ? annotation.image ? '点击标题定位原图' : '点击摘录定位原文' : '原文位置待重新定位'));
      card.append(footer);
      main.append(card);
    }
    if (article) main.append(button('移除本页记录', async () => {
      if (!window.confirm('移除本页划线、笔记和阅读记录？同步时也会删除 Obsidian 中本页的笔记卡片，包括卡片里补写的内容。')) return;
      await rpc({ type: 'DELETE_ARTICLE', page: page() });
      article = null;
      pageDraft = undefined;
      pageDraftBase = undefined;
      pageEditing = false;
      restoreHighlights();
      renderPanel();
    }, 'danger'));
  }
  const footer = element('footer');
  if (article) footer.append(element('span', 'output-status', outputMessage()));
  if (outputStatus?.connected && settings.vaultName) {
    const link = element('a', '', '在 Obsidian 回顾 ↗');
    link.href = obsidianUrl(settings, article?.id);
    footer.append(link);
  } else footer.append(button('连接笔记文件夹，开启自动写入', async () => { await rpc({ type: 'OPEN_OPTIONS' }); }, 'connect-obsidian'));
  footer.append(button('设置与文件写入', async () => { await rpc({ type: 'OPEN_OPTIONS' }); }));
  panel.append(header, main, footer);
  main.scrollTop = scrollTop;
  const input = main.querySelector('textarea');
  if (input && (focusNote || noteFocused && selection)) {
    input.focus();
    if (selection) input.setSelectionRange(selection[0], selection[1]);
  }
}

function togglePanel(open = !panelOpen) {
  panelOpen = open;
  panel.hidden = !open;
  if (open) { renderPanel(); void refresh().catch(error => toast(error.message, true)); }
}

function inspectSelection() {
  if (!ready || excluded || !editor.hidden) return;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) { toolbar.hidden = true; return; }
  const range = selection.getRangeAt(0);
  if (range.commonAncestorContainer.getRootNode() !== document) return;
  const container = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE ? range.commonAncestorContainer as Element : range.commonAncestorContainer.parentElement;
  if (container?.closest('input, textarea, [contenteditable]:not([contenteditable="false"])')) return;
  selectionAnchor = anchorFromRange(range, buildTextIndex(document.body));
  if (!selectionAnchor) return;
  imageToolbar.hidden = true;
  selectionRect = range.getBoundingClientRect();
  toolbar.hidden = false;
  positionFloating(toolbar, selectionRect);
}

document.addEventListener('mouseover', event => {
  if (!ready || excluded || !editor.hidden || event.composedPath().includes(host)) return;
  const target = event.target;
  if (!(target instanceof HTMLImageElement) || target.closest('[contenteditable]:not([contenteditable="false"])')) return;
  const rect = target.getBoundingClientRect();
  if (rect.width < 48 || rect.height < 48 || !target.currentSrc && !target.src) return;
  imageTarget = target;
  const saved = savedImageAnnotation(target);
  collectImage.disabled = Boolean(saved);
  collectImage.textContent = saved ? '已收录' : '收录图片';
  openImageNote.textContent = saved?.note ? '查看笔记' : '记笔记';
  toolbar.hidden = true;
  imageToolbar.hidden = false;
  positionFloating(imageToolbar, rect);
});

document.addEventListener('mouseup', event => { if (!event.composedPath().includes(host)) setTimeout(inspectSelection, 0); });
document.addEventListener('keyup', event => { if (event.key.startsWith('Arrow') && event.shiftKey) inspectSelection(); });
document.addEventListener('pointerdown', event => {
  const path = event.composedPath();
  if (!path.includes(imageToolbar)) imageToolbar.hidden = true;
  if (path.includes(editor)) return;
  if (!editor.hidden && !closeEditor()) return;
  if (panelOpen && !path.includes(panel) && !path.includes(toolbar) && !path.includes(imageToolbar)) togglePanel(false);
}, { capture: true });
document.addEventListener('click', event => {
  if (event.composedPath().includes(host) || !window.getSelection()?.isCollapsed || excluded) return;
  for (const [id, range] of ranges) {
    if ([...range.getClientRects()].some(rect => event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom)) {
      const annotation = article?.annotations.find(item => item.id === id);
      if (annotation) { event.preventDefault(); openEditor(annotation, range.getBoundingClientRect(), false); }
      return;
    }
  }
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { toolbar.hidden = true; imageToolbar.hidden = true; closeEditor(); }
});
window.addEventListener('scroll', () => { toolbar.hidden = true; imageToolbar.hidden = true; }, { passive: true });
window.addEventListener('beforeunload', event => {
  if (editorDraft || pageDraft !== undefined && pageDraft !== (article?.pageNote ?? '')) { event.preventDefault(); event.returnValue = ''; }
});

chrome.runtime.onMessage.addListener(message => {
  if (message.type === 'NOTING_TOGGLE') togglePanel();
  if (message.type === 'NOTING_REFRESH') void refresh().catch(error => toast(error.message, true));
});

const observer = new MutationObserver(records => {
  if (!records.some(record => !(record.target instanceof Element ? record.target : record.target.parentElement)?.closest('[data-noting-root]'))) return;
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => { restoreHighlights(); }, 350);
});
observer.observe(document.body, { childList: true, characterData: true, subtree: true });

let lastInteraction = performance.now();
let lastTick = performance.now();
let activeMs = 0;
let lastSent = 0;
let sessionId = crypto.randomUUID();
let sessionStarted = new Date().toISOString();
let sessionDay = localDay();
let readable = isProbablyReaderable(document);
let readingInFlight = false;
let maxProgress = 0;
for (const event of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart']) {
  document.addEventListener(event, () => { lastInteraction = performance.now(); }, { passive: true });
}

async function sendReading() {
  if (!ready || excluded || !settings.recordHistory || !readable || activeMs < 15000 || readingInFlight) return;
  readingInFlight = true;
  const sent = activeMs;
  const sentSessionId = sessionId;
  try {
    await rpc({ type: 'READING', page: page(!lastSent), session: { id: sessionId, day: sessionDay, startedAt: sessionStarted, activeMs: sent, progress: maxProgress } });
    if (sessionId === sentSessionId) lastSent = sent;
  } catch (error) {
    if (!chrome.runtime?.id) clearInterval(ticker);
  } finally { readingInFlight = false; }
}

function resetSession() {
  activeMs = 0;
  lastSent = 0;
  maxProgress = 0;
  sessionId = crypto.randomUUID();
  sessionStarted = new Date().toISOString();
  sessionDay = localDay();
  lastTick = performance.now();
  lastInteraction = performance.now();
}

const ticker = setInterval(async () => {
  if (normalizeUrl(location.href) !== normalizeUrl(currentUrl)) {
    // A previous URL's counters never get attributed to the new route.
    currentUrl = location.href;
    article = null;
    pageDraft = undefined;
    pageDraftBase = undefined;
    pageEditing = false;
    cachedBody = undefined;
    cachedMarkdown = undefined;
    publishedDate = undefined;
    bodyAttempted = false;
    toolbar.hidden = true;
    imageToolbar.hidden = true;
    imageTarget = null;
    editor.hidden = true;
    editorDraft = false;
    ready = false;
    resetSession();
    readable = isProbablyReaderable(document);
    await refresh().catch(() => undefined);
    return;
  }
  if (sessionDay !== localDay()) { await sendReading(); resetSession(); }
  const now = performance.now();
  const delta = now - lastTick;
  lastTick = now;
  if (document.visibilityState === 'visible' && document.hasFocus() && now - lastInteraction < 60000 && delta < 5000 && settings.recordHistory && !excluded) {
    activeMs += delta;
    const height = document.documentElement.scrollHeight - innerHeight;
    maxProgress = Math.max(maxProgress, height > 0 ? Math.min(100, scrollY / height * 100) : 100);
  }
  if (activeMs >= 15000 && (lastSent === 0 || activeMs - lastSent >= 10000)) await sendReading();
}, 1000);
document.addEventListener('visibilitychange', () => { lastTick = performance.now(); if (document.hidden) void sendReading(); });
window.addEventListener('pagehide', () => { void sendReading(); });
setInterval(() => { if (panelOpen && document.visibilityState === 'visible') void refreshOutputStatus().catch(() => undefined); }, 4000);
void refresh().catch(error => toast(error.message, true));
