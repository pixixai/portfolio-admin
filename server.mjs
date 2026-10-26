import http from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, realpath, stat, unlink, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { openStore, now, digest } from './lib/store.mjs';
import { Publisher } from './lib/publisher.mjs';
import { validateProject, validateSettings, fail } from './lib/validation.mjs';
import { zipDirectory,packageLimit } from './lib/zip.mjs';
import {ProjectImporter} from './lib/project-package.mjs';
import { inspectMedia } from './lib/media.mjs';
import { projectLabels } from './lib/labels.mjs';
import { folders, validFolder, createFolder, ensureFolderPath, arrangeMedia } from './lib/media-folders.mjs';
import { mediaDeletePlan, deleteMediaItems } from './lib/media-delete.mjs';
import {releaseRetention} from './lib/release-retention.mjs';
import {validateLocalRequest} from './lib/local-access.mjs';
import {deploymentPlatforms,deploymentTarget,inspectDeployment,deploymentPackage} from './lib/deployment.mjs';

export const root = path.dirname(fileURLToPath(import.meta.url));
const mimeTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.txt': 'text/plain; charset=utf-8', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4' };
async function body(request, limit = 1024 * 1024) {
  if (Number(request.headers['content-length'] || 0) > limit) fail('文件或请求超过大小限制。', 413);
  const chunks = []; let length = 0;
  for await (const chunk of request) { length += chunk.length; if (length > limit) fail('文件或请求超过大小限制。', 413); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
async function jsonBody(request) {
  if (!request.headers['content-type']?.startsWith('application/json')) fail('请求需要使用JSON。', 415);
  try { const input = JSON.parse((await body(request)).toString()); if (!input || typeof input !== 'object' || Array.isArray(input)) fail('提交内容必须是一个对象。'); return input; } catch (error) { if (error.status) throw error; fail('无法读取提交内容。'); }
}
function safePath(base, relative) { const target = path.resolve(base, '.' + relative); if (target !== base && !target.startsWith(base + path.sep)) fail('不能访问此路径。', 403); return target; }

export async function createApplication({ dataDir, rendererDir = path.join(root, 'renderer') } = {}) {
  dataDir ||= process.env.PORTFOLIO_DATA_DIR || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'PixixPortfolioAdmin', digest(root).slice(0, 10));
  await mkdir(dataDir, { recursive: true });
  dataDir = await realpath(dataDir);
  const store = await openStore(dataDir, rendererDir), publisher = new Publisher(store, rendererDir);
  const importer=new ProjectImporter(store,publisher);
  await publisher.bootstrap();
  const respond = (response, value, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(value)); };
  async function sendFile(request, response, file, mime) {
    const { size } = await stat(file);
    let start = 0, end = size - 1, status = 200;
    if (request.headers.range) {
      const range = request.headers.range.match(/^bytes=(\d*)-(\d*)$/);
      if (!range || !range[1] && !range[2]) { response.writeHead(416, { 'Content-Range': `bytes */${size}` }).end(); return; }
      if (!range[1]) start = Math.max(0, size - Number(range[2]));
      else { start = Number(range[1]); if (range[2]) end = Math.min(size - 1, Number(range[2])); }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) { response.writeHead(416, { 'Content-Range': `bytes */${size}` }).end(); return; }
      status = 206;
    }
    response.writeHead(status, { 'Content-Type': mime, 'Content-Length': Math.max(0, end - start + 1), 'Accept-Ranges': 'bytes', ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) });
    if (request.method === 'HEAD' || size === 0) { response.end(); return; }
    const stream = createReadStream(file, { start, end });
    stream.on('error', () => response.destroy()); response.on('close', () => stream.destroy()); stream.pipe(response);
  }
  async function serve(request, response, base, relative) {
    let file = safePath(base, relative);
    const info = await stat(file);
    if (info.isDirectory()) {
      if (!relative.endsWith('/')) { response.writeHead(302, { Location: request.url.replace(/(\?|$)/, '/$1') }).end(); return; }
      file = path.join(file, 'index.html');
    }
    const actual = await realpath(file), actualBase = await realpath(base);
    if (!actual.startsWith(actualBase + path.sep)) fail('不能访问此路径。', 403);
    await sendFile(request, response, actual, mimeTypes[path.extname(file)] || 'application/octet-stream');
  }
  function state() {
    return {
      projects: store.projects(), folders: folders(store), media: store.media().map(asset => ({ ...asset, url: `/api/media/${asset.id}/file`, references: store.references(asset.id) })),
      settings: store.get('settingsDraft'), settingsLive: store.get('settingsLive'), settingsRevision: store.get('settingsRevision'),
      currentRelease: store.get('currentRelease'), releases: store.releases().map(({ snapshot, ...release }) => ({ ...release, count: snapshot.projects.length,deployment:snapshot.deployment||{platform:'generic',projectName:'portfolio-site'} })),
      releaseRetention: releaseRetention(store),
      capabilities:{backgroundLoop:true,sidebarPreview:true,platformExport:true},
      deploymentPlatforms,deploymentTarget:store.get('deploymentTarget')||{platform:'generic',projectName:'portfolio-site'},
      jobs: [...publisher.jobs.values()].slice(-10).reverse(),
    };
  }
  function buildPublish(ids, includeSettings, targetInput) {
    const target=deploymentTarget(targetInput);
    if (!Array.isArray(ids) || ids.length > 300 || new Set(ids).size !== ids.length) fail('请选择要发布的作品。');
    const rows = store.projects();
    const selected = ids.map(id => { const row = rows.find(row => row.id === id && !row.deletedAt); if (!row) fail('部分作品不存在。', 404); if (!row.draft.blocks.length && !row.draft.coverAssetId && !row.draft.description) fail(`“${row.draft.title}”还没有内容。`); return row; });
    const snapshot = { settings: includeSettings ? store.get('settingsDraft') : store.get('settingsLive'), projects: rows.map(row => ids.includes(row.id) ? row.draft : row.live).filter(Boolean),deployment:target };
    return publisher.start('publish', snapshot, () => {
      for (const row of selected) store.db.prepare('UPDATE projects SET live=? WHERE id=?').run(JSON.stringify(row.draft), row.id);
      if (includeSettings) store.set('settingsLive', snapshot.settings);
      store.set('deploymentTarget',target);
    }, `发布${selected.length}个作品${includeSettings ? '及站点设置' : ''}`,null,target);
  }
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Referrer-Policy', 'same-origin');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; frame-src 'self'; connect-src 'self'; frame-ancestors 'self'; object-src 'none'; base-uri 'self'");
    try {
      const url = new URL(request.url, 'http://localhost'), pathname = decodeURIComponent(url.pathname);
      validateLocalRequest(request,pathname);
      if (pathname.startsWith('/site/')) {
        if (!['GET', 'HEAD'].includes(request.method)) fail('不支持此操作。', 405);
        return await serve(request, response, path.join(dataDir, 'releases', store.get('currentRelease'), 'dist'), pathname.slice(5));
      }
      if (pathname === '/site') { response.writeHead(302, { Location: '/site/' }).end(); return; }
      if (pathname === '/api/state' && request.method === 'GET') return respond(response, state());
      if(pathname==='/api/import/inspect'&&request.method==='POST')return respond(response,await importer.inspect(await body(request,packageLimit)));
      if(pathname==='/api/import/commit'&&request.method==='POST')return respond(response,await importer.commit(await jsonBody(request)));
      const importMatch=pathname.match(/^\/api\/import\/([a-f0-9-]{36})$/);
      if(importMatch&&request.method==='DELETE'){await importer.discard(importMatch[1]);return respond(response,{ok:true});}
      if (pathname === '/api/projects' && request.method === 'POST') {
        const document = validateProject(await jsonBody(request), null, store);
        return respond(response, store.createProject(document), 201);
      }
      if (pathname === '/api/reorder' && request.method === 'POST') {
        const { ids } = await jsonBody(request), active = store.projects().filter(row => !row.deletedAt);
        if (!Array.isArray(ids) || ids.length !== active.length || new Set(ids).size !== ids.length || active.some(row => !ids.includes(row.id))) fail('排序列表已经变化，请刷新再试。', 409);
        store.transaction(() => ids.forEach((id, order) => { const row = active.find(row => row.id === id); store.db.prepare('UPDATE projects SET draft=?,revision=revision+1,updatedAt=? WHERE id=?').run(JSON.stringify({ ...row.draft, order: order + 1 }), now(), id); })); return respond(response, { ok: true });
      }
      const projectMatch = pathname.match(/^\/api\/projects\/([a-z][a-z0-9-]*)(?:\/(duplicate|trash|restore|unpublish))?$/);
      if (projectMatch) {
        const [, id, action] = projectMatch, row = store.project(id); if (!row) fail('作品不存在。', 404);
        if (!action && request.method === 'PUT') {
          const input = await jsonBody(request); if (input.revision !== row.revision || row.deletedAt) fail('作品已在别处修改，请刷新后重新编辑。', 409);
          const document = validateProject(input, row.draft, store);
          store.db.prepare('UPDATE projects SET draft=?,revision=revision+1,updatedAt=? WHERE id=?').run(JSON.stringify(document), now(), id); return respond(response, store.project(id));
        }
        if (action === 'duplicate' && request.method === 'POST') {
          const copy = validateProject({ ...row.draft, title: row.draft.title + ' · 副本', order: store.projects().length + 1 }, null, store);
          return respond(response, store.createProject(copy), 201);
        }
        if (action === 'restore' && request.method === 'POST') { store.db.prepare('UPDATE projects SET deletedAt=NULL,updatedAt=? WHERE id=?').run(now(), id); return respond(response, { ok: true }); }
        if (['trash', 'unpublish'].includes(action) && request.method === 'POST') {
          const deletedAt = action === 'trash' ? now() : null;
          const apply = () => store.db.prepare('UPDATE projects SET live=NULL,deletedAt=?,updatedAt=? WHERE id=?').run(deletedAt, now(), id);
          if (!row.live) { apply(); return respond(response, { ok: true }); }
          const snapshot = publisher.liveSnapshot(); snapshot.projects = snapshot.projects.filter(project => project.id !== id);
          return respond(response, publisher.start('publish', snapshot, apply, `${action === 'trash' ? '下架并移入回收站' : '下架'}：${row.draft.title}`), 202);
        }
        if (!action && request.method === 'DELETE') { if (!row.deletedAt || row.live) fail('请先移入回收站。'); store.db.prepare('DELETE FROM projects WHERE id=?').run(id); return respond(response, { ok: true }); }
      }
      if (pathname === '/api/brand' && request.method === 'PUT') {
        const input=await jsonBody(request);
        if(input.revision!==store.get('settingsRevision'))fail('名称或设置已在别处修改，请刷新后重试。',409);
        if(typeof input.name!=='string'||!input.name.trim()||input.name.length>50)fail('名称需要1～50个字符。');
        const settings=validateSettings({...store.get('settingsDraft'),brand:input.name.trim()},store);
        store.transaction(()=>{store.set('settingsDraft',settings);store.set('settingsRevision',input.revision+1);});
        return respond(response,{settings,revision:input.revision+1});
      }
      if (pathname === '/api/settings' && request.method === 'PUT') {
        const input = await jsonBody(request); if (input.revision !== store.get('settingsRevision')) fail('设置已在别处修改，请刷新。', 409);
        const settings = validateSettings(input,store); store.transaction(() => { store.set('settingsDraft', settings); store.set('settingsRevision', input.revision + 1); }); return respond(response, { ok: true, revision: input.revision + 1, settings });
      }
      if(pathname==='/api/release-retention'&&request.method==='PUT'){
        const input=await jsonBody(request),result=await publisher.configureRetention(input.keep);return respond(response,{ok:true,...result});
      }
      if (['/api/categories', '/api/tags'].includes(pathname) && ['POST', 'PUT', 'DELETE'].includes(request.method)) {
        const input = await jsonBody(request), settings = store.get('settingsDraft');
        if (input.revision !== store.get('settingsRevision')) fail('标签已在别处修改，请刷新后重试。', 409);
        if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 40) fail('标签名称需要1～40个字符。');
        const name = input.name.trim(), removing = request.method === 'DELETE', renaming = request.method === 'PUT';
        const affected = store.projects().filter(row => projectLabels(row.draft).includes(name));
        if (renaming) {
          if (!settings.categories.includes(name) && !affected.length) fail('标签不存在。', 404);
          if (typeof input.newName !== 'string' || !input.newName.trim() || input.newName.length > 40) fail('标签名称需要1～40个字符。');
          const newName = input.newName.trim();
          if (newName === name) return respond(response, { ok: true, affected: 0 });
          if (newName === '未分类') fail('请选择一个具体的标签名称。');
          if (settings.categories.includes(newName) || store.projects().some(row => projectLabels(row.draft).includes(newName))) fail('已存在同名标签，请使用其他名称。', 409);
          if (!settings.categories.includes(name) && settings.categories.length >= 200) fail('最多支持200个标签。');
          settings.categories = settings.categories.includes(name) ? settings.categories.map(value => value === name ? newName : value) : [...settings.categories, newName];
          store.transaction(() => {
            for (const row of affected) {
              const labels = projectLabels(row.draft).map(label => label === name ? newName : label);
              store.db.prepare('UPDATE projects SET draft=?,revision=revision+1,updatedAt=? WHERE id=?').run(JSON.stringify({ ...row.draft, labels, tags: labels, category: labels[0] || '未分类' }), now(), row.id);
            }
            store.set('settingsDraft', settings); store.set('settingsRevision', input.revision + 1);
          });
          return respond(response, { ok: true, affected: affected.length });
        }
        if (removing && !settings.categories.includes(name) && !affected.length) fail('标签不存在。', 404);
        if (!removing && settings.categories.includes(name)) return respond(response, { ok: true });
        if (!removing && name === '未分类') fail('请选择一个具体的标签名称。');
        if (!removing && settings.categories.length >= 200) fail('最多支持200个标签。');
        settings.categories = removing ? settings.categories.filter(value => value !== name) : [...settings.categories, name];
        store.transaction(() => {
          if (removing) for (const row of affected) { const labels = projectLabels(row.draft).filter(label => label !== name); store.db.prepare('UPDATE projects SET draft=?,revision=revision+1,updatedAt=? WHERE id=?').run(JSON.stringify({ ...row.draft, labels, tags: labels, category: labels[0] || '未分类' }), now(), row.id); }
          store.set('settingsDraft', settings); store.set('settingsRevision', input.revision + 1);
        });
        return respond(response, { ok: true, affected: affected.length });
      }
      if (pathname === '/api/media/folders' && request.method === 'POST') { const input = await jsonBody(request); return respond(response, createFolder(store, input.name, input.parentId), 201); }
      if (pathname === '/api/media/folders/ensure' && request.method === 'POST') { const input = await jsonBody(request); return respond(response, { folder: ensureFolderPath(store, input.parentId, input.path) }); }
      if (pathname === '/api/media/arrange' && request.method === 'POST') return respond(response, arrangeMedia(store, await jsonBody(request)));
      if (pathname === '/api/media/delete-plan' && request.method === 'POST') { const plan=mediaDeletePlan(store,await jsonBody(request));return respond(response,{mediaCount:plan.mediaCount,folderCount:plan.folderCount,blocked:plan.blocked,allowed:plan.allowed}); }
      if (pathname === '/api/media/delete' && request.method === 'POST') return respond(response,await deleteMediaItems(store,await jsonBody(request)));
      if (pathname === '/api/media' && request.method === 'POST') {
        const projectId = url.searchParams.get('projectId');
        const folderId = validFolder(store, url.searchParams.get('folderId'));
        if (projectId && (!store.project(projectId) || store.project(projectId).deletedAt)) fail('作品不存在。', 404);
        const bytes = await body(request, 200 * 1024 * 1024);
        const name = path.basename(url.searchParams.get('name') || '媒体').slice(0, 240);
        const media = inspectMedia(bytes, name, request.headers['content-type']);
        if (media.mime.startsWith('image/') && bytes.length > 30 * 1024 * 1024) fail('图片不能超过30 MB。', 413);
        return respond(response, await store.addAsset(bytes, name, media.mime, media, media.extension, projectId, folderId), 201);
      }
      const mediaMatch = pathname.match(/^\/api\/media\/([a-f0-9-]+)(\/file)?$/);
      if (mediaMatch) {
        const asset = store.asset(mediaMatch[1]); if (!asset) fail('素材不存在。', 404);
        if (['GET', 'HEAD'].includes(request.method) && mediaMatch[2]) { await sendFile(request, response, path.join(dataDir, 'uploads', asset.file), asset.mime); return; }
        if (request.method === 'DELETE' && !mediaMatch[2]) {
          const refs = store.references(asset.id); if (refs.projects.length || refs.inHistory || refs.inSettings) fail('素材被作品、首页设置或历史版本引用，不能删除。', 409);
          await unlink(path.join(dataDir, 'uploads', asset.file)); store.transaction(() => { store.db.prepare('DELETE FROM media WHERE id=?').run(asset.id); store.db.prepare('DELETE FROM pending_media WHERE assetId=?').run(asset.id); }); return respond(response, { ok: true });
        }
      }
      if (pathname === '/api/preview' && request.method === 'POST') {
        const input = await jsonBody(request), snapshot = { settings: input.settings ? validateSettings(input.settings,store) : store.get('settingsDraft'), projects: store.projects().filter(row => !row.deletedAt).map(row => row.draft) };
        if (input.project) { const row = store.project(input.project.id); if (!row || row.deletedAt) fail('作品不存在。', 404); const project = validateProject(input.project, row.draft, store); snapshot.projects = snapshot.projects.map(doc => doc.id === project.id ? project : doc); }
        let sidebar=null;
        if(input.sidebarClientId!=null){if(typeof input.sidebarClientId!=='string'||!/^[a-f0-9-]{36}$/.test(input.sidebarClientId)||input.keepPreviewId!=null&&(typeof input.keepPreviewId!=='string'||!/^v-\d+-[a-f0-9]{8}$/.test(input.keepPreviewId)))fail('预览标识格式不正确。');sidebar={clientId:input.sidebarClientId,keepId:input.keepPreviewId||null};}
        return respond(response, publisher.start('preview', snapshot, () => {}, '草稿预览',sidebar), 202);
      }
      if (pathname === '/api/publish' && request.method === 'POST') { const input = await jsonBody(request); return respond(response, buildPublish(input.projectIds, Boolean(input.includeSettings),input.deployment), 202); }
      const jobMatch = pathname.match(/^\/api\/jobs\/([\w-]+)$/);
      if (jobMatch && request.method === 'GET') { const job = publisher.jobs.get(jobMatch[1]); if (!job) fail('任务不存在，请刷新发布记录。', 404); return respond(response, job); }
      const exportMatch = pathname.match(/^\/api\/export\/([\w-]+)$/);
      if (exportMatch && request.method === 'GET') {
        const release=store.releases().find(release=>release.id===exportMatch[1]);if(!release)fail('版本不存在。',404);
        const kind = url.searchParams.get('kind') === 'source' ? 'source' : 'dist';
        let bytes,suffix=kind;
        if(kind==='source')bytes=await zipDirectory(path.join(dataDir,'releases',release.id,'source'));
        else{
          const saved=release.snapshot.deployment||{platform:'generic',projectName:'portfolio-site'},target=deploymentTarget({platform:url.searchParams.get('platform')??saved.platform,projectName:url.searchParams.get('projectName')??saved.projectName}),directory=path.join(dataDir,'releases',release.id,'dist');
          if(url.searchParams.get('check')==='1'){const {report}=await inspectDeployment(directory,target,store);return respond(response,report);}
          ({bytes}=await deploymentPackage(directory,target,store));suffix=target.platform==='generic'?'dist':target.platform;
        }
        response.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': bytes.length, 'Content-Disposition': `attachment; filename="portfolio-${suffix}-${exportMatch[1]}.zip"` }); response.end(bytes); return;
      }
      if (pathname === '/api/rollback' && request.method === 'POST') {
        const { id } = await jsonBody(request), release = store.releases().find(release => release.id === id); if (!release) fail('版本不存在。', 404);
        return respond(response, publisher.start('publish', release.snapshot, () => {
          store.db.exec('UPDATE projects SET live=NULL');
          for (const project of release.snapshot.projects) {
            const json = JSON.stringify(project);
            store.db.prepare('INSERT INTO projects(id,draft,live,updatedAt) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET live=excluded.live,deletedAt=NULL').run(project.id, json, json, now());
          }
          store.set('settingsLive', release.snapshot.settings);
        }, `回退到：${release.title}`), 202);
      }
      const previewMatch = pathname.match(/^\/preview\/([\w-]+)(\/.*)$/);
      if (previewMatch && ['GET', 'HEAD'].includes(request.method)) return await serve(request, response, path.join(dataDir, 'previews', previewMatch[1], 'dist'), previewMatch[2]);
      const historyMatch = pathname.match(/^\/history\/([\w-]+)(\/.*)$/);
      if (historyMatch && ['GET', 'HEAD'].includes(request.method) && store.releases().some(release => release.id === historyMatch[1])) return await serve(request, response, path.join(dataDir, 'releases', historyMatch[1], 'dist'), historyMatch[2]);
      if (pathname.startsWith('/api/') || pathname.startsWith('/preview/') || pathname.startsWith('/history/')) fail('接口不存在。', 404);
      if (!['GET', 'HEAD'].includes(request.method)) fail('不支持此操作。', 405);
      if (pathname === '/vendor/gsap.min.js') return await serve(request, response, path.join(root, 'node_modules/gsap/dist'), '/gsap.min.js');
      await serve(request, response, path.join(root, 'public'), pathname === '/' ? '/index.html' : pathname);
    } catch (error) {
      const status = error.status || (error instanceof URIError ? 400 : ['ENOENT', 'ENOTDIR'].includes(error.code) ? 404 : 500);
      respond(response, { error: status === 500 ? '操作未完成，请重试或查看服务日志。' : status === 404 && !error.status ? '文件不存在。' : error.message }, status);
      if (status === 500) console.error(error);
    }
  });
  server.requestTimeout = 120000;
  return { server, store, publisher, dataDir, async close() { await new Promise(resolve => server.close(resolve)); store.close(); } };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await createApplication(); const port = Number(process.env.PORT || 4180);
  app.server.listen(port, '127.0.0.1', () => console.log(`后台管理系统：http://127.0.0.1:${port}/\n展示副本：http://127.0.0.1:${port}/site/\n运行数据：${app.dataDir}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await app.close(); process.exit(0); });
}
