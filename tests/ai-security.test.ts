import test from 'node:test';
import assert from 'node:assert/strict';
import { apiRequest, DEFAULT_AI, endpoint } from '../obsidian/ai.ts';

test('Obsidian rejects insecure remote AI URLs before sending credentials or notes', async () => {
  const forbidden = ['http://model.example/v1', 'http://192.168.1.10/v1', 'http://localhost.attacker.example/v1',
    'http://127.0.0.1.attacker.example', 'https://user:secret@model.example', 'https://model.example?key=secret',
    'https://model.example#fragment', 'file:///tmp/model', 'javascript:alert(1)'];
  for (const baseUrl of forbidden) {
    let calls = 0;
    await assert.rejects(apiRequest({ ...DEFAULT_AI, baseUrl, apiKey: 'test-secret' }, 'chat/completions',
      { messages: [{ role: 'user', content: 'private note' }] }, async () => {
        calls++; return { status: 200, text: '{}' };
      }));
    assert.equal(calls, 0, baseUrl);
  }
});

test('Obsidian preserves HTTPS, loopback services, route normalization and authentication', async () => {
  for (const baseUrl of ['https://model.example/v1', 'http://localhost:9000/v1', 'http://127.0.0.1:9000/v1', 'http://[::1]:9000/v1']) {
    for (const route of ['chat/completions', 'embeddings'] as const) {
      assert.equal(endpoint(baseUrl + '/chat/completions/', route), baseUrl + '/' + route);
      const body = { model: 'test', input: 'note' };
      const result = await apiRequest({ ...DEFAULT_AI, baseUrl, apiKey: ' test-key ' }, route, body, async request => {
        assert.equal(request.url, baseUrl + '/' + route);
        assert.equal(request.headers.Authorization, 'Bearer test-key');
        assert.deepEqual(JSON.parse(request.body), body);
        return { status: 200, text: '{"ok":true}' };
      });
      assert.deepEqual(result, { ok: true });
    }
  }
});
