import NotingPlugin from '../obsidian/main';
import { TFile } from './obsidian-stub';
import { localMemo } from '../obsidian/cards';
import { articleCards, articleMarkdown } from '../shared/markdown';
const root = window as any;
root.notices = [];
const initial: Record<string, string> = Object.fromEntries([
  ['one', 'AI 提升编码效率\n代码生成速度越来越快。'],
  ['two', '代码评审的瓶颈\n审查时间限制了团队交付效率。'],
  ['three', '测试自动化与质量\n自动化测试帮助团队减少回归问题。'],
].map(([id, text]) => ['Reading/Cards/Local/' + id + '.md', localMemo(text, id, '2026-11-05T08:00:00Z')]));
const files: Record<string, string> = JSON.parse(localStorage.getItem('vault-files') || 'null') || initial;
const listeners: Record<string, Function[]> = {};
const handles = new Map(Object.keys(files).map(path => [path, new TFile(path)]));
const save = () => localStorage.setItem('vault-files', JSON.stringify(files));
const changed = (file: TFile) => { file.stat.mtime = Date.now(); save(); for (const fn of listeners.modify || []) fn(file); };
const vault = {
  adapter: {
    write: async (path: string, text: string) => { files[path] = text; save(); },
    remove: async (path: string) => { delete files[path]; save(); },
  },
  getMarkdownFiles: () => [...handles.values()].filter(file => file.path.endsWith('.md')),
  getAbstractFileByPath: (path: string) => handles.get(path),
  read: async (file: TFile) => files[file.path], cachedRead: async (file: TFile) => files[file.path],
  process: async (file: TFile, update: (text: string) => string) => {
    if (root.failPath === file.path) { root.failPath = ''; throw new Error('模拟第二张笔记写入失败'); }
    files[file.path] = update(files[file.path]); changed(file);
  },
  createFolder: async () => {},
  create: async (path: string, text: string) => { if (files[path]) throw new Error('File exists'); files[path] = text; const file = new TFile(path); handles.set(path, file); changed(file); if (root.failAfterCreate) { root.failAfterCreate = false; root.failSaveDataOnce = true; } },
  on: (event: string, listener: Function) => { (listeners[event] ||= []).push(listener); },
};
const app: any = { vault, workspace: { on() {}, onLayoutReady(callback: () => void) { callback(); }, getLeavesOfType: () => root.view ? [{ view: root.view }] : [], openLinkText: async (path: string) => { root.openedPath = path; } } };
app.fileManager = {
  promptForDeletion: async (file: TFile) => {
    if (!window.confirm(file.path)) return false;
    delete files[file.path];
    handles.delete(file.path);
    save();
    for (const listener of listeners.delete || []) listener(file);
    return true;
  },
};
root.files = files;
root.modify = (id: string, text: string) => { const file = handles.get('Reading/Cards/Local/' + id + '.md')!; files[file.path] = localMemo(text, id, '2026-11-05T08:00:00Z'); changed(file); };
root.rename = (id: string) => { const oldPath = 'Reading/Cards/Local/' + id + '.md', next = 'Reading/Cards/Local/renamed-' + id + '.md'; files[next] = files[oldPath]; delete files[oldPath]; handles.delete(oldPath); const file = new TFile(next); handles.set(next, file); save(); (listeners.rename || []).forEach(fn => fn(file, oldPath)); };
root.plugin = new NotingPlugin(app, {} as any);
await root.plugin.onload();
root.view = root.viewFactory({ app });
await root.view.onOpen();
root.settingsTab.display();
root.ready = true;

root.prepareReader = async () => {
  const exact = '对应的划线穿过链接。';
  const filler = Array.from({ length: 35 }, (_, index) => '正文段落 ' + index + '，这里保存了阅读材料。'.repeat(8));
  const paragraphs = ['顶部唯一摘录。', '前文甲。对应的**划线**穿过[链接](https://example.com)。后文甲。', ...filler, '前文乙。对应的**划线**穿过[链接](https://example.com)。后文乙。', ...filler];
  const article = {
    id: 'a_reader', title: '原文定位测试', url: 'https://example.com', hostname: 'example.com', createdAt: '2026-11-05', updatedAt: '2026-11-05', pageNote: '',
    bodyText: paragraphs.join('\n').replace(/\*\*/g, '').replace(/\[链接\]\(https:\/\/example.com\)/g, '链接'), bodyMarkdown: paragraphs.join('\n\n'),
    annotations: [
      ['h_reader', exact, '前文乙。', '后文乙。'], ['h_top', '顶部唯一摘录。', '', ''],
      ['h_ambiguous', exact, '', ''], ['h_missing', '完全缺失的摘录。', '', ''],
    ].map(([id, exact, prefix, suffix]) => ({ id, color: 'yellow' as const, note: '', createdAt: '2026-11-05', updatedAt: '2026-11-05', anchor: { exact, prefix, suffix, start: 0, end: exact.length } })),
  };
  root.readerArticle = article;
  root.renderMarkdown = async (text: string, element: HTMLElement) => {
    if (text !== article.bodyMarkdown) return false;
    if (root.readerDelay) await new Promise(resolve => setTimeout(resolve, root.readerDelay));
    // Controlled fixture HTML models Markdown's inline and paragraph boundaries.
    element.innerHTML = paragraphs.map(text => '<p>' + text.replace(/\*\*划线\*\*/g, '<strong>划线</strong>').replace(/\[链接\]\(https:\/\/example.com\)/g, '<a href="https://example.com">链接</a>') + '</p>').join('');
    return true;
  };
  for (const card of articleCards(article)) {
    // Exercise the saved JSON anchor independently of the optional context block.
    const legacyThought = card.id === 'h_reader' ? '\n## 延伸思考\n\n旧卡片的补充想法' : '';
    await vault.create('Reading/' + card.path, card.markdown.replace(/<!-- noting:context:start -->[\s\S]*?<!-- noting:context:end -->/, '') + legacyThought);
  }
  await vault.create('Reading/Articles/a_reader.md', articleMarkdown(article, []));
  await vault.create('Reading/Data/articles/a_reader.json', JSON.stringify({ schemaVersion: 1, article }));
  await root.view.refresh();
};
