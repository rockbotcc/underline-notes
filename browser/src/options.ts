import { database, getDirectory } from './db';
import { type DirectoryHandle } from './files';
import { rpc } from './rpc';
import { DEFAULT_SETTINGS, localDay, obsidianUrl, type Settings, type Pending, type Backup, type Article, type Session } from '../../shared/model';

declare global {
  interface Window { showDirectoryPicker(options: { id: string; mode: 'readwrite' }): Promise<DirectoryHandle> }
}

interface Status {
  settings: Settings;
  directoryName: string;
  articles: number;
  annotations: number;
  pending: Pending[];
  lastSync?: string;
  syncError?: string;
}

function get<T extends HTMLElement = HTMLElement>(id: string): T { return document.getElementById(id) as T; }
let currentSettings = DEFAULT_SETTINGS;
let busy = false;

function notice(message: string, error = false) {
  const node = get('notice');
  node.textContent = message;
  node.className = error ? 'error' : '';
  node.hidden = false;
}

function action(id: string, callback: () => Promise<void>) {
  get(id).addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    const button = get<HTMLButtonElement>(id);
    button.disabled = true;
    try { await callback(); await refresh(); }
    catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) notice(error instanceof Error ? error.message : String(error), true);
    } finally { button.disabled = false; busy = false; }
  });
}

async function refresh(fillForm = false) {
  const status = await rpc<Status>({ type: 'STATUS' });
  currentSettings = status.settings;
  if (fillForm) {
    get<HTMLInputElement>('record-history').checked = currentSettings.recordHistory;
    get<HTMLTextAreaElement>('excluded-domains').value = currentSettings.excludedDomains.join('\n');
    get<HTMLInputElement>('vault-name').value = currentSettings.vaultName;
  }
  get('article-count').textContent = String(status.articles);
  get('highlight-count').textContent = String(status.annotations);
  get('pending-count').textContent = String(status.pending.length);
  get('connection-state').textContent = status.directoryName ? '文件夹已连接' : '尚未连接';
  get('folder-name').textContent = status.directoryName ? `已连接 ${currentSettings.vaultName || '本地文件夹'}/${status.directoryName}/ · 打开卡片盒.md 即可回顾摘录与想法。` : '你也可以选择普通文件夹，之后再用 Obsidian 打开。';
  get('sync-status').textContent = status.lastSync ? `最近同步 ${new Date(status.lastSync).toLocaleString()}` : '划线和笔记先保存在浏览器本地';
  const link = get<HTMLAnchorElement>('open-obsidian');
  link.hidden = !currentSettings.vaultName || !status.directoryName;
  link.href = obsidianUrl(currentSettings);
  get('authorize').hidden = !status.directoryName;
  get('sync-error').hidden = !status.syncError;
  get('sync-error').textContent = status.syncError || '';
}

async function flush() {
  await rpc({ type: 'FLUSH' });
  const status = await rpc<Status>({ type: 'STATUS' });
  if (status.syncError) throw new Error(status.syncError);
  if (!status.directoryName) { notice('请先选择 Obsidian 仓库或本地文件夹。'); return; }
  notice(status.pending.length ? '正在同步，剩余记录会继续重试。' : '笔记已双向同步，可以在浏览器或 Obsidian 中继续编辑。');
}

action('choose-directory', async () => {
  const root = await window.showDirectoryPicker({ id: 'noting-vault', mode: 'readwrite' });
  if (await root.requestPermission({ mode: 'readwrite' }) !== 'granted') throw new Error('需要文件夹读写权限');
  const directory = await root.getDirectoryHandle('Reading', { create: true });
  await navigator.locks.request('noting-file-output', async () => {
    const db = await database;
    const existing = await getDirectory();
    const sameDirectory = existing && await existing.isSameEntry(directory);
    const tx = db.transaction(['meta', 'files'], 'readwrite');
    await tx.objectStore('meta').put(directory, 'directory');
    await tx.objectStore('meta').delete('lastSync');
    await tx.objectStore('meta').delete('syncError');
    if (!sameDirectory) await tx.objectStore('files').clear();
    await tx.done;
  });
  const settings = { ...currentSettings, vaultName: root.name, vaultFolder: 'Reading' };
  await rpc({ type: 'SAVE_SETTINGS', settings });
  get<HTMLInputElement>('vault-name').value = root.name;
  // An existing exported folder must first be restored or reviewed before writing over it.
  await rpc({ type: 'REQUEUE' });
  await flush();
});

