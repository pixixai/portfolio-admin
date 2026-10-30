import http from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, realpath, stat, unlink, mkdir } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { openStore, now } from './lib/store.mjs';
import { resolveRuntimeData } from './lib/runtime-data.mjs';
import { openDefaultBrowser } from './lib/launch.mjs';
import { Publisher } from './lib/publisher.mjs';
import { validateProject, validateSettings, fail } from './lib/validation.mjs';
import { zipDirectory,packageLimit } from './lib/zip.mjs';
import {ProjectImporter} from './lib/project-package.mjs';
import { inspectMedia } from './lib/media.mjs';
import { projectLabels } from './lib/labels.mjs';
import {spacesDraft,spacesLive,spaceState,saveSpace,deleteSpace,syncSpaceVisibility,isPrivate,renameSpaceLabel,spaceDefinition,mainSpace,saveMainSpace,saveProjectSpaces} from './lib/spaces.mjs';
import {createSpaceGateway} from './resources/space-gateway.mjs';
import {spaceServerConfig} from './lib/space-server-config.mjs';
import { folders, validFolder, createFolder, ensureFolderPath, arrangeMedia } from './lib/media-folders.mjs';
import { mediaDeletePlan, deleteMediaItems } from './lib/media-delete.mjs';
import {releaseRetention} from './lib/release-retention.mjs';
import {validateLocalRequest} from './lib/local-access.mjs';
import {deploymentPlatforms,deploymentTarget,inspectDeployment,deploymentPackage} from './lib/deployment.mjs';
import {RemoteSync,remoteProfile} from './lib/remote-sync.mjs';
import {UserBackup} from './lib/user-backup.mjs';
import {activateUserData} from './lib/restore-activation.mjs';

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

