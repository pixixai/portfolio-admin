import { readFile, readdir, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const original = path.resolve(root, '../作品集网站');
const inventory = JSON.parse(await readFile(path.join(root, 'original-integrity.json'), 'utf8'));
let hasOriginal=false;try{await access(original);hasOriginal=true;}catch(error){if(error.code!=='ENOENT')throw error;}
if(hasOriginal)for (const file of inventory) {
  const actual = createHash('sha256').update(await readFile(path.join(original, file.path))).digest('hex');
  if (actual !== file.sha256) throw new Error(`原作品集文件发生变化：${file.path}`);
}
console.log(hasOriginal?`独立作品站已确认基线完整性：${inventory.length} 个源文件和部署文件逐一核对通过。`:'独立安装环境未附带旧作品站，跳过旧站基线检查。');
const scripts = ['server.mjs', 'scripts-check.mjs', 'public/app.js', 'public/site-preview.js', 'public/media-browser.js', 'public/editor.js', 'public/document.js', 'public/document-selection.js', 'public/rich-text.bundle.js', 'src/rich-text.js', 'src/table-ui.js', 'src/table-model.js', 'src/table-extension.js', 'src/code-ui.js', 'scripts/build-editor.mjs', 'renderer/scripts/formatting.mjs', 'renderer/scripts/content.mjs', 'renderer/scripts/build.mjs', 'renderer/app.js', 'renderer/hero-video.js', ...(await readdir(path.join(root, 'lib'))).map(name => `lib/${name}`), ...(await readdir(path.join(root, 'tests'))).filter(name => name.endsWith('.mjs')).map(name => `tests/${name}`)];
for (const file of scripts) execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'pipe', windowsHide: true });
console.log(`脚本语法：${scripts.length} 个文件通过。`);
const html = await readFile(path.join(root, 'public/index.html'), 'utf8'), js = await readFile(path.join(root, 'public/app.js'), 'utf8') + await readFile(path.join(root, 'public/editor.js'), 'utf8') + await readFile(path.join(root, 'public/document.js'), 'utf8');
const mediaBrowserJS = await readFile(path.join(root, 'public/media-browser.js'), 'utf8') + await readFile(path.join(root, 'public/site-preview.js'), 'utf8');
const icons = new Set([...html.matchAll(/id="i-([^" ]+)"/g)].map(match => match[1]));
for (const match of (js + mediaBrowserJS).matchAll(/icon\('([^']+)'\)/g)) if (!icons.has(match[1])) throw new Error(`缺少图标：${match[1]}`);
console.log('界面本地图标引用通过。');
