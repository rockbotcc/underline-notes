// Browser test adapter for Obsidian's documented APIs; never shipped in the plugin.
const root = window as any;
for (const [name, implementation] of Object.entries({
  empty(this: HTMLElement) { this.replaceChildren(); },
  setText(this: HTMLElement, text: string) { this.textContent = text; },
  addClass(this: HTMLElement, name: string) { this.classList.add(name); },
  removeClass(this: HTMLElement, name: string) { this.classList.remove(name); },
  createEl(this: HTMLElement, tag: string, options: any = {}) {
    const element = document.createElement(tag);
    if (options.cls) element.className = options.cls;
    if (options.text) element.textContent = options.text;
    if (options.type) element.setAttribute('type', options.type);
    if (options.href) element.setAttribute('href', options.href);
    for (const [key, value] of Object.entries(options.attr || {})) element.setAttribute(key, String(value));
    this.append(element); return element;
  },
  createDiv(this: any, options?: any) { return this.createEl('div', options); },
  createSpan(this: any, options?: any) { return this.createEl('span', options); },
})) Object.defineProperty(HTMLElement.prototype, name, { value: implementation, configurable: true });

export class Component { addChild() {} removeChild() {} registerEvent() {} }
export class Menu {
  private element: any;
  private hidden = () => {};
  private previous = document.activeElement as HTMLElement | null;
  constructor() { this.element = (document.body as any).createDiv({ attr: { role: 'menu' } }); }
  setUseNativeMenu(_value: boolean) { return this; }
  addItem(callback: any) {
    const button = this.element.createEl('button', { attr: { role: 'menuitem' } });
    const item = {
      setTitle(value: string) { button.textContent = value; return item; },
      setIcon() { return item; },
      setWarning(value: boolean) { button.classList.toggle('is-warning', value); return item; },
      onClick: (action: () => void) => { button.addEventListener('click', () => { this.hide(); action(); }); return item; },
    };
    callback(item); return this;
  }
  onHide(callback: () => void) { this.hidden = callback; }
  showAtPosition(position: { x: number; y: number }) {
    Object.assign(this.element.style, { position: 'fixed', left: position.x + 'px', top: position.y + 'px', zIndex: '30', padding: '8px', background: 'white', boxShadow: '0 4px 20px #0002' });
    this.element.querySelector('button').focus();
    this.element.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); this.hide(); }
    });
  }
  hide() { this.element.remove(); this.hidden(); this.previous?.focus(); }
}
export class Modal {
  app: any; modalEl: any; contentEl: any; titleEl: any;
  constructor(app: any) {
    this.app = app;
    this.modalEl = (document.body as any).createDiv({ cls: 'modal', attr: { role: 'dialog' } });
    this.titleEl = this.modalEl.createEl('h2');
    const close = this.modalEl.createEl('button', { text: '关闭讨论' }); close.addEventListener('click', () => this.close());
    this.contentEl = this.modalEl.createDiv({ cls: 'modal-content' });
  }
  open() { this.onOpen(); }
  close() { this.onClose(); this.modalEl.remove(); }
  onOpen() {} onClose() {}
}
export class ItemView extends Component {
  app: any; contentEl: HTMLElement;
  constructor(leaf: any) {
    super(); this.app = leaf.app; this.contentEl = document.querySelector('#view')!;
    this.contentEl.classList.add('view-content');
    this.contentEl.parentElement!.classList.add('workspace-leaf-content');
    this.contentEl.parentElement!.setAttribute('data-type', 'noting-cardbox');
  }
}
export class TFile {
  path: string; stat = { mtime: Date.now() }; basename: string;
  constructor(path: string) { this.path = path; this.basename = path.split('/').at(-1)!.replace(/\.md$/, ''); }
}
export class Notice { constructor(message: string) { root.notices.push(message); document.querySelector('#notice')!.textContent = message; } }
export class Plugin extends Component {
  app: any;
  constructor(app: any) { super(); this.app = app; }
  async loadData() { return JSON.parse(localStorage.getItem('plugin-data') || 'null'); }
  async saveData(data: any) { if (root.failSaveDataOnce) { root.failSaveDataOnce = false; throw new Error('模拟配置保存失败'); } localStorage.setItem('plugin-data', JSON.stringify(data)); }
  registerView(_: string, factory: any) { root.viewFactory = factory; }
  addRibbonIcon() {} addCommand() {} registerObsidianProtocolHandler() {} addSettingTab(tab: any) { root.settingsTab = tab; }
}
export class PluginSettingTab {
  app: any; containerEl = document.querySelector('#settings')!;
  constructor(app: any) { this.app = app; }
}
export class Setting {
  element: any;
  constructor(parent: any) { this.element = parent.createDiv({ cls: 'setting-item' }); }
  setName(name: string) { this.element.createEl('label', { text: name }); this.element.dataset.name = name; return this; }
  setDesc(text: string) { this.element.createEl('p', { text }); return this; }
  addText(callback: any) {
    const input = this.element.createEl('input'); input.setAttribute('aria-label', this.element.dataset.name);
    const control = { inputEl: input, setPlaceholder(value: string) { input.placeholder = value; return control; }, setValue(value: string) { input.value = value; return control; }, onChange(handler: any) { input.addEventListener('input', () => handler(input.value)); return control; } };
    callback(control); return this;
  }
  addToggle(callback: any) {
    const input = this.element.createEl('input', { type: 'checkbox' }); input.setAttribute('aria-label', this.element.dataset.name);
    const control = { setValue(value: boolean) { input.checked = value; return control; }, onChange(handler: any) { input.addEventListener('change', () => handler(input.checked)); return control; } }; callback(control); return this;
  }
  addButton(callback: any) {
    const element = this.element.createEl('button');
    const control = { setButtonText(value: string) { element.textContent = value; return control; }, setDisabled(value: boolean) { element.disabled = value; return control; }, onClick(handler: any) { element.addEventListener('click', handler); return control; } }; callback(control); return this;
  }
}
export const MarkdownRenderer = { async render(_app: any, text: string, element: HTMLElement) {
  if (await root.renderMarkdown?.(text, element)) return;
  for (const paragraph of text.split(/\n\s*\n/)) {
    const p = document.createElement('p'); p.textContent = paragraph; element.append(p);
  }
} };
export function normalizePath(path: string) { return path.replace(/\/{2,}/g, '/').replace(/\/$/, ''); }
export function parseYaml(text: string) {
  return Object.fromEntries(text.split('\n').filter(line => line.includes(':')).map(line => { const split = line.indexOf(':'); const value = line.slice(split + 1).trim(); return [line.slice(0, split), value.startsWith('"') ? JSON.parse(value) : value]; }));
}
export function setIcon(element: HTMLElement, icon: string) {
  element.setAttribute('data-icon', icon);
  if (icon === 'ellipsis') {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'currentColor');
    for (const x of [5, 12, 19]) {
      const dot = document.createElementNS(svg.namespaceURI, 'circle');
      dot.setAttribute('cx', String(x)); dot.setAttribute('cy', '12'); dot.setAttribute('r', '1.7'); svg.append(dot);
    }
    element.append(svg);
  }
}
export async function requestUrl(options: any) { const response = await fetch(options.url, options); return { status: response.status, text: await response.text() }; }
export type App = any;
export type WorkspaceLeaf = any;