export async function createApplication({ dataDir, rendererDir = path.join(root, 'renderer'), remoteOptions } = {}) {
  dataDir = await resolveRuntimeData(root, { dataDir, onMigration: ({from,to}) => console.log(`旧运行数据已复制至：${to}\n原数据保留备份：${from}`) });
  await mkdir(dataDir, { recursive: true });
  dataDir = await realpath(dataDir);
  let store = await openStore(dataDir, rendererDir), publisher = new Publisher(store, rendererDir);
  syncSpaceVisibility(store);
  let remoteSync=new RemoteSync(store,remoteOptions);
  let importer=new ProjectImporter(store,publisher),activeWrites=0;
  async function reloadServices(){store=await openStore(dataDir,rendererDir);syncSpaceVisibility(store);publisher=new Publisher(store,rendererDir);remoteSync=new RemoteSync(store,remoteOptions);importer=new ProjectImporter(store,publisher);await publisher.bootstrap();}
  const backups=new UserBackup({getStore:()=>store,renderer:rendererDir,isBusy:()=>publisher.busy||remoteSync.busy||activeWrites>0,activate:stage=>activateUserData(dataDir,stage,{close:()=>store.close(),reopen:reloadServices})});
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
      capabilities:{backgroundLoop:true,sidebarPreview:true,platformExport:true,remoteSync:true,userBackup:true,privateSpaces:true,spaceGroups:true,unifiedPreview:true,spaceCodes:true,spaceFormOrigin:true,spacePin:true,spaceAutoPublic:false,displaySpaces:true,shareSpaces:true},
      spaces:{...spaceState(store),siteUrl:store.get('spacesSiteUrl')||''},
      deploymentPlatforms,deploymentTarget:store.get('deploymentTarget')||{platform:'generic',projectName:'portfolio-site'},
      jobs: [...publisher.jobs.values()].slice(-10).reverse(),
    };
  }
  function buildPublish(ids, includeSettings, targetInput) {
    const target=deploymentTarget(targetInput||{platform:'generic'});
    if (!Array.isArray(ids) || ids.length > 300 || new Set(ids).size !== ids.length) fail('请选择要发布的作品。');
    const rows = store.projects();
    const selected = ids.map(id => { const row = rows.find(row => row.id === id && !row.deletedAt); if (!row) fail('部分作品不存在。', 404); if (!row.draft.blocks.length && !row.draft.coverAssetId && !row.draft.description) fail(`“${row.draft.title}”还没有内容。`); return row; });
    const snapshot = { settings: includeSettings ? store.get('settingsDraft') : store.get('settingsLive'), projects: rows.map(row => {const document=ids.includes(row.id)?row.draft:row.live;return document?{...document,...(row.draft.visibility?{visibility:row.draft.visibility}:{})}:null;}).filter(Boolean),deployment:target,spaces:spacesDraft(store).map(spaceDefinition),mainSpace:mainSpace(store) };
    return publisher.start('publish', snapshot, () => {
      for (const document of snapshot.projects) store.db.prepare('UPDATE projects SET live=? WHERE id=?').run(JSON.stringify(document), document.id);
      store.set('spacesLive',snapshot.spaces);store.set('mainSpaceLive',snapshot.mainSpace);
      if (includeSettings) store.set('settingsLive', snapshot.settings);
      store.set('deploymentTarget',target);
    }, `发布${selected.length}个作品${includeSettings ? '及站点设置' : ''}`,null,target);
  }
  const spaceGateways=new Map();
  const sidebarTargets=new Map();
  async function serveSpace(request,response,folder,mount){const key=folder+'|'+mount;if(!spaceGateways.has(key)){if(spaceGateways.size>=30)spaceGateways.delete(spaceGateways.keys().next().value);spaceGateways.set(key,createSpaceGateway({directory:path.join(folder,'private'),mount}));}return spaceGateways.get(key)(request,response);}
  const server = http.createServer(async (request, response) => {
    request.setTimeout(120000,()=>{if(!request.complete)request.destroy();});
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Referrer-Policy', 'same-origin');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; frame-src 'self'; connect-src 'self'; frame-ancestors 'self'; object-src 'none'; base-uri 'self'");
    let trackedWrite=false;
    try {
      const url = new URL(request.url, 'http://localhost'), pathname = decodeURIComponent(url.pathname);
      validateLocalRequest(request,pathname);
      const backupRoute=pathname.startsWith('/api/backups');
      if(backups.activating&&!/^\/api\/backups\/jobs\//.test(pathname))fail('正在切换恢复数据，请稍候。',503);
      if(!['GET','HEAD'].includes(request.method)&&!backupRoute){if(backups.busy)fail('正在备份或恢复数据，请完成后重试。',409);activeWrites++;trackedWrite=true;}
      if(pathname==='/api/backups'&&request.method==='GET')return respond(response,backups.state());
      if(pathname==='/api/backups/create'&&request.method==='POST'){const input=await jsonBody(request);await backups.expire();return respond(response,backups.create(input),202);}
      if(pathname==='/api/backups/inspect'&&request.method==='POST')return respond(response,await backups.inspect(request));
      if(pathname==='/api/backups/restore'&&request.method==='POST')return respond(response,backups.restore(await jsonBody(request)),202);
      const backupMatch=pathname.match(/^\/api\/backups\/(file|jobs|pending)\/([a-f0-9-]{36})$/);
      if(backupMatch){const[,kind,id]=backupMatch;if(kind==='file'&&request.method==='GET'){if(backups.busy)fail('正在处理数据，请稍后下载。',409);return await backups.download(id,response);}if(kind==='jobs'&&request.method==='GET'){const job=backups.jobs.get(id);if(!job)fail('任务不存在。',404);return respond(response,job);}if(kind==='pending'&&request.method==='DELETE'){await backups.discard(id);return respond(response,{ok:true});}}
      if (pathname.startsWith('/site/')) {
        if(pathname.startsWith('/site/space/'))return await serveSpace(request,response,path.join(dataDir,'releases',store.get('currentRelease')),'/site/space');
        if (!['GET', 'HEAD'].includes(request.method)) fail('不支持此操作。', 405);
        return await serve(request, response, path.join(dataDir, 'releases', store.get('currentRelease'), 'dist'), pathname.slice(5));
      }
      if (pathname === '/site') { response.writeHead(302, { Location: '/site/' }).end(); return; }
      if (pathname === '/api/state' && request.method === 'GET') return respond(response, state());
      if(pathname==='/api/preview/sidebar'&&request.method==='POST'){
        const input=await jsonBody(request);if(!/^[a-f0-9-]{36}$/.test(input.clientId||'')||!/^v-\d+-[a-f0-9]{8}$/.test(input.previewId||''))fail('预览标识格式不正确。');
        const folder=path.join(dataDir,'previews',input.previewId),meta=JSON.parse(await readFile(path.join(folder,'sidebar-preview.json'),'utf8'));
        if(meta.clientId!==input.clientId)fail('不能切换其他预览会话的内容。',403);
        let target=sidebarTargets.get(input.clientId);if(!target){if(sidebarTargets.size>=64)fail('预览会话过多，请重启后台或关闭多余窗口后重试。',409);target={id:input.previewId};target.gateway=createSpaceGateway({directory:()=>path.join(dataDir,'previews',target.id,'private'),mount:'/draft/'+input.clientId+'/space'});sidebarTargets.set(input.clientId,target);}else target.id=input.previewId;
        return respond(response,{url:'/draft/'+input.clientId+'/',previewId:input.previewId});
      }
      const draftMatch=pathname.match(/^\/draft\/([a-f0-9-]{36})(\/.*)$/);
      if(draftMatch){const target=sidebarTargets.get(draftMatch[1]);if(!target)fail('预览会话已结束，请重新展开实时预览。',404);if(draftMatch[2].startsWith('/space/'))return await target.gateway(request,response);if(!['GET','HEAD'].includes(request.method))fail('不支持此操作。',405);return await serve(request,response,path.join(dataDir,'previews',target.id,'dist'),draftMatch[2]);}
      if(pathname==='/api/spaces'&&request.method==='POST'){if(publisher.busy||remoteSync.busy)fail('发布或部署进行中，请稍后修改空间。',409);return respond(response,await saveSpace(store,await jsonBody(request)),201);}
      if(pathname==='/api/spaces/site-url'&&request.method==='PUT'){const input=await jsonBody(request);let value='';if(input.url){let parsed;try{parsed=new URL(input.url);}catch{fail('请填写有效的网站地址。');}if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password||parsed.pathname!=='/'||parsed.search||parsed.hash)fail('只需填写网站地址，例如https://example.com，不含后续路径。');value=parsed.origin;}store.set('spacesSiteUrl',value);return respond(response,{ok:true});}
      if(pathname==='/api/spaces/server-config'&&request.method==='GET'){const bytes=spaceServerConfig(store.get('remoteDeployment'));response.writeHead(200,{'Content-Type':'application/zip','Content-Length':bytes.length,'Content-Disposition':'attachment; filename="private-space-server-config.zip"'});return response.end(bytes);}
      if(pathname==='/api/spaces/main'&&request.method==='PUT'){if(publisher.busy||remoteSync.busy)fail('正在发布或部署，请稍后修改空间。',409);return respond(response,saveMainSpace(store,await jsonBody(request)));}
      const assignment=pathname.match(/^\/api\/projects\/([a-z][a-z0-9-]*)\/spaces$/);
      if(assignment&&request.method==='PUT'){if(publisher.busy||remoteSync.busy)fail('正在发布或部署，请稍后修改空间。',409);return respond(response,saveProjectSpaces(store,assignment[1],await jsonBody(request)));}
      const spaceMatch=pathname.match(/^\/api\/spaces\/(s-[a-f0-9]{24})$/);
      if(spaceMatch&&['PUT','DELETE'].includes(request.method)){if(publisher.busy||remoteSync.busy)fail('发布或部署进行中，请稍后修改空间。',409);const input=await jsonBody(request);return respond(response,request.method==='PUT'?await saveSpace(store,input,spaceMatch[1]):deleteSpace(store,spaceMatch[1],input.revision));}
      if(pathname==='/api/remote'&&request.method==='GET')return respond(response,remoteSync.state());
      if(pathname==='/api/remote/fingerprint'&&request.method==='POST'){const input=await jsonBody(request);return respond(response,await remoteSync.probe(remoteProfile(input.profile)));}
      if(pathname==='/api/remote/plan'&&request.method==='POST')return respond(response,await remoteSync.inspect(await jsonBody(request)));
      if(pathname==='/api/remote/deploy'&&request.method==='POST')return respond(response,remoteSync.start(await jsonBody(request)),202);
      const remoteJobMatch=pathname.match(/^\/api\/remote\/jobs\/([a-f0-9-]{36})$/);
      if(remoteJobMatch&&request.method==='GET'){const job=remoteSync.jobs.get(remoteJobMatch[1]);if(!job)fail('部署任务不存在。',404);return respond(response,job);}
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
            store.set('mainSpaceDraft',renameSpaceLabel(mainSpace(store),name,newName));const spaces=spacesDraft(store);store.set('spacesDraft',spaces.map(space=>renameSpaceLabel(space,name,newName)));store.set('spacesRevision',(store.get('spacesRevision')||1)+1);
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
          if(removing&&spacesDraft(store).some(space=>space.groups.some(group=>group.label===name))){store.set('spacesDraft',spacesDraft(store).map(space=>renameSpaceLabel(space,name,null)));store.set('spacesRevision',(store.get('spacesRevision')||1)+1);}
          if(removing){store.set('mainSpaceDraft',renameSpaceLabel(mainSpace(store),name,null));store.set('spacesRevision',(store.get('spacesRevision')||1)+1);}
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
        const input = await jsonBody(request), snapshot = { settings: input.settings ? validateSettings(input.settings,store) : store.get('settingsDraft'), projects: store.projects().filter(row => !row.deletedAt).map(row => row.draft),spaces:spacesDraft(store),mainSpace:mainSpace(store) };
        if(input.sidebarScope!=null&&input.sidebarScope!=='public'&&!spacesDraft(store).some(space=>space.id===input.sidebarScope))fail('所选预览空间不存在。',404);
        if (input.project) { const row = store.project(input.project.id); if (!row || row.deletedAt) fail('作品不存在。', 404); const project = validateProject(input.project, row.draft, store); snapshot.projects = snapshot.projects.map(doc => doc.id === project.id ? project : doc); if(input.sidebarScope==null)snapshot.previewProjectId=project.id; }
        let sidebar=null;
        if(input.sidebarClientId!=null){if(typeof input.sidebarClientId!=='string'||!/^[a-f0-9-]{36}$/.test(input.sidebarClientId)||input.keepPreviewId!=null&&(typeof input.keepPreviewId!=='string'||!/^v-\d+-[a-f0-9]{8}$/.test(input.keepPreviewId)))fail('预览标识格式不正确。');sidebar={clientId:input.sidebarClientId,keepId:input.keepPreviewId||sidebarTargets.get(input.sidebarClientId)?.id||null};}
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
          store.set('spacesLive',release.snapshot.spaces||[]);store.set('mainSpaceLive',release.snapshot.mainSpace||null);
        }, `回退到：${release.title}`), 202);
      }
      const previewMatch = pathname.match(/^\/preview\/([\w-]+)(\/.*)$/);
      if(previewMatch&&previewMatch[2].startsWith('/space/'))return await serveSpace(request,response,path.join(dataDir,'previews',previewMatch[1]),'/preview/'+previewMatch[1]+'/space');
      if (previewMatch && ['GET', 'HEAD'].includes(request.method)) return await serve(request, response, path.join(dataDir, 'previews', previewMatch[1], 'dist'), previewMatch[2]);
      const historyMatch = pathname.match(/^\/history\/([\w-]+)(\/.*)$/);
      if(historyMatch&&historyMatch[2].startsWith('/space/')&&store.releases().some(release=>release.id===historyMatch[1]))return await serveSpace(request,response,path.join(dataDir,'releases',historyMatch[1]),'/history/'+historyMatch[1]+'/space');
      if (historyMatch && ['GET', 'HEAD'].includes(request.method) && store.releases().some(release => release.id === historyMatch[1])) return await serve(request, response, path.join(dataDir, 'releases', historyMatch[1], 'dist'), historyMatch[2]);
      if (pathname.startsWith('/api/') || pathname.startsWith('/preview/') || pathname.startsWith('/history/')) fail('接口不存在。', 404);
      if (!['GET', 'HEAD'].includes(request.method)) fail('不支持此操作。', 405);
      if (pathname === '/vendor/gsap.min.js') return await serve(request, response, path.join(root, 'node_modules/gsap/dist'), '/gsap.min.js');
      await serve(request, response, path.join(root, 'public'), pathname === '/' ? '/index.html' : pathname);
    } catch (error) {
      if(response.headersSent){response.destroy(error);return;}
      const status = error.status || (error instanceof URIError ? 400 : ['ENOENT', 'ENOTDIR'].includes(error.code) ? 404 : 500);
      respond(response, { error: status === 500 ? '操作未完成，请重试或查看服务日志。' : status === 404 && !error.status ? '文件不存在。' : error.message }, status);
      if (status === 500) console.error(error);
    } finally {if(trackedWrite)activeWrites--;}
  });
  // Large private backups may upload for longer than two minutes. Enforce
  // incoming-body inactivity and byte limits instead of an overall deadline.
  server.requestTimeout = 0;server.headersTimeout=60000;
  return { server, get store(){return store;}, get publisher(){return publisher;}, get remoteSync(){return remoteSync;}, backups, dataDir, async close() { await new Promise(resolve => server.close(resolve)); store.close(); } };
}
export async function startApplication({ port = Number(process.env.PORT || 4180), openBrowser = false, browserOpener = openDefaultBrowser, ...options } = {}) {
  // Detect an old running instance before migrating its data or bootstrapping.
  const probe = net.createServer();
  await new Promise((resolve,reject) => { probe.once('error',reject);probe.listen(port,'127.0.0.1',resolve); });
  await new Promise(resolve => probe.close(resolve));
  const app = await createApplication(options);
  try {
    await new Promise((resolve,reject) => { app.server.once('error',reject);app.server.listen(port,'127.0.0.1',resolve); });
  } catch (error) { app.store.close(); throw error; }
  const url = `http://127.0.0.1:${app.server.address().port}/`;
  console.log(`后台管理系统：${url}\n展示副本：${url}site/\n运行数据：${app.dataDir}`);
  if (openBrowser) browserOpener(url);
  return app;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await startApplication({openBrowser:process.argv.includes('--open-browser')}).catch(error=>{
    console.error(error.code==='EADDRINUSE'?'后台端口已被占用，请关闭原来的后台窗口后重试。':error.message);process.exit(1);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await app.close(); process.exit(0); });
}
