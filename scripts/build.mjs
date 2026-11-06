import { build } from 'esbuild';
import { mkdir, copyFile, cp } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
await build({
  entryPoints: ['browser/src/background.ts', 'browser/src/options.ts'],
  bundle: true,
  outdir: 'dist',
  format: 'esm',
  target: 'chrome120',
  sourcemap: true,
});
await build({
  entryPoints: ['browser/src/content.ts'],
  bundle: true,
  outfile: 'dist/content.js',
  format: 'iife',
  loader: { '.css': 'text' },
  target: 'chrome120',
  sourcemap: true,
});
for (const file of ['manifest.json', 'options.html', 'options.css']) {
  await copyFile(`browser/${file}`, `dist/${file}`);
}
await cp('browser/icons', 'dist/icons', { recursive: true });
console.log('Chrome 扩展已生成至 dist/');
await mkdir('dist-obsidian/noting', { recursive: true });
await build({ entryPoints: ['obsidian/main.ts'], bundle: true, outfile: 'dist-obsidian/noting/main.js', format: 'cjs', platform: 'browser', external: ['obsidian'], target: 'es2022' });
await copyFile('manifest.json', 'dist-obsidian/noting/manifest.json');
await copyFile('obsidian/styles.css', 'dist-obsidian/noting/styles.css');
console.log('Obsidian 插件已生成至 dist-obsidian/noting/');
