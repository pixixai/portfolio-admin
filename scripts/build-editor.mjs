import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await build({ entryPoints: [path.join(root, 'src/rich-text.js')], outfile: path.join(root, 'public/rich-text.bundle.js'), bundle: true, format: 'iife', globalName: 'PortfolioRichText', target: ['es2022'], minify: true, legalComments: 'external' });
console.log('本地富文本编辑器已构建。');
