// Only installs generated artifacts into this project's disposable preview vault.
import { mkdir, readdir, readFile, copyFile, cp } from 'node:fs/promises';
import path from 'node:path';
const source = path.resolve('test-results/CardPreviewVault/Reading');
const target = path.resolve('test-results/NotingPreviewVault');
const records = await Promise.all((await readdir(path.join(source, 'Data/articles'))).filter(name => name.endsWith('.json')).map(async name => JSON.parse(await readFile(path.join(source, 'Data/articles', name), 'utf8'))));
const article = records.map(record => record.article).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
if (!article) throw new Error('Run test:e2e first');
for (const dir of ['Articles', 'Cards', 'Daily', 'Data/articles']) await mkdir(path.join(target, 'Reading', dir), { recursive: true });
for (const file of ['卡片盒.md', '阅读索引.md', `Articles/${article.id}.md`, `Data/articles/${article.id}.json`]) await copyFile(path.join(source, file), path.join(target, 'Reading', file));
await cp(path.join(source, 'Cards', article.id), path.join(target, 'Reading/Cards', article.id), { recursive: true });
await cp(path.join(source, 'Daily'), path.join(target, 'Reading/Daily'), { recursive: true });
await mkdir(path.join(target, '.obsidian/plugins'), { recursive: true });
await cp(path.resolve('dist-obsidian/noting'), path.join(target, '.obsidian/plugins/noting'), { recursive: true });
console.log(target);
