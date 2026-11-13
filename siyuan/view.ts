import { Protyle, openTab, type App } from 'siyuan';
import { reviewCards } from '../shared/review.ts';
import { QuickNoteStore } from './quick-note.ts';
import { tagTree, type TagBranch } from '../obsidian/tags.ts';
import { filterCards, readCards, type Card, type Request, ThoughtStore } from './cards.ts';

function element<K extends keyof HTMLElementTagNameMap>(tag: K, parent: HTMLElement, className = '', text = '') {
  const el = document.createElement(tag); el.className = className; el.textContent = text; parent.append(el); return el;
}
const paths: Record<string, string> = {
  sparkles: 'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z', left: 'm15 6-6 6 6 6',
  layers: 'm12 3 10 5-10 5L2 8l10-5Zm-10 9 10 5 10-5M2 16l10 5 10-5',
  search: 'm21 21-4.4-4.4M19 10.5a8.5 8.5 0 1 1-17 0 8.5 8.5 0 0 1 17 0',
  down: 'm6 9 6 6 6-6', right: 'm9 6 6 6-6 6', hash: 'M4 9h16M3 15h16M10 3 8 21M16 3l-2 18',
  more: 'M5 12h.01M12 12h.01M19 12h.01', refresh: 'M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 13 2M5 16a8 8 0 0 0 13 2',
  edit: 'm16 3 5 5-12 12-6 1 1-6L16 3Zm-2 2 5 5', open: 'M14 3h7v7M21 3 10 14M10 3H3v18h18v-7', check: 'm5 12 4 4L19 6',
};
function icon(parent: HTMLElement, name: string) {
  const span = element('span', parent, 'nt-icon'); span.setAttribute('aria-hidden', 'true'); span.dataset.icon = name;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': name === 'more' ? '3' : '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) svg.setAttribute(key, value);
  const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', paths[name] || paths.layers); svg.append(path); span.append(svg);
}
function button(parent: HTMLElement, label: string, callback: () => void, className = '', symbol = '') {
  const el = element('button', parent, className); el.type = 'button'; el.setAttribute('aria-label', label);
  if (symbol) icon(el, symbol); element('span', el, '', label); el.addEventListener('click', callback); return el;
}
function cardDate(card: Card) { return card.kind === 'local' ? card.timestamp : card.markdown.match(/^摘录时间：(\S+)/m)?.[1] || card.timestamp; }
function dateLabel(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }); }
function sourceTitle(card: Card) { return [...card.markdown.matchAll(/^来源：\[(.*)\]\(.*\)\s*$/gm)].at(-1)?.[1]?.replace(/\\([\\`*_{}\[\]<>#!|])/g, '$1') || (card.source ? new URL(card.source).hostname : ''); }

type Preview = 'note' | 'quote' | 'thought';
export class Cardbox {
  private cards: Card[] = [];
  private query = ''; private tag = ''; private box = ''; private count = 30;
  private mode: 'all' | 'review' = 'all';
  private reviewIndex = 0; private reviewDone = false;
  private composer: HTMLElement; private entry: HTMLTextAreaElement; private destination: HTMLSelectElement;
  private record: HTMLButtonElement; private quickStatus: HTMLElement; private summary: HTMLElement; private quickSaving = false;
  private collapsedTags = new Set<string>();
  private closedDrafts = new Set<string>();
  private editors: Protyle[] = [];
  private sidebar: HTMLElement; private feed: HTMLElement; private heading: HTMLElement; private status: HTMLElement; private hint: HTMLElement;
  private notebook: HTMLSelectElement; private refreshButton: HTMLButtonElement; private search: HTMLInputElement;
  private generation = 0; private disposed = false; private loading = false;
  private menuCleanup?: () => void;
  constructor(private host: HTMLElement, private app: App, private request: Request, private store: ThoughtStore, private quick: QuickNoteStore) {
    host.replaceChildren(); host.classList.add('un-cardbox', 'noting-view');
    const shell = element('div', host, 'nt-shell');
    this.sidebar = element('aside', shell, 'nt-navigation'); this.sidebar.setAttribute('aria-label', '卡片导航');
    const main = element('main', shell, 'nt-main');
    const header = element('header', main, 'nt-header');
    const title = element('div', header); this.heading = element('h1', title, '', '全部笔记'); this.heading.tabIndex = -1;
    this.summary = element('p', title, '', '每一个想法，都值得再看一眼');
    const search = element('div', header, 'nt-search'); icon(search, 'search');
    this.search = element('input', search); this.search.type = 'search'; this.search.placeholder = '搜索想法、摘录、文章…'; this.search.setAttribute('aria-label', '搜索卡片');
    this.search.addEventListener('input', () => { this.query = this.search.value; this.count = 30; this.resetReview(); this.renderFeed(); });
    const tools = element('div', main, 'un-tools');
    this.status = element('span', tools, 'nt-muted'); this.status.setAttribute('role', 'status');
    this.notebook = element('select', tools); this.notebook.setAttribute('aria-label', '筛选笔记本');
    element('option', this.notebook, '', '全部笔记本').value = '';
    this.notebook.addEventListener('change', () => { this.box = this.notebook.value; this.count = 30; this.resetReview(); this.render(); });
    this.refreshButton = button(tools, '刷新', () => void this.refresh(), 'nt-quiet', 'refresh');
    this.hint = element('div', main, 'un-hint'); this.hint.setAttribute('role', 'status');
    this.composer = element('div', main, 'nt-composer');
    this.entry = element('textarea', this.composer); this.entry.rows = 3; this.entry.placeholder = '记下此刻的想法...'; this.entry.setAttribute('aria-label', '记录新想法');
    const composerTools = element('div', this.composer, 'nt-composer-tools');
    element('span', composerTools, 'nt-muted', '通过 # 添加标签');
    const recordTools = element('div', composerTools, 'un-record-tools');
    this.destination = element('select', recordTools); this.destination.setAttribute('aria-label', '保存到笔记本');
    this.record = button(recordTools, '记录', () => void this.saveQuick(), 'nt-primary');
    this.quickStatus = element('p', this.composer, 'nt-tag-status'); this.quickStatus.setAttribute('role', 'status');
    const editQuick = () => {
      const text = this.entry.value, notebookId = this.destination.value;
      void this.quick.edit(text, notebookId).then(() => { if (text === this.entry.value && notebookId === this.destination.value) this.quickStatus.textContent = text ? '草稿已保存在本机' : ''; }).catch(error => { this.quickStatus.textContent = error instanceof Error ? error.message : '草稿暂未保存，请保持页面打开。'; });
    };
    this.entry.addEventListener('input', editQuick); this.destination.addEventListener('change', editQuick);
    this.entry.addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void this.saveQuick(); } });
    this.feed = element('div', main, 'nt-feed');
    this.feed.addEventListener('click', event => {
      const target = (event.target as Element).closest<HTMLElement>('[data-type="tag"]');
      if (!target || !target.closest('.un-native')) return;
      const tag = (target.textContent || '').replace(/^#|#$/g, '');
      if (this.cards.some(card => card.tags.includes(tag))) { event.preventDefault(); event.stopPropagation(); this.selectTag(tag); }
    }, true);
  }
  changed() { if (!this.loading && !this.disposed) this.hint.textContent = '笔记有更新，刷新后查看。'; }
  async refresh() {
    if (this.loading || this.disposed) return;
    this.loading = true; this.refreshButton.disabled = true; this.hint.textContent = '正在读取卡片…';
    try {
      await this.request('/api/sqlite/flushTransaction');
      const [cards, books] = await Promise.all([readCards(this.request), this.request<{ notebooks: { id: string; name: string; closed: boolean }[] }>('/api/notebook/lsNotebooks')]);
      if (this.disposed) return;
      const open = books.notebooks.filter(book => !book.closed);
      this.cards = cards.filter(card => open.some(book => book.id === card.box));
      this.notebook.replaceChildren(); element('option', this.notebook, '', '全部笔记本').value = '';
      for (const book of open) element('option', this.notebook, '', book.name).value = book.id;
      if (this.box && !open.some(book => book.id === this.box)) this.box = '';
      this.notebook.value = this.box;
      const preferred = this.quick.draft.notebookId || (open.length === 1 ? open[0].id : '');
      this.destination.replaceChildren(); element('option', this.destination, '', '选择笔记本').value = '';
      for (const book of open) element('option', this.destination, '', book.name).value = book.id;
      if (preferred && !open.some(book => book.id === preferred)) {
        element('option', this.destination, '', '原笔记本不可用，请打开后重试').value = preferred;
      }
      this.destination.value = preferred;
      this.syncComposer(); this.hint.textContent = ''; this.render();
    } catch (error) { if (!this.disposed) this.hint.textContent = error instanceof Error ? error.message : '读取失败，请重试。'; }
    finally { this.loading = false; this.refreshButton.disabled = false; }
  }
  private syncComposer() {
    this.entry.value = this.quick.draft.text; this.entry.readOnly = this.quickSaving || !!this.quick.draft.attempt;
    this.destination.disabled = this.quickSaving || !!this.quick.draft.attempt; this.record.disabled = this.quickSaving;
    const label = this.quick.draft.attempt ? '重试记录' : '记录'; this.record.setAttribute('aria-label', label); this.record.lastElementChild!.textContent = label;
  }
  private async saveQuick() {
    if (this.quickSaving || !this.entry.value.trim()) return;
    this.quickSaving = true; this.record.disabled = true; this.entry.readOnly = true; this.destination.disabled = true;
    this.quickStatus.textContent = '正在记录…';
    try {
      if (!this.quick.draft.attempt) await this.quick.edit(this.entry.value, this.destination.value);
      await this.quick.submit(); this.syncComposer(); this.quickStatus.textContent = '想法已保存';
      this.mode = 'all'; this.tag = ''; this.query = ''; this.search.value = ''; this.box = ''; this.count = 30; this.resetReview();
      await this.refresh();
    } catch (error) { this.quickStatus.textContent = error instanceof Error ? error.message : '记录失败，草稿已保留，请重试。'; }
    finally { this.quickSaving = false; this.syncComposer(); }
  }
  private resetReview() { this.reviewIndex = 0; this.reviewDone = false; }
  private selectTag(tag: string) { this.mode = 'all'; this.tag = tag; this.count = 30; this.resetReview(); this.render(); }
  private renderNavigation() {
    this.sidebar.replaceChildren();
    const brand = element('div', this.sidebar, 'nt-brand'); brand.setAttribute('aria-label', '划线笔记 / Underline Notes'); icon(brand, 'layers');
    const name = element('span', brand, 'nt-brand-name', '划线笔记'); element('small', name, '', ' / Underline Notes');
    element('div', this.sidebar, 'nt-tagline', '让读过的，成为自己的。');
    const cards = this.cards.filter(card => !this.box || card.box === this.box);
    const stats = element('div', this.sidebar, 'nt-counts');
    for (const [value, label] of [[cards.length, '卡片'], [new Set(cards.map(card => card.source).filter(Boolean)).size, '来源'], [new Set(cards.flatMap(card => card.tags)).size, '标签']]) {
      const stat = element('div', stats); element('strong', stat, '', String(value)); element('span', stat, '', String(label));
    }
    const nav = element('nav', this.sidebar);
    const all = button(nav, '全部笔记', () => this.selectTag(''), this.mode === 'all' && !this.tag ? 'is-active' : '', 'layers'); all.setAttribute('aria-pressed', String(this.mode === 'all' && !this.tag));
    const review = button(nav, '每日回顾', () => { this.mode = 'review'; this.resetReview(); this.render(); }, this.mode === 'review' ? 'is-active' : '', 'sparkles'); review.setAttribute('aria-pressed', String(this.mode === 'review'));
    element('div', this.sidebar, 'nt-label', '我的标签');
    const tags = element('nav', this.sidebar, 'nt-tags-nav'); tags.setAttribute('aria-label', '标签筛选');
    const branches = tagTree(cards);
    if (!branches.length) element('p', tags, 'nt-muted', '通过 # 添加标签，\n也可以使用 #领域/写作。');
    const drawTags = (parent: HTMLElement, branches: TagBranch[]) => {
      for (const branch of branches) {
        const row = element('div', parent, 'nt-tag-row');
        if (branch.children.length) {
          const expanded = !this.collapsedTags.has(branch.tag);
          const toggle = button(row, (expanded ? '收起 ' : '展开 ') + branch.tag, () => { if (expanded) this.collapsedTags.add(branch.tag); else this.collapsedTags.delete(branch.tag); this.renderNavigation(); }, 'nt-tag-toggle', expanded ? 'down' : 'right');
          toggle.setAttribute('aria-expanded', String(expanded));
        }
        const item = button(row, branch.tag, () => this.selectTag(this.tag === branch.tag ? '' : branch.tag), this.tag === branch.tag ? 'is-active' : '', branch.children.length ? '' : 'hash');
        item.lastElementChild!.textContent = branch.tag.split('/').at(-1)!; item.setAttribute('aria-pressed', String(this.tag === branch.tag));
        element('span', item, 'nt-tag-count', String(branch.count));
        if (branch.children.length && !this.collapsedTags.has(branch.tag)) drawTags(element('div', parent, 'nt-tag-children'), branch.children);
      }
    };
    drawTags(tags, branches); element('div', this.sidebar, 'nt-local', '●  保存在你的思源笔记');
  }
  private releaseEditors() { for (const editor of this.editors) editor.destroy(); this.editors = []; }
  private render() { if (!this.disposed) { this.renderNavigation(); this.renderFeed(); } }
  private renderFeed() {
    if (this.disposed) return;
    this.menuCleanup?.(); this.generation++; this.releaseEditors(); this.feed.replaceChildren();
    this.composer.hidden = this.mode === 'review';
    this.heading.textContent = this.mode === 'review' ? '与过去的想法重逢' : this.tag ? '#' + this.tag : '全部笔记';
    this.summary.textContent = '每一个想法，都值得再看一眼';
    const selected = filterCards(this.cards, this.query, this.tag, this.box);
    this.status.textContent = `${selected.length} 张卡片${this.tag ? ' · #' + this.tag : ''}`;
    if (!selected.length) {
      const empty = element('div', this.feed, 'nt-empty'); icon(empty, 'layers');
      element('h2', empty, '', this.cards.length ? '还没有找到这条线索' : '从一个想法开始');
      element('p', empty, '', this.cards.length ? '试试更短的关键词，或选择其他标签。' : '在 Chrome 划线，或在全部笔记中记下一句话。它们会在这里相遇。');
      if (!this.cards.length && this.mode === 'review') button(empty, '回到卡片', () => this.selectTag(''), 'nt-quiet');
      if (this.cards.length) button(empty, '清除筛选', () => { this.query = ''; this.tag = ''; this.box = ''; this.notebook.value = ''; this.search.value = ''; this.resetReview(); this.render(); }, 'nt-quiet');
      return;
    }
    if (this.mode === 'review') {
      const today = new Date().toLocaleDateString('en-CA');
      const daily = reviewCards(selected, today);
      this.reviewIndex = Math.min(this.reviewIndex, daily.length - 1);
      this.summary.textContent = `今天回顾 ${daily.length} 张 · 不急，想一想它和现在的你有什么关系。`;
      if (this.reviewDone) {
        const empty = element('div', this.feed, 'nt-empty'); icon(empty, 'check');
        element('h2', empty, '', '今天的回顾完成了'); element('p', empty, '', '带着一个新的理解，回到生活中去。');
        button(this.feed, '回到卡片', () => { this.mode = 'all'; this.resetReview(); this.render(); }, '', 'layers'); return;
      }
      const progress = element('div', this.feed, 'nt-review-progress'); progress.setAttribute('role', 'status');
      element('span', progress, '', `${String(this.reviewIndex + 1).padStart(2, '0')} / ${String(daily.length).padStart(2, '0')}`);
      const track = element('div', progress); element('span', track).style.width = `${(this.reviewIndex + 1) / daily.length * 100}%`;
      this.renderCard(daily[this.reviewIndex], true);
      const controls = element('div', this.feed, 'nt-review-controls');
      button(controls, '上一张', () => { this.reviewIndex--; this.renderFeed(); }, '', 'left').disabled = this.reviewIndex === 0;
      button(controls, this.reviewIndex === daily.length - 1 ? '完成回顾' : '下一张', () => {
        if (this.reviewIndex === daily.length - 1) this.reviewDone = true; else this.reviewIndex++;
        this.renderFeed();
      }, 'nt-primary', 'right'); return;
    }
    for (const card of selected.slice(0, this.count)) this.renderCard(card);
    if (selected.length > this.count) button(this.feed, '再看一些', () => { this.count += 30; this.renderFeed(); }, 'nt-load-more', 'down');
  }
  private embed(parent: HTMLElement, id: string, part: Preview, hasThoughts = false) {
    const container = element('div', parent, 'un-native un-' + part);
    const generation = this.generation;
    const editor = new Protyle(this.app, container, {
      blockId: id, action: [],
      render: { background: false, title: false, gutter: false, breadcrumb: false, scroll: false },
      after: protyle => {
        if (this.disposed || generation !== this.generation) return;
        protyle.disable();
        // Presentation only: hide generated metadata and split the read-only preview.
        // No block content is changed or submitted to the kernel.
        const root = container.querySelector('.protyle-wysiwyg > [data-type="NodeSuperBlock"]');
        if (!root) return;
        const blocks = [...root.children].filter((node): node is HTMLElement => node instanceof HTMLElement && node.hasAttribute('data-node-id'));
        const visible = blocks.filter((block, index) => {
          const text = block.textContent?.trim() || '';
          const generated = index === 0 && /^更新 |^想法 /.test(text) && block.dataset.type === 'NodeHeading';
          const metadata = part !== 'thought' && ((index >= blocks.length - 2 && /^来源：/.test(text)) || (index === blocks.length - 1 && /^摘录时间：/.test(text)));
          block.classList.toggle('un-preview-hidden', generated || metadata); return !generated && !metadata;
        });
        const quote = visible.at(-1)?.dataset.type === 'NodeBlockquote' ? visible.at(-1) : undefined;
        if (part !== 'thought') for (const block of visible) block.classList.toggle('un-preview-hidden', part === 'quote' ? block !== quote : block === quote);
        container.hidden = part === 'quote' ? !quote : part === 'note' && visible.every(block => block === quote);
        if (part === 'quote') container.classList.toggle('un-quote-primary', !hasThoughts && visible.every(block => block === quote));
      },
    });
    editor.disable(); this.editors.push(editor);
  }
  private showMenu(anchor: HTMLButtonElement, edit: () => void, open: () => void) {
    const wasOpen = anchor.getAttribute('aria-expanded') === 'true'; this.menuCleanup?.(); if (wasOpen) return;
    const menu = element('div', anchor.parentElement!, 'un-menu'); menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', '卡片操作');
    const events = new AbortController();
    const close = (focus = false) => { menu.remove(); events.abort(); anchor.setAttribute('aria-expanded', 'false'); this.menuCleanup = undefined; if (focus && anchor.isConnected) anchor.focus(); };
    this.menuCleanup = () => close(); anchor.setAttribute('aria-expanded', 'true');
    const choices = [[ '补写想法', 'edit', edit ], [ '打开', 'open', open ]] as const;
    const items = choices.map(([label, symbol, action]) => {
      const item = button(menu, label, () => { close(); action(); }, '', symbol); item.setAttribute('role', 'menuitem'); return item;
    });
    menu.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
      else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); const index = items.indexOf(document.activeElement as HTMLButtonElement);
        items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
      } else if (event.key === 'Tab') close();
    });
    document.addEventListener('pointerdown', event => { if (!menu.contains(event.target as Node) && !anchor.contains(event.target as Node)) close(); }, { capture: true, signal: events.signal });
    items[0].focus();
  }
  private renderCard(card: Card, review = false) {
    const article = element('article', this.feed, 'nt-memo un-card' + (review ? ' nt-review-card' : '')); article.dataset.cardId = card.id; article.setAttribute('aria-label', card.title);
    const head = element('div', article, 'nt-memo-head');
    const when = cardDate(card); element('time', head, '', dateLabel(when)).dateTime = when;
    const more = button(head, '更多操作', () => this.showMenu(more, showEditor, () => { void openTab({ app: this.app, doc: { id: card.id } }); }), 'nt-icon-button', 'more');
    more.setAttribute('aria-haspopup', 'menu'); more.setAttribute('aria-expanded', 'false');
    if (card.tags.length) {
      const tags = element('div', article, 'nt-card-tags'); tags.setAttribute('aria-label', '卡片标签');
      for (const tag of card.tags) button(tags, '#' + tag, () => this.selectTag(tag), 'nt-card-tag');
    }
    const form = element('div', article, 'nt-edit un-compose'); form.hidden = !this.store.drafts[card.id] || this.closedDrafts.has(card.id);
    const input = element('textarea', form); input.setAttribute('aria-label', '补写想法'); input.placeholder = '写下此刻的想法…'; input.rows = 5;
    const draft = this.store.drafts[card.id]; input.value = draft?.text || ''; input.readOnly = !!draft?.attempt;
    const actions = element('div', form, 'nt-edit-actions');
    const close = button(actions, '收起', () => hideEditor());
    const save = button(actions, draft?.attempt ? '重试保存' : '保存想法', () => void submit(), 'nt-primary', 'check');
    const message = element('p', form, 'nt-tag-status'); message.setAttribute('role', 'status');
    const showEditor = () => { this.closedDrafts.delete(card.id); form.hidden = false; input.focus(); };
    const hideEditor = () => { if (saving) return; this.closedDrafts.add(card.id); form.hidden = true; more.focus(); };
    article.addEventListener('dblclick', event => {
      if (!(event.target as Element).closest('button,a,input,textarea,[role="button"],.nt-edit,.un-menu')) showEditor();
    });
    this.embed(article, card.versionId, card.kind === 'local' ? 'thought' : 'note');
    if (card.thoughts.length) {
      const personal = element('div', article, 'un-thoughts');
      for (const thought of card.thoughts) this.embed(personal, thought.id, 'thought');
    }
    if (card.kind !== 'local') this.embed(article, card.versionId, 'quote', !!card.thoughts.length);
    if (card.source) {
      const source = element('a', article, 'nt-source'); source.href = card.source; source.target = '_blank'; source.rel = 'noopener noreferrer';
      icon(source, 'open'); element('span', source, '', sourceTitle(card)); source.setAttribute('aria-label', '查看来源：' + sourceTitle(card));
    }
    input.addEventListener('input', () => {
      const text = input.value;
      void this.store.edit(card.id, text).then(() => { if (input.value === text) message.textContent = text ? '草稿已保存在本机' : ''; }).catch(() => { message.textContent = '草稿暂未保存到磁盘，请保持页面打开并重试。'; });
    });
    let saving = false;
    input.addEventListener('keydown', event => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void submit(); }
      else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); hideEditor(); }
    });
    const submit = async () => {
      if (saving) return;
      saving = true; save.disabled = true; close.disabled = true; input.readOnly = true; message.textContent = '正在保存…';
      try {
        if (!this.store.drafts[card.id]?.attempt) await this.store.edit(card.id, input.value);
        await this.store.submit(card.id); form.hidden = true; input.value = ''; this.closedDrafts.delete(card.id);
        await this.refresh();
      } catch (error) { message.textContent = error instanceof Error ? error.message : '保存失败，请重试。'; save.lastElementChild!.textContent = '重试保存'; save.setAttribute('aria-label', '重试保存'); }
      finally { saving = false; save.disabled = false; close.disabled = false; input.readOnly = !!this.store.drafts[card.id]?.attempt; }
    };
  }
  destroy() { this.disposed = true; this.menuCleanup?.(); this.generation++; this.releaseEditors(); this.host.replaceChildren(); this.host.classList.remove('un-cardbox', 'noting-view'); }
}
