import { readFile, mkdir, rm, copyFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const json = async file => JSON.parse(await readFile(file, 'utf8'));
const { version } = await json('package.json');
for (const file of ['package-lock.json', 'manifest.json', 'browser/manifest.json', 'dist/manifest.json', 'dist-obsidian/noting/manifest.json']) {
  if ((await json(file)).version !== version) throw new Error(`Version mismatch: ${file}`);
}
if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== version) throw new Error('Release tag must match the package version');
const plugin = await json('manifest.json');
if ((await json('versions.json'))[version] !== plugin.minAppVersion) throw new Error('Missing Obsidian compatibility version');
await readFile(`releases/${version}.md`, 'utf8');

const output = path.resolve('dist-release');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
execFileSync('zip', ['-q', '-r', path.join(output, 'underline-notes-chrome.zip'), 'manifest.json', 'background.js', 'content.js', 'options.js', 'options.html', 'options.css', 'icons'], { cwd: 'dist' });
execFileSync('zip', ['-q', path.join(output, 'underline-notes-obsidian.zip'), 'noting/main.js', 'noting/manifest.json', 'noting/styles.css'], { cwd: 'dist-obsidian' });
for (const name of ['main.js', 'manifest.json', 'styles.css']) await copyFile(`dist-obsidian/noting/${name}`, path.join(output, name));
const checksums = [];
for (const name of (await readdir(output)).sort()) {
  if (name.endsWith('.zip')) execFileSync('unzip', ['-tq', path.join(output, name)]);
  checksums.push(createHash('sha256').update(await readFile(path.join(output, name))).digest('hex') + '  ' + name);
}
await writeFile(path.join(output, 'SHA256SUMS.txt'), checksums.join('\n') + '\n');
console.log(`Release ${version} packaged in ${output}`);