action('authorize', async () => {
  const directory = await getDirectory() as DirectoryHandle | undefined;
  if (!directory) throw new Error('请先选择文件夹');
  if (await directory.requestPermission({ mode: 'readwrite' }) !== 'granted') throw new Error('尚未取得文件夹读写权限');
  await flush();
});
action('flush', flush);

get<HTMLFormElement>('settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    await rpc({ type: 'SAVE_SETTINGS', settings: {
      ...currentSettings,
      recordHistory: get<HTMLInputElement>('record-history').checked,
      excludedDomains: get<HTMLTextAreaElement>('excluded-domains').value.split(/[\s,，]+/).filter(Boolean),
      vaultName: get<HTMLInputElement>('vault-name').value,
    } });
    await refresh(true);
    notice('设置已保存。');
  } catch (error) { notice(error instanceof Error ? error.message : String(error), true); }
});

action('export-backup', async () => {
  const backup = await rpc<Backup>({ type: 'BACKUP' });
  const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `underline-notes-backup-${localDay()}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  notice('已生成浏览器资料备份。Obsidian 中补写的内容请随仓库一起备份。');
});
action('import-backup', async () => { get<HTMLInputElement>('backup-file').click(); });
get<HTMLInputElement>('backup-file').addEventListener('change', async event => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  try {
    if (file.size > 100 * 1024 * 1024) throw new Error('备份文件超过 100 MB，请通过文件夹恢复。');
    const result = await rpc<{ articles: number; sessions: number }>({ type: 'IMPORT', backup: JSON.parse(await file.text()) });
    notice(`已合并 ${result.articles} 篇文章和 ${result.sessions} 条阅读记录。`);
    await refresh();
  } catch (error) { notice(error instanceof Error ? error.message : String(error), true); }
  finally { input.value = ''; }
});

action('restore-directory', async () => {
  const directory = await getDirectory() as DirectoryHandle | undefined;
  if (!directory) throw new Error('请先连接包含 Reading 文件夹的仓库');
  if (await directory.requestPermission({ mode: 'readwrite' }) !== 'granted') throw new Error('需要文件夹访问权限');
  const backup: Backup = { schemaVersion: 1, exportedAt: new Date().toISOString(), articles: [], sessions: [] };
  await navigator.locks.request('noting-file-output', async () => {
    const data = await directory.getDirectoryHandle('Data');
    const articles = await data.getDirectoryHandle('articles');
    for await (const handle of (articles as unknown as { values(): AsyncIterable<FileSystemHandle> }).values()) {
      if (handle.kind !== 'file' || !handle.name.endsWith('.json')) continue;
      const value = JSON.parse(await (await (handle as FileSystemFileHandle).getFile()).text());
      if (value.schemaVersion !== 1) throw new Error('文件夹格式版本不受支持');
      backup.articles.push(value.article as Article);
    }
    try {
      const history = await data.getDirectoryHandle('history');
      for await (const handle of (history as unknown as { values(): AsyncIterable<FileSystemHandle> }).values()) {
        if (handle.kind !== 'file' || !handle.name.endsWith('.jsonl')) continue;
        for (const line of (await (await (handle as FileSystemFileHandle).getFile()).text()).split('\n').filter(Boolean)) {
          const value = JSON.parse(line);
          if (value.schemaVersion !== 1) throw new Error('阅读记录格式版本不受支持');
          backup.sessions.push(value as Session);
        }
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
    }
  });
  const result = await rpc<{ articles: number; sessions: number }>({ type: 'IMPORT', backup });
  notice(`已从开放格式文件恢复 ${result.articles} 篇文章。修改过的 Markdown 会保留并提示冲突。`);
});

void refresh(true).catch(error => notice(error.message, true));
setInterval(() => { if (!busy) void refresh().catch(() => undefined); }, 4000);
