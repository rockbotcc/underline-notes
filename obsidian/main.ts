import { App, Component, ItemView, MarkdownRenderer, Menu, Notice, Plugin, PluginSettingTab, Setting, TFile, WorkspaceLeaf, normalizePath, parseYaml, requestUrl, setIcon, getAllTags } from 'obsidian';
import { normalizeTags, VAULT_TAGS_PATH } from '../shared/vault-tags';
import { filterMemos, filterSourceGroups, groupMemosBySource, localMemo, memoExcerpt, memoImage, parseMemo, reviewMemos, sourceKey, updateThoughts, type Memo, type SourceGroup } from './cards';
import { DELETE_MARKER_SUFFIX, updateCardNote } from '../shared/note-sync';
import { DEFAULT_AI, apiRequest, type AISettings, type Transport } from './ai';
import type { Relation } from './relations';
import type { Discussion } from './discussion';
import { generateTags, tagTree, tagVersion, writeTags, type TagBranch } from './tags';
import { contextForQuote, highlightReaderQuote, type QuoteContext } from './reader';

const VIEW = 'noting-cardbox';
interface ArticlePreview { id: string; path: string; title: string; createdAt: string; minutes: number; body: string; source: string }
interface Preferences { folder: string; ai: AISettings }
function metadata(text: string): Record<string, unknown> {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  try { return match ? parseYaml(match[1]) || {} : {}; } catch { return {}; }
}
function date(value: string) {
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? '' : timestamp.toLocaleString('zh-CN', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function button(parent: HTMLElement, label: string, icon: string, action: () => void, cls = '') {
  const element = parent.createEl('button', { cls, attr: { 'aria-label': label, title: label } });
  if (icon) setIcon(element.createSpan({ cls: 'nt-icon' }), icon);
  element.createSpan({ text: label });
  element.addEventListener('click', action);
  return element;
}

export default class NotingPlugin extends Plugin {
  preferences: Preferences = { folder: 'Reading', ai: { ...DEFAULT_AI } };
  relations: Relation[] = [];
  discussions: Discussion[] = [];
  private pendingTags = new Map<TFile, boolean>();
  private tagTimer = 0;
  private tagging = false;
  private tagGeneration = 0;
  tagStatus = new Map<string, string>();
  private writes: Promise<void> = Promise.resolve();
  private unloaded = false;
  private vocabularyTimer = 0;
  private vocabularyWrites: Promise<void> = Promise.resolve();
  private transport: Transport = request => requestUrl(request);
  async onload() {
    const saved = await this.loadData();
    this.preferences = { folder: saved?.folder || 'Reading', ai: { ...DEFAULT_AI, ...saved?.ai } };
    this.relations = Array.isArray(saved?.relations) ? saved.relations : [];
    this.discussions = Array.isArray(saved?.discussions) ? saved.discussions : [];
    this.registerView(VIEW, leaf => new CardboxView(leaf, this));
    this.addRibbonIcon('layers', '划线笔记 / Underline Notes · 卡片盒', () => void this.activate());
    this.addCommand({ id: 'open-cardbox', name: '打开卡片盒', callback: () => void this.activate() });
    this.addCommand({ id: 'export-vault-tags', name: '导出全仓库标签供浏览器使用', callback: () => { void this.exportVocabulary().then(() => new Notice('全仓库标签已导出'), () => new Notice('标签导出失败，请检查资料文件夹权限。')); } });
    this.registerObsidianProtocolHandler('noting', () => void this.activate());
    this.addSettingTab(new NotingSettings(this.app, this));
    this.registerEvent(this.app.workspace.on('file-open', file => {
      if (file?.path === this.folder + '/卡片盒.md') void this.activate();
    }));
    // Listen after initial vault loading: opening a vault never bulk-tags old cards.
    this.app.workspace.onLayoutReady(() => {
      if (this.unloaded) return;
      this.scheduleVocabularyExport();
      this.registerEvent(this.app.metadataCache.on('changed', () => this.scheduleVocabularyExport()));
      this.registerEvent(this.app.metadataCache.on('resolved', () => this.scheduleVocabularyExport()));
      this.registerEvent(this.app.vault.on('delete', () => this.scheduleVocabularyExport()));
      this.registerEvent(this.app.vault.on('rename', () => this.scheduleVocabularyExport()));
      for (const event of ['create', 'modify'] as const) this.registerEvent(this.app.vault.on(event as 'modify', file => {
        if (file instanceof TFile) this.scheduleTags(file);
      }));
    });
  }
  onunload() { this.unloaded = true; window.clearTimeout(this.tagTimer); window.clearTimeout(this.vocabularyTimer); this.pendingTags.clear(); }
  get folder() { return normalizePath(this.preferences.folder || 'Reading'); }
  savePreferences() {
    const next = this.writes.catch(() => undefined).then(() => this.saveData({ ...this.preferences, relations: this.relations, discussions: this.discussions }));
    this.writes = next;
    return next;
  }
  scheduleTags(file: TFile) {
    if (this.unloaded || !this.preferences.ai.autoTag || !this.preferences.ai.baseUrl || !this.preferences.ai.model || !file.path.startsWith(this.folder + '/Cards/') || !file.path.endsWith('.md')) return;
    this.pendingTags.set(file, this.pendingTags.get(file) || false);
    window.clearTimeout(this.tagTimer);
    this.tagTimer = window.setTimeout(() => void this.drainTags(), 600);
  }
  organizeTags() {
    if (!this.preferences.ai.autoTag || !this.preferences.ai.baseUrl || !this.preferences.ai.model) {
      new Notice('请先配置模型并开启自动标签。'); return;
    }
    const files = this.app.vault.getMarkdownFiles().filter(file => file.path.startsWith(this.folder + '/Cards/'));
    for (const file of files) this.pendingTags.set(file, true);
    new Notice('已加入整理队列：' + files.length + ' 张卡片。自动标签会重新归类，手写标签保留；关闭自动标签可停止。');
    void this.drainTags();
  }
  cancelPendingTags() { this.tagGeneration++; this.pendingTags.clear(); }
  private async vocabulary(): Promise<string[]> {
    const tags: string[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      const cache = this.app.metadataCache.getFileCache(file);
      if (cache) tags.push(...(getAllTags(cache) || []));
    }
    return normalizeTags(tags);
  }
  scheduleVocabularyExport() {
    if (this.unloaded) return;
    window.clearTimeout(this.vocabularyTimer);
    this.vocabularyTimer = window.setTimeout(() => { void this.exportVocabulary().catch(() => new Notice('全仓库标签导出失败，请检查资料文件夹权限。')); }, 600);
  }
  exportVocabulary(): Promise<void> {
    const next = this.vocabularyWrites.catch(() => undefined).then(async () => {
      if (this.unloaded) return;
      const tags = await this.vocabulary();
      let path = '';
      for (const part of (this.folder + '/Data').split('/')) {
        path = path ? path + '/' + part : part;
        if (!this.app.vault.getAbstractFileByPath(path)) await this.app.vault.createFolder(path);
      }
      await this.app.vault.adapter.write(this.folder + '/' + VAULT_TAGS_PATH, JSON.stringify({ schemaVersion: 1, source: 'obsidian-vault', exportedAt: new Date().toISOString(), tags }, null, 2));
    });
    this.vocabularyWrites = next;
    return next;
  }
  private updateTagStatus() {
    if (this.unloaded) return;
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW)) if (leaf.view instanceof CardboxView) leaf.view.refreshTagStatus();
  }
  private async drainTags() {
    if (this.tagging || this.unloaded) return;
    this.tagging = true;
    try {
      while (this.pendingTags.size && !this.unloaded) {
        const [file, force] = this.pendingTags.entries().next().value!;
        this.pendingTags.delete(file);
        await this.tagFile(file, force);
      }
    } finally { this.tagging = false; }
  }
  private async tagFile(file: TFile, force = false) {
    const folder = this.folder, settings = { ...this.preferences.ai }, generation = this.tagGeneration;
    let id = '';
    const active = () => !this.unloaded && generation === this.tagGeneration && folder === this.folder && JSON.stringify(settings) === JSON.stringify(this.preferences.ai)
      && file.path.startsWith(folder + '/Cards/') && this.app.vault.getAbstractFileByPath(file.path) === file;
    try {
      if (!settings.autoTag || !settings.baseUrl || !settings.model || !active()) return;
      const text = await this.app.vault.read(file), memo = parseMemo(file.path, text, metadata(text));
      if (!memo) return;
      id = memo.id;
      const version = await tagVersion(memo);
      if ((!force && memo.tagVersion === version) || !active()) return;
      this.tagStatus.set(id, '正在添加标签…'); this.updateTagStatus();
      const vocabulary = await this.vocabulary();
      if (!active()) return;
      const tags = memo.note.trim() || memo.personal.trim() || memo.quote.trim() ? await generateTags(memo, settings, this.transport, vocabulary) : [];
      if (!active()) return;
      const current = await this.app.vault.read(file), fresh = parseMemo(file.path, current, metadata(current));
      if (!fresh || fresh.id !== id) return;
      if (await tagVersion(fresh) !== version) { this.scheduleTags(file); return; }
      if (!active()) return;
      await this.app.vault.process(file, latest => {
        // Recheck atomically; don't overwrite a save that arrived after the read.
        if (!active() || latest !== current) { this.scheduleTags(file); return latest; }
        return writeTags(latest, tags, version);
      });
      this.tagStatus.delete(id);
    } catch (error) {
      if (!active()) return;
      if (id) this.tagStatus.set(id, '自动标签未完成，下次保存时重试。');
      new Notice('笔记已保存，自动标签未完成。' + (error instanceof Error && /^(AI |请在|接口地址)/.test(error.message) ? error.message : '请检查模型设置，下次保存时重试。'));
    } finally {
      if (this.tagStatus.get(id) === '正在添加标签…') this.tagStatus.delete(id);
      this.updateTagStatus();
    }
  }
  async testConnection() {
    const settings = { ...this.preferences.ai };
    if (!settings.model.trim()) throw new Error('请填写标签模型。');
    const response = await apiRequest(settings, 'chat/completions', { model: settings.model, stream: false, messages: [{ role: 'user', content: 'Reply with OK.' }] }, this.transport);
    if (typeof response?.choices?.[0]?.message?.content !== 'string') throw new Error('接口未返回 Chat Completions 文本。');
  }
  async activate() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW)[0];
    if (!leaf) { leaf = this.app.workspace.getLeaf('tab'); await leaf.setViewState({ type: VIEW, active: true }); }
    await this.app.workspace.revealLeaf(leaf);
  }
}

