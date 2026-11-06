import { App, Modal, Notice, TFile, requestUrl } from 'obsidian';
import type { AISettings } from './ai';
import type { Memo } from './cards';
import { memoVersion } from './relations';
import { discuss, distillDiscussion, discussionCard, newDiscussion, MAX_QUESTION, MAX_TURNS, recentTurns, validateDraft, type Discussion, type DiscussionDraft } from './discussion';

export interface DiscussionHost {
  app: App; preferences: { ai: AISettings }; discussions: Discussion[]; discussionBusy: Set<string>;
  isUnloaded: boolean;
  updateDiscussions(update: (rows: Discussion[]) => Discussion[]): Promise<void>;
  refreshDiscussion(): void;
  readMemo(id: string, folder: string): Promise<Memo>;
}
function action(parent: HTMLElement, label: string, callback: () => void, disabled = false) {
  const button = parent.createEl('button', { text: label });
  button.disabled = disabled; button.addEventListener('click', callback); return button;
}
export class DiscussionModal extends Modal {
  private closed = false;
  private sessionId: string;
  private localError = '';
  constructor(private host: DiscussionHost, private source: Memo, private folder: string, discussion: Discussion) {
    super(host.app); this.sessionId = discussion.id;
  }
  private get session() { return this.host.discussions.find(row => row.id === this.sessionId)!; }
  onOpen() { this.closed = false; this.modalEl.classList.add('noting-view', 'nt-chat-modal'); this.render(); }
  onClose() { this.closed = true; this.contentEl.empty(); }
  refresh() { this.render(); }
  private async update(id: string, patch: Partial<Discussion>) {
    await this.host.updateDiscussions(rows => rows.map(row => row.id === id ? { ...row, ...patch } : row));
  }
  private persist(patch: Partial<Discussion>) {
    const id = this.sessionId;
    void this.update(id, patch).catch(() => { this.localError = '讨论保存失败，请保留当前输入后重试。'; new Notice(this.localError); });
  }
  private async run(work: (session: Discussion) => Promise<void>) {
    const session = this.session;
    if (this.host.discussionBusy.has(session.id)) return;
    this.host.discussionBusy.add(session.id); this.localError = ''; this.render();
    try { await work(session); }
    catch (error) { this.localError = error instanceof Error ? error.message : '操作失败，请重试。'; if (!this.host.isUnloaded) new Notice(this.localError); }
    finally { this.host.discussionBusy.delete(session.id); if (!this.host.isUnloaded) this.host.refreshDiscussion(); }
  }
  private send(question: string, retry = false) {
    void this.run(async session => {
      if (!question.trim() || question.length > MAX_QUESTION) throw new Error('问题需为 1～8000 个字符。');
      if (!retry && session.turns.length >= MAX_TURNS) throw new Error('本次讨论已满 40 轮，请开始新讨论；旧记录会保留。');
      const last = session.turns.at(-1);
      if (!retry && last && !last.answer) throw new Error('请先重试或修改上一条未完成的问题。');
      const turn = retry && last && !last.answer ? { ...last, error: undefined } : { id: crypto.randomUUID(), question: question.trim(), createdAt: new Date().toISOString() };
      const turns = retry ? [...session.turns.slice(0, -1), turn] : [...session.turns, turn];
      await this.update(session.id, { turns, input: '' }); this.render();
      try {
        const answer = await discuss(session, turn.question, { ...this.host.preferences.ai }, request => requestUrl(request));
        if (this.host.isUnloaded) return;
        await this.update(session.id, { turns: turns.map(item => item.id === turn.id ? { ...item, answer } : item) });
      } catch (error) {
        if (this.host.isUnloaded) return;
        await this.update(session.id, { turns: turns.map(item => item.id === turn.id ? { ...item, error: error instanceof Error ? error.message : '请求失败' } : item) });
        throw error;
      }
    });
  }
  private generateDraft() {
    void this.run(async session => {
      const draft = await distillDiscussion(session, { ...this.host.preferences.ai }, request => requestUrl(request));
      if (!this.host.isUnloaded) await this.update(session.id, { draft });
    });
  }
  private saveCard(draft: DiscussionDraft) {
    void this.run(async session => {
      validateDraft(draft.title, draft.body);
      // Persist the exact editable draft first so a partial save can be retried with the same ID.
      await this.update(session.id, { draft });
      const source = await this.host.readMemo(session.memoId, session.folder);
      const folder = session.folder + '/Cards/Local', path = folder + '/' + draft.id + '.md';
      const markdown = discussionCard(session, draft, source, path);
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing) {
        if (!(existing instanceof TFile) || await this.app.vault.read(existing) !== markdown) throw new Error('目标卡片已存在且内容不同，未覆盖。请先查看 ' + path + '，或重新整理生成另一张卡片。');
      } else {
        for (const part of [session.folder, session.folder + '/Cards', folder]) {
          if (!this.app.vault.getAbstractFileByPath(part)) {
            try { await this.app.vault.createFolder(part); }
            catch (error) { if (!this.app.vault.getAbstractFileByPath(part)) throw error; }
          }
        }
        await this.app.vault.create(path, markdown);
      }
      await this.host.updateDiscussions(rows => rows.map(row => row.id === session.id ? {
        ...row, draft: { ...draft, savedPath: path }, exports: row.exports.some(item => item.cardId === draft.id) ? row.exports : [...row.exports, { cardId: draft.id, path, title: draft.title }],
      } : row));
      new Notice('讨论已保存为新卡片，并附上来源链接');
    });
  }
  private async startNew() {
    try {
      const source = await this.host.readMemo(this.source.id, this.folder);
      const discussion = newDiscussion(source, this.folder);
      await this.host.updateDiscussions(rows => [...rows, discussion]);
      this.source = source; this.sessionId = discussion.id; this.localError = ''; this.render();
    } catch (error) { new Notice(error instanceof Error ? error.message : '无法开始新讨论'); }
  }
  private render() {
    if (this.closed) return;
    const session = this.session;
    if (!session) return;
    const busy = this.host.discussionBusy.has(session.id), pending = session.turns.at(-1);
    this.titleEl.setText('和 AI 讨论'); this.contentEl.empty();
    const header = this.contentEl.createDiv({ cls: 'nt-chat-header' });
    header.createEl('h3', { text: session.context.title || '这张卡片' });
    header.createEl('p', { text: '发送时仅提供这张卡片的片段与本次讨论；记录保存在当前仓库。', cls: 'nt-muted' });
    const toolbar = header.createDiv({ cls: 'nt-chat-actions' });
    const history = toolbar.createEl('select', { attr: { 'aria-label': '历史讨论' } });
    const sessions = this.host.discussions.filter(row => row.folder === this.folder && row.memoId === this.source.id);
    sessions.forEach((row, i) => { const option = history.createEl('option', { text: '讨论 ' + (i + 1) + ' · ' + row.createdAt.slice(0, 10), attr: { value: row.id } }); option.selected = row.id === session.id; });
    history.disabled = busy;
    history.addEventListener('change', () => { this.sessionId = history.value; this.localError = ''; this.render(); });
    action(toolbar, '开始新讨论', () => void this.startNew(), busy);
    const context = header.createEl('details', { cls: 'nt-chat-context' });
    context.createEl('summary', { text: '查看本次讨论的卡片背景' });
    for (const [label, text] of [['我的批注', session.context.note], ['延伸思考', session.context.personal], ['摘录', session.context.quote], ['原文上下文', session.context.context]]) {
      if (text) { context.createEl('strong', { text: label }); context.createEl('p', { text, cls: 'nt-chat-text' }); }
    }
    if (session.sourceVersion !== memoVersion(this.source)) header.createEl('p', { text: '卡片已更新，本次仍使用开始时的背景；开始新讨论可使用新内容。', cls: 'nt-muted' });
    const transcript = this.contentEl.createDiv({ cls: 'nt-chat-transcript', attr: { 'aria-label': '讨论记录', 'aria-live': 'polite' } });
    if (!session.turns.length) {
      transcript.createEl('p', { text: '从一个问题开始，让这个想法更清楚。', cls: 'nt-muted' });
      const starters = transcript.createDiv({ cls: 'nt-chat-actions' });
      for (const prompt of ['这条笔记隐含了哪些假设？', '能给一个具体例子和一个反例吗？', '这个观点可以怎样用于实践？']) action(starters, prompt, () => this.send(prompt), busy);
    }
    for (const turn of session.turns) {
      const user = transcript.createDiv({ cls: 'nt-chat-message nt-chat-user' });
      user.createEl('strong', { text: '你' }); user.createEl('div', { text: turn.question, cls: 'nt-chat-text' });
      const assistant = transcript.createDiv({ cls: 'nt-chat-message nt-chat-assistant' });
      assistant.createEl('strong', { text: 'AI' });
      assistant.createEl('div', { text: turn.answer || (busy ? '正在思考…' : turn.error || '上次请求未完成，可以重试。'), cls: 'nt-chat-text' });
      if (!turn.answer && !busy) {
        const tools = assistant.createDiv({ cls: 'nt-chat-actions' });
        action(tools, '重试回复', () => this.send(turn.question, true));
        action(tools, '修改问题', () => void this.run(async current => { await this.update(current.id, { turns: current.turns.slice(0, -1), input: turn.question }); }));
      }
    }
    const used = recentTurns(session.turns).length, total = session.turns.filter(turn => turn.answer).length;
    if (used < total) this.contentEl.createEl('p', { text: '本次回复与整理使用最近 ' + used + ' 轮完整讨论；全部历史仍保存在上方。', cls: 'nt-muted' });
    const compose = this.contentEl.createDiv({ cls: 'nt-chat-compose' });
    const input = compose.createEl('textarea', { attr: { 'aria-label': '讨论问题', placeholder: '围绕这条笔记继续提问…', rows: '3', maxlength: String(MAX_QUESTION) } });
    input.value = session.input; input.disabled = busy;
    input.addEventListener('input', () => this.persist({ input: input.value }));
    const controls = compose.createDiv({ cls: 'nt-chat-actions' });
    const send = action(controls, busy ? '处理中…' : '发送', () => this.send(input.value), busy || !!(pending && !pending.answer));
    send.classList.add('nt-primary');
    input.addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); if (!send.disabled) this.send(input.value); } });
    action(controls, session.draft ? '重新整理草稿' : '整理成新卡片', () => this.generateDraft(), busy || !total || !!(pending && !pending.answer));
    controls.createSpan({ text: '⌘ / Ctrl + Enter 发送', cls: 'nt-muted' });
    if (this.localError) compose.createEl('p', { text: this.localError, cls: 'nt-chat-error', attr: { role: 'alert' } });
    if (session.draft) this.renderDraft(session, busy);
    for (const saved of session.exports) action(this.contentEl, '打开已保存卡片：' + saved.title, () => {
      void this.host.readMemo(saved.cardId, session.folder).then(memo => this.app.workspace.openLinkText(memo.path, '', true)).catch(() => new Notice('这张生成卡片已移走或删除。'));
    });
    transcript.scrollTop = transcript.scrollHeight;
  }
  private renderDraft(session: Discussion, busy: boolean) {
    const draft = session.draft!;
    const preview = this.contentEl.createDiv({ cls: 'nt-chat-draft' });
    preview.createEl('h3', { text: draft.savedPath ? '已保存为新卡片' : '新卡片草稿' });
    preview.createEl('p', { text: '基于前 ' + draft.turnCount + ' 轮讨论整理。检查并修改后保存，来源链接会自动附上。', cls: 'nt-muted' });
    const title = preview.createEl('input', { attr: { 'aria-label': '新卡片标题', maxlength: '48' } }); title.value = draft.title;
    const body = preview.createEl('textarea', { attr: { 'aria-label': '新卡片正文', rows: '8', maxlength: '16000' } }); body.value = draft.body;
    title.disabled = body.disabled = busy || !!draft.savedPath;
    const currentDraft = () => ({ ...draft, title: title.value, body: body.value });
    for (const field of [title, body]) field.addEventListener('input', () => this.persist({ draft: currentDraft() }));
    if (!draft.savedPath) action(preview, '保存为新卡片', () => this.saveCard(currentDraft()), busy).classList.add('nt-primary');
  }
}
