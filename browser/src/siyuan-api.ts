import { checkedImage, type ImageReference, type SiyuanSettings } from '../../shared/model.ts';

export const SIYUAN_ID = /^\d{14}-[a-z0-9]{7}$/;
export class SiyuanError extends Error {
  code: string;
  retryable: boolean;
  constructor(code: string, message: string, retryable = false) {
    super(message); this.code = code; this.retryable = retryable;
  }
}
export function checkedSiyuanUrl(value: string): string {
  try {
    const url = new URL(value.trim());
    if ((url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) &&
      !url.username && !url.password && !url.search && !url.hash && url.pathname === '/') return url.origin;
  } catch { /* Never echo credentials. */ }
  throw new Error('思源地址须为本机 HTTP 或 HTTPS 服务地址，不包含路径、账号、查询参数。');
}
export function newSiyuanId(): string {
  const date = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(7));
  return date + '-' + [...bytes].map(byte => alphabet[byte % alphabet.length]).join('');
}
export async function siyuanProfile(baseUrl: string, notebookId: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([baseUrl, notebookId])));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

const endpoints = new Set(['system/version', 'notebook/lsNotebooks', 'notebook/getNotebookConf', 'filetree/createDocByParent',
  'filetree/getDocPaths', 'block/appendBlock', 'block/getBlockKramdown', 'asset/upload']);
export class SiyuanClient {
  config: Pick<SiyuanSettings, 'baseUrl' | 'apiToken'>;
  request: typeof fetch;
  constructor(config: Pick<SiyuanSettings, 'baseUrl' | 'apiToken'>, request: typeof fetch = fetch) {
    this.config = { baseUrl: checkedSiyuanUrl(config.baseUrl), apiToken: config.apiToken };
    this.request = request;
  }
  async call<T>(path: string, body: unknown = {}): Promise<T> {
    if (!endpoints.has(path)) throw new Error('不支持的思源操作');
    let response: Response;
    try {
      const request = this.request;
      response = await request(this.config.baseUrl + '/api/' + path, {
        method: 'POST', headers: { ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), Authorization: 'Token ' + this.config.apiToken },
        body: body instanceof FormData ? body : JSON.stringify(body), credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(15000),
      });
    } catch { throw new SiyuanError('network', '无法连接思源，请启动思源并检查地址；待写入内容保留在本机。', true); }
    if ([401, 403].includes(response.status)) throw new SiyuanError('auth', '思源拒绝访问，请检查 API Token 和写入权限。');
    if (response.status === 404) throw new SiyuanError('unsupported', '思源缺少所需接口，请升级到支持结构化文档 API 的版本（验收基线 3.8.10）。');
    if (!response.ok) throw new SiyuanError('http', `思源请求失败（HTTP ${response.status}）。`, response.status >= 500 || response.status === 429);
    let result: { code?: unknown; data?: T } | null;
    try { result = await response.json(); }
    catch { throw new SiyuanError('response', '思源返回格式异常，请检查服务地址。', true); }
    if (result?.code !== 0) throw new SiyuanError('rejected', '思源未接受操作，请检查 Token、笔记本状态与版本；结果将在重试前核对。');
    return result.data as T;
  }
  async uploadImage(image: ImageReference, name: string): Promise<string> {
    const data = checkedImage(image).data;
    if (!data) throw new SiyuanError('image', '图片尚未保存在本机，请重新保存该图片笔记后重试。');
    const [header, encoded] = data.split(',');
    const mime = header.slice(5).split(';')[0];
    const extension = mime.slice(6).replace('svg+xml', 'svg').replace('x-icon', 'ico');
    const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
    if (!bytes.length || bytes.length > 12 * 1024 * 1024) throw new SiyuanError('image', '图片为空或超过 12 MB。');
    const filename = name + '.' + extension;
    const form = new FormData();
    form.append('assetsDirPath', '/assets/');
    form.append('file[]', new Blob([bytes], { type: mime }), filename);
    const result = await this.call<{ errFiles?: string[]; failedFiles?: unknown[]; succMap?: Record<string, string> }>('asset/upload', form);
    const path = result?.succMap?.[filename];
    if (result?.errFiles?.length || result?.failedFiles?.length || typeof path !== 'string' ||
      !/^assets\/[^<>\s\\]+$/.test(path) || path.split('/').some(part => part === '..' || part === '.')) {
      throw new SiyuanError('upload', '思源图片附件上传未完成，请检查存储空间和权限后重试。', true);
    }
    return path;
  }
  async notebooks(): Promise<{ id: string; name: string; closed: boolean }[]> {
    const data = await this.call<{ notebooks: { id: string; name: string; closed: boolean }[] }>('notebook/lsNotebooks');
    if (!Array.isArray(data?.notebooks) || data.notebooks.some(item => !SIYUAN_ID.test(item.id) || typeof item.name !== 'string')) {
      throw new SiyuanError('response', '思源笔记本列表格式异常。');
    }
    return data.notebooks;
  }
  async checkNotebook(notebook: string): Promise<string> {
    const selected = (await this.notebooks()).find(item => item.id === notebook && !item.closed);
    if (!selected) throw new SiyuanError('notebook', '目标笔记本不可用，请打开笔记本或检查当前思源工作空间。');
    const conf = await this.call<{ documentCapabilities?: { structuredPaths?: boolean; indexState?: string } }>('notebook/getNotebookConf', { notebook });
    if (!conf?.documentCapabilities?.structuredPaths) throw new SiyuanError('unsupported', '此思源版本或权限不支持结构化文档 API，请使用 3.8.10 或更新版本并检查权限。');
    return selected.name;
  }
  async document(notebook: string, id: string): Promise<boolean> {
    const result = await this.call<{ documents: { id: string }[]; missingIDs: string[] }>('filetree/getDocPaths', { notebook, ids: [id] });
    if (!Array.isArray(result?.documents) || !Array.isArray(result?.missingIDs)) throw new SiyuanError('response', '无法核对思源文档状态。', true);
    if (result.documents.some(doc => doc.id === id)) return true;
    if (result.missingIDs.includes(id)) return false;
    throw new SiyuanError('response', '思源未返回目标文档状态。', true);
  }
  async markdown(id: string): Promise<string> {
    const result = await this.call<{ id: string; kramdown: string }>('block/getBlockKramdown', { id });
    if (result?.id !== id || typeof result.kramdown !== 'string') throw new SiyuanError('response', '无法读取思源文档内容。', true);
    return result.kramdown;
  }
  async create(notebook: string, parentID: string | null, id: string, title: string, markdown: string): Promise<void> {
    const result = await this.call<{ id: string }>('filetree/createDocByParent', { notebook, parentID, id, title: { format: 'plain', text: title }, markdown });
    if (result?.id !== id) throw new SiyuanError('response', '思源创建结果需要核对。', true);
  }
}