class NotingSettings extends PluginSettingTab {
  constructor(app: App, private plugin: NotingPlugin) { super(app, plugin); }
  display() {
    this.containerEl.empty();
    new Setting(this.containerEl).setName('资料文件夹').setDesc('与 Chrome 扩展写入的文件夹一致，默认 Reading。').addText(input => input.setValue(this.plugin.folder).onChange(async value => {
      if (!value.trim() || value.split('/').includes('..')) return;
      this.plugin.preferences.folder = normalizePath(value.trim());
      await this.plugin.savePreferences();
      this.plugin.scheduleVocabularyExport();
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW)) if (leaf.view instanceof CardboxView) void leaf.view.refresh();
    }));
    this.containerEl.createEl('h2', { text: 'AI 自动标签' });
    this.containerEl.createEl('p', { text: '从整个 Obsidian 仓库的正文 #标签和 YAML tags 中选择，支持任意层级，不创建未知标签，保留手写标签。模型收到当前标题、最多 1800 字批注、1800 字延伸思考、1200 字摘录及全仓库标签名，不发送其他笔记正文。标签列表自动导出到资料文件夹的 Data/vault-tags.json，供浏览器读取；Obsidian 关闭后浏览器使用最后导出的列表。' });
    new Setting(this.containerEl).setName('全仓库标签').setDesc('更新后，浏览器会在下次保存笔记时读取。').addButton(control => control.setButtonText('导出全仓库标签').onClick(() => { void this.plugin.exportVocabulary().then(() => new Notice('全仓库标签已导出'), () => new Notice('标签导出失败，请检查资料文件夹权限。')); }));
    const field = (key: 'baseUrl' | 'apiKey' | 'model', name: string, desc: string, placeholder: string) => {
      new Setting(this.containerEl).setName(name).setDesc(desc).addText(input => {
        input.setPlaceholder(placeholder).setValue(this.plugin.preferences.ai[key]);
        if (key === 'apiKey') input.inputEl.type = 'password';
        input.onChange(async value => {
          this.plugin.preferences.ai[key] = value.trim();
          try { await this.plugin.savePreferences(); } catch { new Notice('设置保存失败，请重试。'); }
        });
      });
    };
    field('baseUrl', '接口地址', '兼容 Chat Completions 的 API 根地址。支持云服务与本地服务。', 'https://your-provider.example/v1');
    field('apiKey', 'API Key', '保存在本仓库的插件 data.json 中，未加密；本地免鉴权服务可留空。', 'sk-…');
    field('model', '标签模型', '填写用于提取主题标签的模型 ID。', '模型 ID');
    new Setting(this.containerEl).setName('保存后自动添加标签').setDesc('配置模型后生效。在 Obsidian 保存或浏览器同步新内容时自动添加；打开仓库不会批量处理旧卡片。').addToggle(toggle => toggle.setValue(!!this.plugin.preferences.ai.autoTag).onChange(async value => {
      this.plugin.preferences.ai.autoTag = value;
      if (!value) this.plugin.cancelPendingTags();
      try { await this.plugin.savePreferences(); } catch { new Notice('设置保存失败，请重试。'); }
    }));
    new Setting(this.containerEl).setName('整理已有标签').setDesc('逐张调用模型，从全仓库已有标签中为旧卡片选择标签。保留手写标签和正文；可能产生模型费用，关闭自动标签可停止。').addButton(control => control.setButtonText('整理旧卡片标签').onClick(() => this.plugin.organizeTags()));
    new Setting(this.containerEl).setName('测试模型连接').setDesc('只发送测试短句，不发送笔记。').addButton(control => control.setButtonText('测试连接').onClick(async () => {
      control.setDisabled(true); control.setButtonText('测试中…');
      try { await this.plugin.testConnection(); new Notice('模型连接成功'); }
      catch (error) { new Notice(error instanceof Error ? error.message : '连接失败'); }
      finally { control.setDisabled(false); control.setButtonText('测试连接'); }
    }));
  }
}

