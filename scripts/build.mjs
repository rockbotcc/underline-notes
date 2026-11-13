import { build } from 'esbuild';
import { mkdir, copyFile, cp, realpath, readFile, writeFile } from 'node:fs/promises';

const license = await readFile('LICENSE', 'utf8');
const notice = await readFile('NOTICE', 'utf8');
const banner = { js: `/*!\n${notice.trim()}\n*/` };

await mkdir('dist', { recursive: true });
await build({
  entryPoints: ['browser/src/background.ts', 'browser/src/options.ts'],
  bundle: true,
  outdir: 'dist',
  format: 'esm',
  target: 'chrome120',
  sourcemap: true,
  banner,
});
await build({
  entryPoints: ['browser/src/content.ts'],
  bundle: true,
  outfile: 'dist/content.js',
  format: 'iife',
  loader: { '.css': 'text' },
  target: 'chrome120',
  sourcemap: true,
  banner,
});
for (const file of ['manifest.json', 'options.html', 'options.css']) {
  await copyFile(`browser/${file}`, `dist/${file}`);
}
await cp('browser/icons', 'dist/icons', { recursive: true });
for (const file of ['LICENSE', 'NOTICE']) await copyFile(file, `dist/${file}`);
const thirdPartyLicenses = [];
for (const [name, file] of [['@mozilla/readability', 'LICENSE.md'], ['idb', 'LICENSE'], ['turndown', 'LICENSE']]) {
  const pkg = JSON.parse(await readFile(`node_modules/${name}/package.json`, 'utf8'));
  thirdPartyLicenses.push(`${name} ${pkg.version}\n\n${await readFile(`node_modules/${name}/${file}`, 'utf8')}`);
}
await writeFile('dist/THIRD_PARTY_LICENSES.txt', thirdPartyLicenses.join('\n---\n\n'));
console.log('Chrome 扩展已生成至 ' + await realpath('dist'));
console.log('请在 chrome://extensions 重新加载已有扩展，并刷新使用中的网页。');
await mkdir('dist-obsidian/noting', { recursive: true });
// Obsidian's updater downloads main.js without the ZIP's accompanying files.
await build({ entryPoints: ['obsidian/main.ts'], bundle: true, outfile: 'dist-obsidian/noting/main.js', format: 'cjs', platform: 'browser', external: ['obsidian'], target: 'es2022', banner: { js: `/*!\n${notice.trim()}\n\n${license.trim()}\n*/` } });
await copyFile('manifest.json', 'dist-obsidian/noting/manifest.json');
await copyFile('obsidian/styles.css', 'dist-obsidian/noting/styles.css');
for (const file of ['LICENSE', 'NOTICE']) await copyFile(file, `dist-obsidian/noting/${file}`);
console.log('Obsidian 插件已生成至 dist-obsidian/noting/');

await mkdir('dist-siyuan/underline-notes', { recursive: true });
await build({ entryPoints: ['siyuan/main.ts'], bundle: true, outfile: 'dist-siyuan/underline-notes/index.js', format: 'cjs', platform: 'browser', external: ['siyuan'], target: 'es2022', banner });
// Both hosts use the same cardbox design; scope the shared styles to this plugin.
await writeFile('dist-siyuan/underline-notes/index.css', '@scope (.un-cardbox) {\n' + (await readFile('obsidian/styles.css', 'utf8')).replaceAll('.noting-view', ':scope') + '\n}\n' + await readFile('siyuan/styles.css', 'utf8'));
for (const file of ['plugin.json', 'README.md']) await copyFile(`siyuan/${file}`, `dist-siyuan/underline-notes/${file}`);
await cp('siyuan/i18n', 'dist-siyuan/underline-notes/i18n', { recursive: true });
await copyFile('browser/icons/128.png', 'dist-siyuan/underline-notes/icon.png');
for (const file of ['LICENSE', 'NOTICE']) await copyFile(file, `dist-siyuan/underline-notes/${file}`);
console.log('思源插件已生成至 dist-siyuan/underline-notes/');
