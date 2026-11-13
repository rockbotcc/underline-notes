import { Plugin, openTab } from 'siyuan';
import { QuickNoteStore, validateQuickDraft } from './quick-note.ts';
import { Cardbox } from './view.ts';
import { ThoughtStore, type Drafts, type Request } from './cards.ts';

const TYPE = 'cardbox';
const ICON = 'iconUnderlineCardbox';
export default class UnderlinePlugin extends Plugin {
  private views = new Map<Element, Cardbox>();
  private store!: ThoughtStore;
  private quick!: QuickNoteStore;
  private ready!: Promise<void>;
  private changed = (event: CustomEvent) => { if (['transactions', 'syncMergeResult', 'reloadUI', 'setLocalShorthandsCount'].includes(event.detail?.cmd)) for (const view of this.views.values()) view.changed(); };
  private request: Request = async <T>(endpoint: string, body: Record<string, unknown> = {}) => {
    const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`思源请求失败（${response.status}），请重试。`);
    const result = await response.json();
    if (result.code !== 0) throw new Error('思源未能完成操作，请确认笔记本已打开、文档未删除，然后重试。');
    return result.data as T;
  };
  onload() {
    this.ready = this.initialize();
    // Handle immediately; a missing tab must not cause an unhandled rejection.
    void this.ready.catch(() => {});
    this.addIcons('<symbol id="iconUnderlineCardbox" viewBox="0 0 32 32"><path d="M5 3h22v26H5V3zm3 3v20h16V6H8zm3 4h10v2H11v-2zm0 5h10v2H11v-2zm0 5h7v2h-7v-2z"/></symbol>');
    const plugin = this;
    this.addTab({ type: TYPE,
      init() {
        const host = this.element as HTMLElement;
        host.textContent = '正在加载划线笔记…';
        void plugin.ready.then(() => {
          if (!host.isConnected) return;
          const view = new Cardbox(host, plugin.app, plugin.request, plugin.store, plugin.quick);
          plugin.views.set(host, view); void view.refresh();
        }).catch(() => { host.textContent = '草稿读取失败，请重新启用插件后重试。'; });
      },
      destroy() { plugin.views.get(this.element)?.destroy(); plugin.views.delete(this.element); },
    });
    this.addTopBar({ icon: ICON, title: '划线笔记 · 卡片盒', position: 'right', callback: () => this.open() });
    this.addCommand({ langKey: 'openCardbox', callback: () => this.open() });
    this.eventBus.on('ws-main', this.changed);
  }
  // Explicit file requests: SDK loadData can treat network errors as empty data and
  // saveData can remain pending on failed requests. Draft durability needs bounded failures.
  private async readData(name: string): Promise<unknown> {
    const path = `/data/storage/petal/${this.name}/${name}`;
    const response = await fetch('/api/file/getFile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }), signal: AbortSignal.timeout(15000) });
    const saved = await response.json();
    if (response.status === 404 || saved?.code === 404) return undefined;
    if (!response.ok || saved?.code !== undefined || !saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('草稿读取失败');
    return saved;
  }
  private async persist(name: string, data: unknown) {
    const form = new FormData(); form.set('path', `/data/storage/petal/${this.name}/${name}`); form.set('isDir', 'false');
    form.set('file', new Blob([JSON.stringify(data)], { type: 'application/json' }), name);
    const response = await fetch('/api/file/putFile', { method: 'POST', body: form, signal: AbortSignal.timeout(15000) });
    if (!response.ok || (await response.json()).code !== 0) throw new Error('草稿保存失败，请重试。');
  }
  private async initialize() {
    const [saved, quick] = await Promise.all([this.readData('drafts.json'), this.readData('quick-note.json')]);
    const drafts = (saved || {}) as Drafts;
    for (const [id, draft] of Object.entries(drafts)) {
      if (!/^\d{14}-[a-z0-9]{7}$/.test(id) || typeof draft?.text !== 'string' || (draft.attempt &&
        (!/^\d{14}-[a-z0-9]{7}$/.test(draft.attempt.id) || !/^[a-f0-9]{64}$/.test(draft.attempt.hash) || typeof draft.attempt.markdown !== 'string'))) throw new Error('草稿格式异常');
    }
    this.store = new ThoughtStore(drafts, this.request, data => this.persist('drafts.json', data));
    this.quick = new QuickNoteStore(validateQuickDraft(quick || { text: '', notebookId: '' }), this.request, data => this.persist('quick-note.json', data));
  }
  onDataChanged() { /* Explicit refresh preserves drafts and focus in this session. */ }
  private open() {
    const existing = this.getOpenedTab()[TYPE]?.find(view => view.tab.headElement.isConnected);
    if (existing) { existing.tab.parent.switchTab(existing.tab.headElement); return; }
    void openTab({ app: this.app, custom: { id: this.name + TYPE, icon: ICON, title: '划线笔记' } });
  }
  onunload() { this.eventBus.off('ws-main', this.changed); for (const view of this.views.values()) view.destroy(); this.views.clear(); }
}