class CardboxView extends ItemView {
  private memos: Memo[] = [];
  private articles: ArticlePreview[] = [];
  private mode = 'all';
  private tag = '';
  private collapsedTags = new Set<string>();
  private query = '';
  private selectedSource = '';
  private reviewIndex = 0;
  private pageSize = 30;
  private shell!: HTMLElement;
  private sidebar!: HTMLElement;
  private feed!: HTMLElement;
  private drawer!: HTMLElement;
  private heading!: HTMLElement;
  private summary!: HTMLElement;
  private composer!: HTMLElement;
  private search!: HTMLElement;
  private selectedDay = '';
  private renderContext = new Component();
  private drawerContext = new Component();
  private timer = 0;
  private revision = 0;
  private closed = false;
  private drafts = new Map<string, { text: string; tail: string; expectedNote: string }>();

  constructor(leaf: WorkspaceLeaf, private plugin: NotingPlugin) { super(leaf); }
  getViewType() { return VIEW; }
  getDisplayText() { return '划线笔记 / Underline Notes · 卡片盒'; }
  getIcon() { return 'layers'; }
  async onOpen() {
    this.contentEl.empty();
    this.contentEl.addClass('noting-view');
    this.shell = this.contentEl.createDiv({ cls: 'nt-shell' });
    this.sidebar = this.shell.createEl('aside', { cls: 'nt-navigation', attr: { 'aria-label': '卡片导航' } });
    const main = this.shell.createEl('main', { cls: 'nt-main' });
    const header = main.createEl('header', { cls: 'nt-header' });
    const title = header.createDiv();
    this.heading = title.createEl('h1', { attr: { tabindex: '-1' } });
    this.summary = title.createEl('p');
    const search = header.createDiv({ cls: 'nt-search' });
    this.search = search;
    setIcon(search.createSpan(), 'search');
    const input = search.createEl('input', { type: 'search', attr: { placeholder: '搜索想法、摘录、文章…', 'aria-label': '搜索卡片' } });
    input.addEventListener('input', () => { this.query = input.value; this.reviewIndex = 0; this.pageSize = 30; this.renderFeed(); });
    this.composer = main.createDiv({ cls: 'nt-composer' });
    const entry = this.composer.createEl('textarea', { attr: { placeholder: '记下此刻的想法...', 'aria-label': '记录新想法', rows: '3' } });
    const tools = this.composer.createDiv({ cls: 'nt-composer-tools' });
    tools.createSpan({ text: '配置 AI 后自动为笔记添加标签 · 通过 # 添加标签', cls: 'nt-muted' });
    const saveNew = async () => {
      if (!entry.value.trim()) return;
      save.disabled = true;
      try {
        const folder = this.plugin.folder + '/Cards/Local';
        for (const part of [this.plugin.folder, this.plugin.folder + '/Cards', folder]) {
          if (!this.app.vault.getAbstractFileByPath(part)) await this.app.vault.createFolder(part);
        }
        const id = 'n_' + crypto.randomUUID();
        await this.app.vault.create(folder + '/' + id + '.md', localMemo(entry.value, id, new Date().toISOString()));
        const file = this.app.vault.getAbstractFileByPath(folder + '/' + id + '.md');
        if (file instanceof TFile) this.plugin.scheduleTags(file);
        entry.value = ''; this.mode = 'all'; this.selectedSource = ''; this.tag = ''; this.query = ''; input.value = ''; await this.refresh();
        new Notice('想法已保存');
      } catch (error) { new Notice('保存失败：' + String(error)); }
      finally { save.disabled = false; }
    };
    const save = button(tools, '记录', '', () => void saveNew(), 'nt-primary');
    entry.addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void saveNew(); } });
    this.feed = main.createDiv({ cls: 'nt-feed', attr: { 'aria-live': 'polite' } });
    this.drawer = this.shell.createEl('aside', { cls: 'nt-drawer', attr: { 'aria-label': '本地阅读', hidden: '' } });
    this.addChild(this.renderContext); this.addChild(this.drawerContext);
    for (const event of ['create', 'modify', 'delete'] as const) {
      this.registerEvent(this.app.vault.on(event as 'modify', file => {
        if (file.path.startsWith(this.plugin.folder + '/')) {
          window.clearTimeout(this.timer); this.timer = window.setTimeout(() => void this.refresh(), 250);
        }
      }));
    }
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      if (file.path.startsWith(this.plugin.folder + '/') || oldPath.startsWith(this.plugin.folder + '/')) {
        window.clearTimeout(this.timer); this.timer = window.setTimeout(() => void this.refresh(), 250);
      }
    }));
    await this.refresh();
  }
  async onClose() { this.closed = true; window.clearTimeout(this.timer); this.contentEl.removeClass('noting-view'); }
  async refresh() {
    const revision = ++this.revision;
    const files = this.app.vault.getMarkdownFiles().filter(file => file.path.startsWith(this.plugin.folder + '/Cards/') || file.path.startsWith(this.plugin.folder + '/Articles/'));
    const memos: Memo[] = [], articles: ArticlePreview[] = [];
    let failures = 0;
    // Bound IO work and commit only the newest snapshot after rapid vault changes.
    for (let offset = 0; offset < files.length; offset += 25) {
      await Promise.all(files.slice(offset, offset + 25).map(async file => {
        try {
          const text = await this.app.vault.cachedRead(file);
          const meta = metadata(text);
          if (file.path.startsWith(this.plugin.folder + '/Cards/')) {
            const memo = parseMemo(file.path, text, meta);
            if (memo) {
              if (memo.personal) memo.updatedAt = [memo.updatedAt, new Date(file.stat.mtime).toISOString()].sort().at(-1)!;
              memos.push(memo);
            }
          } else if (typeof meta.article_id === 'string') {
            const marker = '\n## 保存的正文\n';
            const start = text.indexOf(marker);
            const body = start < 0 ? '' : text.slice(start + marker.length).replace(/\n---\n\n\[网页来源\][\s\S]*$/, '').trim();
            articles.push({ id: meta.article_id, path: file.path, title: String(meta.title || file.basename), createdAt: String(meta.last_read_at || meta.created_at || ''), minutes: Number(meta.reading_minutes) || 0, body, source: String(meta.source_url || '') });
          }
        } catch { failures++; }
      }));
    }
    if (this.closed || revision !== this.revision) return;
    this.memos = memos.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    this.articles = articles.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    this.renderNavigation();
    if (!this.feed.querySelector('.nt-edit textarea:focus')) this.renderFeed();
    if (failures) new Notice(failures + ' 个文件暂时无法读取，下次更新会重试。');
  }
  private renderHeatmap() {
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    const day = new Date(today);
    day.setDate(day.getDate() - 56 - (day.getDay() + 6) % 7);
    const counts = new Map<string, number>();
    for (const memo of this.memos) {
      const date = new Date(memo.createdAt);
      if (Number.isNaN(date.getTime())) continue;
      const key = date.toDateString();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const chart = this.sidebar.createDiv({ cls: 'nt-heatmap', attr: { role: 'group', 'aria-label': '最近九周笔记热力图' } });
    const grid = chart.createDiv({ cls: 'nt-heat-days' });
    const months = chart.createDiv({ cls: 'nt-heat-months' });
    let previousMonth = -1;
    for (let week = 0; week < 9; week++) {
      for (let row = 0; row < 7; row++, day.setDate(day.getDate() + 1)) {
        if (day > today) break;
        const count = counts.get(day.toDateString()) ?? 0;
        const label = day.toLocaleDateString('zh-CN') + ' · ' + count + ' 条笔记';
        const level = count >= 6 ? 4 : count >= 3 ? 3 : count;
        const key = day.toDateString();
        const cell = grid.createEl('button', { cls: 'nt-heat-day', attr: { type: 'button', title: label, 'aria-label': label, 'aria-pressed': String(this.mode === 'day' && this.selectedDay === key), 'data-level': String(level), 'data-today': String(+day === +today) } });
        cell.addEventListener('click', () => {
          this.mode = 'day';
          this.selectedDay = key;
          this.selectedSource = '';
          this.tag = '';
          this.query = '';
          this.search.querySelector('input')!.value = '';
          this.pageSize = 30;
          this.renderNavigation();
          this.renderFeed();
          this.heading.focus();
          this.heading.closest('.nt-main')?.scrollTo({ top: 0 });
        });
      }
      const lastDay = new Date(Math.min(+day - 86400000, +today));
      if (lastDay.getMonth() !== previousMonth) {
        previousMonth = lastDay.getMonth();
        months.createSpan({ text: (previousMonth + 1) + '月' }).style.gridColumn = String(week + 1);
      }
    }
  }
  private renderNavigation() {
    this.sidebar.empty();
    const brand = this.sidebar.createDiv({ cls: 'nt-brand' });
    brand.setAttribute('aria-label', '划线笔记 / Underline Notes');
    setIcon(brand.createSpan(), 'layers');
    const name = brand.createSpan({ cls: 'nt-brand-name', text: '划线笔记' });
    name.createEl('small', { text: ' / Underline Notes' });
    this.sidebar.createDiv({ text: '让读过的，成为自己的。', cls: 'nt-tagline' });
    const stats = this.sidebar.createDiv({ cls: 'nt-counts' });
    for (const [value, label] of [[this.memos.length, '卡片'], [this.articles.length, '文章'], [new Set(this.memos.flatMap(memo => memo.tags)).size, '标签']]) {
      const item = stats.createDiv(); item.createEl('strong', { text: String(value) }); item.createSpan({ text: String(label) });
    }
    this.renderHeatmap();
    const nav = this.sidebar.createEl('nav');
    for (const [mode, label, icon] of [['all', '全部笔记', 'layers'], ['sources', '按来源', 'library'], ['inbox', '待消化', 'inbox'], ['review', '每日回顾', 'sparkles'], ['history', '阅读足迹', 'book-open']]) {
      button(nav, label, icon, () => { this.mode = mode; this.selectedSource = ''; this.tag = ''; this.reviewIndex = 0; this.pageSize = 30; this.renderNavigation(); this.renderFeed(); }, mode === this.mode && !this.tag ? 'is-active' : '');
    }
    this.sidebar.createDiv({ text: '我的标签', cls: 'nt-label' });
    const tags = this.sidebar.createDiv({ cls: 'nt-tags-nav' });
    const tree = tagTree(this.memos);
    if (!tree.length) tags.createEl('p', { text: '配置 AI 后，保存即自动归类。\n也可手写 #领域/写作。', cls: 'nt-muted' });
    const renderTags = (parent: HTMLElement, branches: TagBranch[]) => {
      for (const { tag, count, children } of branches) {
        const row = parent.createDiv({ cls: 'nt-tag-row' });
        if (children.length) {
          const expanded = !this.collapsedTags.has(tag);
          const toggle = button(row, (expanded ? '收起 ' : '展开 ') + tag, expanded ? 'chevron-down' : 'chevron-right', () => {
            if (expanded) this.collapsedTags.add(tag); else this.collapsedTags.delete(tag);
            this.renderNavigation();
          }, 'nt-tag-toggle');
          toggle.setAttribute('aria-expanded', String(expanded));
        }
        const item = button(row, tag, children.length ? '' : 'hash', () => { this.tag = this.tag === tag ? '' : tag; this.mode = 'all'; this.selectedSource = ''; this.pageSize = 30; this.renderNavigation(); this.renderFeed(); }, this.tag === tag ? 'is-active' : '');
        item.querySelector('span:last-child')!.textContent = tag.split('/').at(-1)!;
        item.createSpan({ text: String(count), cls: 'nt-tag-count' });
        if (children.length && !this.collapsedTags.has(tag)) renderTags(parent.createDiv({ cls: 'nt-tag-children' }), children);
      }
    };
    renderTags(tags, tree);
    this.sidebar.createDiv({ text: '●  保存在你的 Obsidian', cls: 'nt-local' });
  }
  private renderFeed() {
    if (!this.feed) return;
    this.removeChild(this.renderContext); this.renderContext = new Component(); this.addChild(this.renderContext);
    this.feed.empty();
    this.composer.hidden = ['review', 'history', 'sources', 'day'].includes(this.mode);
    this.search.hidden = this.mode === 'sources' && !!this.selectedSource;
    const titles: Record<string, string> = { all: '全部笔记', sources: '按来源', inbox: '待消化', review: '与过去的想法重逢', history: '阅读足迹' };
    const byDay = this.mode === 'day';
    this.heading.setText(byDay ? new Date(this.selectedDay).toLocaleDateString('zh-CN') + ' 的笔记' : this.tag ? '#' + this.tag : titles[this.mode]);
    if (this.mode === 'history') { this.renderHistory(); return; }
    if (this.mode === 'sources') { this.renderSources(); return; }
    const memos = byDay ? this.memos.filter(memo => new Date(memo.createdAt).toDateString() === this.selectedDay) : this.memos;
    const filtered = filterMemos(memos, this.query, this.tag, this.mode);
    this.summary.setText(this.mode === 'inbox' ? '摘录已经留下，再写一句自己的理解。' : '每一个想法，都值得再看一眼');
    if (!filtered.length) {
      if (byDay && !this.query) {
        this.empty('这一天没有笔记', '点击其他日期，或从左侧返回全部笔记。');
        return;
      }
      this.empty(this.query || this.tag ? '还没有找到这条线索' : '从一个想法开始', this.query || this.tag ? '试试更短的关键词，或选择其他标签。' : '在 Chrome 划线，或在上方记下一句话。它们会在这里相遇。'); return;
    }
    if (this.mode === 'review') {
      const today = new Date().toLocaleDateString('en-CA');
      const selected = reviewMemos(filtered, today);
      this.reviewIndex = Math.min(this.reviewIndex, selected.length - 1);
      this.summary.setText('今天回顾 ' + selected.length + ' 张 · 不急，想一想它和现在的你有什么关系。');
      const progress = this.feed.createDiv({ cls: 'nt-review-progress' });
      progress.createSpan({ text: String(this.reviewIndex + 1).padStart(2, '0') + ' / ' + String(selected.length).padStart(2, '0') });
      const track = progress.createDiv(); track.createSpan({ attr: { style: 'width:' + (this.reviewIndex + 1) / selected.length * 100 + '%' } });
      this.renderCard(selected[this.reviewIndex], this.feed, true);
      const controls = this.feed.createDiv({ cls: 'nt-review-controls' });
      button(controls, '上一张', 'arrow-left', () => { this.reviewIndex--; this.renderFeed(); }).disabled = this.reviewIndex === 0;
      button(controls, this.reviewIndex === selected.length - 1 ? '完成回顾' : '下一张', 'arrow-right', () => {
        if (this.reviewIndex === selected.length - 1) { this.feed.empty(); this.empty('今天的回顾完成了', '带着一个新的理解，回到生活中去。'); button(this.feed, '回到卡片', 'layers', () => { this.mode = 'all'; this.renderNavigation(); this.renderFeed(); }); }
        else { this.reviewIndex++; this.renderFeed(); }
      }, 'nt-primary');
    } else {
      for (const memo of filtered.slice(0, this.pageSize)) this.renderCard(memo, this.feed);
      if (filtered.length > this.pageSize) button(this.feed, '再看一些', 'chevron-down', () => { this.pageSize += 30; this.renderFeed(); }, 'nt-load-more');
    }
  }
  private renderCard(memo: Memo, parent: HTMLElement, review = false) {
    const card = parent.createEl('article', { cls: 'nt-memo' + (review ? ' nt-review-card' : ''), attr: { 'data-memo-id': memo.id } });
    card.addEventListener('dblclick', event => {
      if ((event.target as Element).closest('button, a, input, textarea, [role="button"], .nt-edit')) return;
      this.editMemo(memo, card);
    });
    const head = card.createDiv({ cls: 'nt-memo-head' });
    head.createEl('time', { text: date(memo.createdAt), attr: { datetime: memo.createdAt } });
    if (this.selectedSource && this.mode === 'sources') head.createSpan({ text: memo.image ? '图片笔记' : memo.quote ? '摘录与批注' : memoImage(memo) ? '图片笔记' : memo.articleId ? '文章笔记' : '随手记', cls: 'nt-record-kind' });
    const more = button(head, '更多操作', 'ellipsis', () => {
      // The macOS native menu drops the warning color on destructive actions.
      const menu = new Menu().setUseNativeMenu(false);
      menu.addItem(item => item.setTitle(memo.articleId ? '编辑' : '补写想法').setIcon('pencil-line').onClick(() => this.editMemo(memo, card)));
      menu.addItem(item => item.setTitle('打开').setIcon('arrow-up-right').onClick(() => void this.app.workspace.openLinkText(memo.path, '', true)));
      menu.addItem(item => item.setTitle('删除').setWarning(true).setIcon('trash-2').onClick(() => this.deleteMemo(memo)));
      more.setAttribute('aria-expanded', 'true');
      menu.onHide(() => more.setAttribute('aria-expanded', 'false'));
      const bounds = more.getBoundingClientRect();
      menu.showAtPosition({ x: bounds.left, y: bounds.bottom + 4 }, more.ownerDocument);
    }, 'nt-icon-button');
    more.setAttribute('aria-haspopup', 'menu');
    more.setAttribute('aria-expanded', 'false');
    const selectTag = (tag: string) => { this.tag = tag; this.mode = 'all'; this.selectedSource = ''; this.pageSize = 30; this.renderNavigation(); this.renderFeed(); };
    const tagButtons = new Map<string, HTMLElement>();
    if (memo.tags.length) {
      const tags = card.createDiv({ cls: 'nt-card-tags', attr: { 'aria-label': '卡片标签' } });
      for (const tag of memo.tags) {
        if (tagButtons.has(tag.toLocaleLowerCase())) continue;
        const item = button(tags, '#' + tag, '', () => selectTag(tag), 'nt-card-tag');
        tagButtons.set(tag.toLocaleLowerCase(), item);
        if (memo.aiTags?.includes(tag)) item.title = '自动标签：' + tag;
      }
    }
    const body = [memo.note, memo.personal].filter(Boolean).join('\n\n');
    if (body) {
      const thought = card.createDiv({ cls: 'nt-thought markdown-rendered' });
      void MarkdownRenderer.render(this.app, body, thought, memo.path, this.renderContext).then(() => {
        // Use rendered tag links so code samples and ordinary Markdown are untouched.
        for (const link of thought.querySelectorAll<HTMLAnchorElement>('a.tag')) {
          const tag = (link.textContent || '').trim().replace(/^#/, '');
          tagButtons.get(tag.toLocaleLowerCase())?.remove();
          link.addEventListener('click', event => {
            event.preventDefault(); event.stopPropagation(); selectTag(tag);
          });
        }
        const tags = card.querySelector('.nt-card-tags');
        if (tags && !tags.childElementCount) tags.remove();
      });
    }
    if (memo.image) void MarkdownRenderer.render(this.app, memo.image, card.createDiv({ cls: 'nt-image markdown-rendered' }), memo.path, this.renderContext);
    if (memo.quote) {
      const quote = card.createEl('blockquote', { text: memo.quote, cls: 'nt-quote' + (!memo.note && !memo.personal ? ' nt-quote-primary' : '') });
      if (memo.articleId && !memo.image) {
        quote.addClass('nt-quote-link');
        quote.setAttribute('role', 'button');
        quote.setAttribute('tabindex', '0');
        quote.setAttribute('aria-label', '在原文中查看摘录：' + memo.quote);
        quote.setAttribute('title', '点击查看原文');
        quote.addEventListener('click', () => {
          const selection = quote.ownerDocument.getSelection();
          if (selection && !selection.isCollapsed && quote.contains(selection.anchorNode) && quote.contains(selection.focusNode)) return;
          void this.openArticle(memo.articleId, memo);
        });
        quote.addEventListener('keydown', event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            void this.openArticle(memo.articleId, memo);
          }
        });
      }
    }
    if (!memo.note && !memo.quote && !memo.personal) card.createEl('p', { text: memo.title, cls: 'nt-thought' });
    if ((memo.articleId || memo.url) && !(this.mode === 'sources' && this.selectedSource)) {
      const source = button(card, (memo.source || memo.url || '查看同源记录') + ' · ' + (memo.publishedDate || '未知日期'), '', () => this.openSource(sourceKey(memo)), 'nt-source');
      if (URL.canParse(memo.url) && /^https?:\/\//i.test(memo.url)) {
        const fallback = new URL('/favicon.ico', memo.url).href;
        const captured = memo.faviconUrl || '';
        const icon = source.ownerDocument.createElement('img');
        icon.alt = '';
        icon.loading = 'lazy';
        icon.referrerPolicy = 'no-referrer';
        icon.onerror = () => {
          if (icon.src === fallback) icon.remove();
          else icon.src = fallback;
        };
        icon.src = /^(?:https?:\/\/|data:image\/)/i.test(captured) ? captured : fallback;
        source.prepend(icon);
      }
    }
    card.createDiv({ cls: 'nt-tag-status', text: this.plugin.tagStatus.get(memo.id) || '', attr: { role: 'status' } });
    if (this.drafts.has(memo.id)) this.editMemo(memo, card, false);
  }
  refreshTagStatus() {
    if (this.closed || !this.feed) return;
    for (const card of this.feed.querySelectorAll<HTMLElement>('[data-memo-id]')) {
      const status = card.querySelector<HTMLElement>('.nt-tag-status');
      if (status) status.setText(this.plugin.tagStatus.get(card.dataset.memoId!) || '');
    }
  }
  private openSource(key: string) {
    this.mode = 'sources'; this.selectedSource = key; this.tag = '';
    this.drawer.hidden = true; this.shell.removeClass('has-reader');
    this.renderNavigation(); this.renderFeed();
    this.heading.focus();
    this.heading.closest('.nt-main')?.scrollTo({ top: 0 });
  }
  private sourceDomain(group: SourceGroup) {
    try {
      const hostname = new URL(group.url).hostname;
      const publishedDate = group.memos.find(memo => memo.publishedDate)?.publishedDate;
      return hostname + ' · ' + (publishedDate || '未知日期');
    } catch { return group.key === 'local' ? '独立记录' : '来源地址不可用'; }
  }
  private renderSources() {
    const groups = groupMemosBySource(this.memos);
    if (this.selectedSource) {
      button(this.feed, '返回来源列表', 'arrow-left', () => {
        this.selectedSource = ''; this.renderFeed(); this.heading.focus();
      }, 'nt-source-back');
      const group = groups.find(item => item.key === this.selectedSource);
      if (!group) {
        this.summary.setText('此来源已没有卡片');
        this.empty('记录已移走或删除', '返回来源列表，查看其他阅读记录。'); return;
      }
      this.heading.setText(group.title);
      this.summary.setText(this.sourceDomain(group) + ' · ' + group.memos.length + ' 条记录 · 按记录时间排列');
      const overview = this.feed.createDiv({ cls: 'nt-source-overview' });
      overview.createSpan({ text: '最近更新 ' + date(group.updatedAt), cls: 'nt-muted' });
      const actions = overview.createDiv({ cls: 'nt-source-actions' });
      if (this.articles.some(article => article.id === group.articleId)) button(actions, '本地全文', 'book-open', () => void this.openArticle(group.articleId), 'nt-quiet');
      if (/^https?:\/\//i.test(group.url)) actions.createEl('a', { text: '打开原文 ↗', href: group.url, attr: { target: '_blank', rel: 'noopener noreferrer' } });
      for (const memo of group.memos) this.renderCard(memo, this.feed);
      return;
    }
    const filtered = filterSourceGroups(groups, this.query);
    this.summary.setText(filtered.length + ' 组来源 · ' + filtered.reduce((count, group) => count + group.memos.length, 0) + ' 条记录 · 按最近更新排列');
    if (!filtered.length) {
      this.empty(this.query ? '没有找到相关来源' : '把同一篇文章的想法放在一起', this.query ? '试试文章标题、域名，或笔记里的关键词。' : '记录摘录或文章笔记后，会自动按来源归组。'); return;
    }
    for (const group of filtered.slice(0, this.pageSize)) {
      const card = this.feed.createEl('article', { cls: 'nt-source-card', attr: { 'data-source-key': group.key } });
      const meta = card.createDiv({ cls: 'nt-source-meta' });
      meta.createSpan({ text: this.sourceDomain(group) });
      meta.createSpan({ text: group.memos.length + ' 条记录', cls: 'nt-source-count' });
      const heading = card.createEl('h2');
      button(heading, group.title, '', () => this.openSource(group.key), 'nt-source-title');
      const excerpts = card.createDiv({ cls: 'nt-source-excerpts' });
      for (const memo of group.memos.slice(-2)) excerpts.createEl('p', { text: memoExcerpt(memo) });
      const images = group.memos.map(memo => ({ memo, image: memoImage(memo) })).filter(item => item.image).slice(0, 3);
      if (images.length) {
        const thumbnails = card.createDiv({ cls: 'nt-source-images' });
        for (const { memo, image } of images) void MarkdownRenderer.render(this.app, image, thumbnails.createDiv({ cls: 'markdown-rendered' }), memo.path, this.renderContext);
      }
      const footer = card.createDiv({ cls: 'nt-source-card-footer' });
      footer.createEl('time', { text: '最近更新 ' + date(group.updatedAt), attr: { datetime: group.updatedAt } });
      button(footer, '查看全部记录', 'arrow-right', () => this.openSource(group.key), 'nt-quiet');
    }
    if (filtered.length > this.pageSize) button(this.feed, '更多来源', 'chevron-down', () => { this.pageSize += 30; this.renderFeed(); }, 'nt-load-more');
  }
  private async deleteMemo(memo: Memo) {
    try {
      const file = this.app.vault.getAbstractFileByPath(memo.path);
      if (!(file instanceof TFile)) throw new Error('卡片已被移动或删除。');
      // Stage intent first. The browser consumes it only after the card is gone.
      const marker = memo.articleId ? file.path + DELETE_MARKER_SUFFIX : undefined;
      if (marker) await this.app.vault.adapter.write(marker, '');
      try {
        if (await this.app.fileManager.promptForDeletion(file)) {
          this.drafts.delete(memo.id);
          await this.refresh();
        }
      } finally {
        if (marker && this.app.vault.getAbstractFileByPath(memo.path) === file) {
          await this.app.vault.adapter.remove(marker);
        }
      }
    } catch (error) { new Notice(error instanceof Error ? error.message : String(error)); }
  }
  private editMemo(memo: Memo, card: HTMLElement, focus = true) {
    if (card.querySelector('.nt-edit')) return;
    const draft = this.drafts.get(memo.id) || { text: [memo.note, memo.personal].filter(Boolean).join('\n\n'), tail: memo.tail, expectedNote: memo.note };
    this.drafts.set(memo.id, draft);
    const editor = card.createDiv({ cls: 'nt-edit' });
    card.insertBefore(editor, card.querySelector('.nt-thought, .nt-image, .nt-quote, .nt-source, .nt-tag-status'));
    const preview = card.querySelector<HTMLElement>('.nt-thought');
    if (preview) preview.hidden = true;
    const input = editor.createEl('textarea', { attr: { 'aria-label': memo.articleId ? '编辑笔记' : '补写想法', placeholder: '写下笔记…', rows: '5' } });
    input.value = draft.text;
    input.addEventListener('input', () => { draft.text = input.value; });
    const actions = editor.createDiv({ cls: 'nt-edit-actions' });
    button(actions, '取消', '', () => { this.drafts.delete(memo.id); editor.remove(); if (preview) preview.hidden = false; });
    const commit = async () => {
      save.disabled = true;
      try {
        const file = this.app.vault.getAbstractFileByPath(memo.path);
        if (!(file instanceof TFile)) throw new Error('卡片已被移动或删除。');
        await this.app.vault.process(file, current => {
          if (!memo.articleId) return updateThoughts(current, draft.tail, draft.text);
          return updateThoughts(updateCardNote(current, draft.expectedNote, draft.text), draft.tail, '');
        });
        this.drafts.delete(memo.id); editor.remove(); await this.refresh(); new Notice(memo.articleId ? '笔记已保存，等待浏览器同步' : '想法已保存');
        this.plugin.scheduleTags(file);
      } catch (error) { new Notice(error instanceof Error ? error.message : String(error)); }
      finally { save.disabled = false; }
    };
    const save = button(actions, memo.articleId ? '保存笔记' : '保存想法', 'check', () => void commit(), 'nt-primary');
    input.addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); if (!save.disabled) void commit(); } });
    if (focus) input.focus();
  }
  private renderHistory() {
    const terms = this.query.toLocaleLowerCase().trim();
    const articles = this.articles.filter(article => (article.title + '\n' + article.body).toLocaleLowerCase().includes(terms));
    this.summary.setText(articles.length + ' 篇保存的文章 · 正文就在这里，随时接着读');
    if (!articles.length) { this.empty('还没有阅读足迹', '在 Chrome 中读一篇文章，停留片刻后会自动收录。'); return; }
    for (const article of articles.slice(0, this.pageSize)) {
      const item = this.feed.createEl('article', { cls: 'nt-history-item' });
      item.createEl('time', { text: date(article.createdAt) + (article.minutes ? ' · ' + article.minutes + ' 分钟' : '') });
      item.createEl('h2', { text: article.title });
      item.createEl('p', { text: article.body.replace(/[#>*_`\[\]]/g, '').slice(0, 200), cls: 'nt-history-excerpt' });
      button(item, '接着读', 'arrow-right', () => void this.showArticle(article), 'nt-quiet');
    }
    if (articles.length > this.pageSize) button(this.feed, '再看一些', 'chevron-down', () => { this.pageSize += 30; this.renderFeed(); });
  }
  private async openArticle(id: string, memo?: Memo) {
    const article = this.articles.find(article => article.id === id);
    if (!article) { new Notice('这篇文章的本地正文已移走或尚未写入。摘录仍保留在卡片中。'); return; }
    try { await this.showArticle(article, memo); }
    catch { new Notice('无法打开本地全文，请稍后重试。'); }
  }
  private async quoteContexts(memo: Memo): Promise<QuoteContext[]> {
    const contexts: QuoteContext[] = [];
    // The saved browser anchor can distinguish identical quotes. Its page offsets
    // cannot be reused after conversion to Markdown, so only use surrounding text.
    if (/^[a-zA-Z0-9_-]+$/.test(memo.articleId)) {
      try {
        const file = this.app.vault.getAbstractFileByPath(this.plugin.folder + '/Data/articles/' + memo.articleId + '.json');
        if (file instanceof TFile) {
          const data = JSON.parse(await this.app.vault.cachedRead(file));
          const anchor = data.article?.annotations?.find((item: { id: string }) => item.id === memo.id)?.anchor;
          if (typeof anchor?.exact === 'string' && anchor.exact.replace(/\s+/g, '') === memo.quote.replace(/\s+/g, '') && typeof anchor.prefix === 'string' && typeof anchor.suffix === 'string') contexts.push(anchor);
        }
      } catch { /* Older vaults may only contain Markdown cards. */ }
    }
    const context = contextForQuote(memo.context, memo.quote);
    if (context) contexts.push(context);
    return contexts;
  }
  private async showArticle(article: ArticlePreview, memo?: Memo) {
    this.removeChild(this.drawerContext); this.drawerContext = new Component(); this.addChild(this.drawerContext);
    this.drawer.empty(); this.drawer.hidden = false; this.shell.addClass('has-reader');
    const header = this.drawer.createDiv({ cls: 'nt-reader-header' });
    header.createSpan({ text: '本地全文' });
    button(header, '收起全文', 'x', () => { this.drawer.hidden = true; this.shell.removeClass('has-reader'); }, 'nt-icon-button');
    const body = this.drawer.createDiv({ cls: 'nt-reader-body' });
    body.createEl('h2', { text: article.title });
    body.createEl('p', { text: date(article.createdAt), cls: 'nt-muted' });
    const rendered = body.createDiv({ cls: 'markdown-rendered' });
    const [, contexts] = await Promise.all([
      MarkdownRenderer.render(this.app, article.body || '尚未保存正文，重新打开网页阅读后可补存。', rendered, article.path, this.drawerContext),
      memo ? this.quoteContexts(memo) : Promise.resolve([]),
    ]);
    // A newer click or a closed reader must not receive an older render's scroll.
    if (this.closed || this.drawer.hidden || !this.drawer.contains(body)) return;
    button(body, '在笔记中打开', 'arrow-up-right', () => void this.app.workspace.openLinkText(article.path, '', true), 'nt-quiet');
    if (/^https?:\/\//.test(article.source)) body.createEl('a', { text: '访问网页来源 ↗', href: article.source, cls: 'nt-web-source', attr: { target: '_blank', rel: 'noopener noreferrer' } });
    if (memo) {
      const marks = highlightReaderQuote(rendered, memo.quote, contexts);
      if (marks.length) {
        const target = marks[0];
        target.setAttribute('tabindex', '-1');
        target.focus({ preventScroll: true });
        body.scrollTop += target.getBoundingClientRect().top - body.getBoundingClientRect().top - body.clientHeight / 2;
      } else {
        const status = header.createSpan({ text: '未能定位摘录', attr: { role: 'status' } });
        status.title = '本地正文可能已变化，或包含多处相同文字。';
        new Notice('已打开本地全文，但未能唯一定位这条摘录。正文可能已变化，或包含多处相同文字。');
      }
    }
  }
  private empty(title: string, description: string) {
    const blank = this.feed.createDiv({ cls: 'nt-empty' });
    setIcon(blank.createSpan(), 'sprout'); blank.createEl('h2', { text: title }); blank.createEl('p', { text: description });
  }
}
