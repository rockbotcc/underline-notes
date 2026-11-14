import assert from 'node:assert/strict';

// Test-only DevTools access: Playwright cannot locate controls in closed roots.
// Assert the production privacy boundary before exposing it to test locators.
// Never bundle this helper into the extension.
export async function exposeExtensionUI(page) {
  await page.locator('#noting-extension').waitFor({ state: 'attached' });
  assert.equal(await page.evaluate(() => document.querySelector('#noting-extension').shadowRoot), null);
  const session = await page.context().newCDPSession(page);
  try {
    const contexts = [];
    session.on('Runtime.executionContextCreated', ({ context }) => contexts.push(context));
    await session.send('Runtime.enable');
    const { root } = await session.send('DOM.getDocument', { depth: -1, pierce: true });
    function find(node) {
      if (node.attributes?.some((value, index, values) => value === 'id' && values[index + 1] === 'noting-extension')) return node.shadowRoots?.[0];
      for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) {
        const found = find(child); if (found) return found;
      }
    }
    const shadow = find(root);
    assert.equal(shadow?.shadowRootType, 'closed');
    for (const context of contexts.filter(item => item.auxData?.isDefault || item.name.includes('playwright'))) {
      const { object } = await session.send('DOM.resolveNode', { backendNodeId: shadow.backendNodeId, executionContextId: context.id });
      await session.send('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: 'function () { const root = this; Object.defineProperty(this.host, "shadowRoot", { get: () => root, configurable: true }); }',
      });
    }
  } finally { await session.detach(); }
}
