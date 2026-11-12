export const VAULT_TAGS_PATH = 'Data/vault-tags.json';
export function validTag(value: unknown): value is string {
  return typeof value === 'string' && /^[\p{L}\p{N}_-]+(?:\/[\p{L}\p{N}_-]+)*$/u.test(value) && /[\p{L}_-]/u.test(value);
}
export function normalizeTags(values: string[]): string[] {
  const tags = new Map<string, string>();
  for (const value of values) {
    const tag = value.replace(/^#/, '');
    if (validTag(tag) && !tags.has(tag.toLocaleLowerCase())) tags.set(tag.toLocaleLowerCase(), tag);
  }
  return [...tags.values()].sort((a, b) => a.localeCompare(b));
}
export function parseVaultTags(text: string): string[] {
  const data = JSON.parse(text);
  if (data?.schemaVersion !== 1 || data.source !== 'obsidian-vault' || !Array.isArray(data.tags) || !data.tags.every(validTag)) throw new Error('仓库标签文件格式无效，请在 Obsidian 中重新导出。');
  return normalizeTags(data.tags);
}
