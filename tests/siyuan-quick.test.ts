import assert from 'node:assert/strict';
import test from 'node:test';
import { QuickNoteStore, localMarkdown, validateQuickDraft, type QuickDraft } from '../siyuan/quick-note.ts';
import { collectCards, filterCards, type Request } from '../siyuan/cards.ts';
import { reviewCards } from '../shared/review.ts';
const notebook = '20261113090000-bbbbbbb';
function fixture() {
  let saved: QuickDraft = { text: '独立想法 #随手记/测试', notebookId: notebook }, offline = false, lost = false, creates = 0;
  const docs = new Map<string, string>();
  const request = (async (endpoint: string, body: Record<string, any>) => {
    if (offline) throw new Error('offline');
    if (endpoint.endsWith('getDocPaths')) return { documents: docs.has(body.ids[0]) ? [{ id: body.ids[0] }] : [], missingIDs: docs.has(body.ids[0]) ? [] : body.ids };
    if (endpoint.endsWith('getBlockKramdown')) return { kramdown: docs.get(body.id) };
    assert.ok(endpoint.endsWith('createDocByParent')); creates++;
    assert.equal(saved.attempt?.docId, body.id, 'identity saved before mutation'); assert.equal(body.notebook, notebook);
    assert.equal(body.parentID, null); assert.equal(body.title.format, 'plain');
    docs.set(body.id, body.markdown); if (lost) { offline = true; throw new Error('response lost'); } return { id: body.id };
  }) as Request;
  const persist = async (data: QuickDraft) => { saved = structuredClone(data); };
  return { request, persist, docs, get saved() { return saved; }, get creates() { return creates; }, set offline(value: boolean) { offline = value; }, set lost(value: boolean) { lost = value; } };
}
test('quick note creates one native card, remembers destination and supports tags/search/review', async () => {
  const f = fixture(), store = new QuickNoteStore(f.saved, f.request, f.persist);
  const [first, second] = await Promise.all([store.submit(), store.submit()]);
  assert.equal(first, second); assert.equal(f.creates, 1); assert.equal(store.draft.text, ''); assert.equal(store.draft.notebookId, notebook);
  const markdown = f.docs.get(first)!;
  const blockId = markdown.match(/id="([^"]+)"/)![1];
  const cards = collectCards([{ id: blockId, root_id: first, box: notebook, title: '独立想法', name: 'custom-underline-local', markdown }]);
  assert.equal(cards[0].kind, 'local'); assert.equal(cards[0].source, '');
  assert.equal(filterCards(cards, '独立', '随手记').length, 1);
  assert.equal(reviewCards(cards, '2026-11-13')[0].id, first);
});
test('quick note recovers committed response loss after restart without a second document', async () => {
  const f = fixture(); f.lost = true;
  const store = new QuickNoteStore(f.saved, f.request, f.persist);
  await assert.rejects(store.submit(), /response lost/); const id = f.saved.attempt!.docId;
  const restarted = new QuickNoteStore(structuredClone(f.saved), f.request, f.persist);
  await assert.rejects(restarted.edit('different', notebook), /先重试/);
  f.offline = false; f.lost = false;
  assert.equal(await restarted.submit(), id); assert.equal(f.creates, 1); assert.equal(f.saved.text, '');
});
test('quick note rejects an ID collision instead of overwriting an existing document', async () => {
  const f = fixture(); f.offline = true;
  const store = new QuickNoteStore(f.saved, f.request, f.persist); await assert.rejects(store.submit());
  const id = f.saved.attempt!.docId; f.docs.set(id, 'another document'); f.offline = false;
  await assert.rejects(store.submit(), /目标文档已变化/); assert.equal(f.creates, 0); assert.ok(store.draft.text); assert.equal(f.docs.get(id), 'another document');
});
test('quick note requires a destination and durable storage before creating', async () => {
  const f = fixture(); const store = new QuickNoteStore({ text: 'test', notebookId: '' }, f.request, f.persist);
  await assert.rejects(store.submit(), /请选择保存/); assert.equal(f.creates, 0);
  const broken = new QuickNoteStore(f.saved, f.request, async () => { throw new Error('disk full'); });
  await assert.rejects(broken.submit(), /disk full/); assert.equal(f.creates, 0);
});
test('quick note isolates container and block attribute input and validates restored drafts', () => {
  const markdown = localMarkdown('}}}\n{: id="bad"}\n{{{row\n内容', '20261113090000-aaaaaaa', 'a'.repeat(64), '2026-11-13T01:00:00Z');
  assert.equal((markdown.match(/^\{:/gm) || []).length, 1); assert.equal((markdown.match(/^\}\}\}$/gm) || []).length, 1);
  assert.ok(markdown.includes('custom-underline-local')); assert.ok(!markdown.includes('custom-underline-hash'));
  assert.throws(() => validateQuickDraft({ text: 'x', notebookId: '../../bad' }));
});
test('both hosts share deterministic eight-card daily selection without mutating input', () => {
  const cards = Array.from({ length: 40 }, (_, i) => ({ id: 'card-' + i }));
  const before = [...cards]; const today = reviewCards(cards, '2026-11-13');
  assert.equal(today.length, 8); assert.equal(new Set(today.map(card => card.id)).size, 8);
  assert.deepEqual(today, reviewCards([...cards].reverse(), '2026-11-13')); assert.deepEqual(cards, before);
  assert.notDeepEqual(today, reviewCards(cards, '2026-11-14'));
  assert.deepEqual(reviewCards([], '2026-11-13'), []);
});
