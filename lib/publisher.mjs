import { cp, mkdir, readFile, writeFile, rename, access, symlink, readdir, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { now } from './store.mjs';
import { fail } from './validation.mjs';
import { projectLabels,orderedLabelNames,orderLabelGroups } from './labels.mjs';
import { coverAssetId, usesFirstImage } from './cover.mjs';
import { serializeProjectBlocks } from './blocks.mjs';
import { validateHomeBackground, homeBackgroundAssets } from './home-background.mjs';
import {validateRetention,pruneReleases,recoverReleaseCleanup} from './release-retention.mjs';
import {writeRestorePackage} from './project-package.mjs';
import {pruneSidebarPreviews} from './sidebar-previews.mjs';
import {checkDeployment} from './deployment.mjs';
import {spacesLive,isPrivate,includesProject,validateSpaces,spaceProjectLabels,validateMainSpace} from './spaces.mjs';
const execute = promisify(execFile);
const escape = value => String(value).replace(/[&<>"'{}]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '{': '&#123;', '}': '&#125;' })[c]);
const dependencies = fileURLToPath(new URL('../node_modules/', import.meta.url));

export class Publisher {
  constructor(store, renderer,{publishedUrl=null}={}) { this.publishedUrl=publishedUrl; this.store = store; this.renderer = renderer; this.jobs = new Map(); this.busy = false; }
  liveSnapshot() { return { settings: this.store.get('settingsLive'), projects: this.store.projects().filter(row => row.live).map(row => row.live),spaces:spacesLive(this.store),...(this.store.get('mainSpaceLive')?{mainSpace:this.store.get('mainSpaceLive')}:{}) }; }
  async configureRetention(keep) {
    validateRetention(keep);if(this.busy)fail('正在生成预览或发布，请完成后再调整保留数量。',409);
    this.busy=true;
    try{const result=await pruneReleases(this.store,keep,true);result.removed.forEach(id=>this.jobs.delete(id));return result;}finally{this.busy=false;}
  }
  start(kind, snapshot, apply = () => {}, title = '发布作品集', sidebar = null, deployment = null) {
    if (this.busy) fail('正在处理另一个预览或发布，请稍候。', 409);
    this.busy = true;
    const id = `v-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const job = { id, kind, title, status: 'running', message: '正在生成站点…', createdAt: now() };
    if(kind==='preview'&&sidebar)job.sidebar=sidebar;
    if(deployment)job.deployment=deployment;
    this.jobs.set(id, job);
    this.run(job, snapshot, apply).finally(() => { this.busy = false; });
    return job;
  }
  async run(job, snapshot, apply) {
    const directory = path.join(this.store.directory, 'jobs', job.id);
    try {
      await this.build(directory, snapshot);
      if(job.deployment)job.deploymentReport=await checkDeployment(path.join(directory,'dist'),job.deployment,this.store);
      const target = path.join(this.store.directory, job.kind === 'preview' ? 'previews' : 'releases', job.id);
      await rename(directory, target);
      if(job.sidebar){
        await writeFile(path.join(target,'sidebar-preview.json'),JSON.stringify({clientId:job.sidebar.clientId,createdAt:job.createdAt}));
        try{const removed=await pruneSidebarPreviews(this.store,job.sidebar.clientId,job.sidebar.keepId);removed.forEach(id=>this.jobs.delete(id));}catch{job.cleanupPending=true;}
      }
      if (job.kind !== 'preview') {
        this.store.transaction(() => {
          apply();
          this.store.promoteAssets(snapshot.projects);
          for (const assetId of homeBackgroundAssets(snapshot.settings)) this.store.registerAsset(assetId,null);
          this.store.db.prepare('INSERT INTO releases VALUES(?,?,?,?)').run(job.id, job.title, job.createdAt, JSON.stringify(snapshot));
          this.store.set('currentRelease', job.id);
        });
      }
      let cleanupWarning=false;
      if(job.kind!=='preview'){try{const result=await pruneReleases(this.store);result.removed.forEach(id=>this.jobs.delete(id));cleanupWarning=!!result.pending;}catch{cleanupWarning=true;}}
      job.status = 'done'; job.message = job.kind === 'preview' ? '预览已生成' : cleanupWarning?'发布成功，部分历史文件清理将在后续重试':'发布成功';
      job.url = job.kind === 'preview' ? `/preview/${job.id}/` : this.publishedUrl||'/site/';
    } catch (error) {
      job.status = 'failed'; job.message = String(error.stderr || error.message).slice(-1500);
    }
  }
  async build(directory, snapshot, spaceRender=false) {
    const complete=snapshot,labelOrder=orderedLabelNames(snapshot.settings,snapshot.projects,[snapshot.mainSpace,...(snapshot.spaces||[])]),spaces=validateSpaces(snapshot.spaces||[],snapshot.projects).map(space=>orderLabelGroups(space,labelOrder));
    if(!spaceRender){const main=snapshot.mainSpace?orderLabelGroups(validateMainSpace(snapshot.mainSpace,snapshot.projects),labelOrder):null;snapshot={...snapshot,...(main?{settings:{...snapshot.settings,categories:main.groups.map(group=>group.label),spaceGrouping:true,spaceProjectOrder:[]}}:{}),projects:snapshot.projects.filter(project=>project.id===snapshot.previewProjectId||(main?includesProject(main,project):!isPrivate(project)&&!spaces.some(space=>includesProject(space,project)))).map(project=>main?{...project,labels:spaceProjectLabels(main,project),tags:spaceProjectLabels(main,project),category:spaceProjectLabels(main,project)[0]||'未分类'}:project)};}
    const source = path.join(directory, 'source');
    await mkdir(directory, { recursive: true });
    await cp(this.renderer, source, { recursive: true, filter: file => !path.relative(this.renderer, file).split(path.sep).some(part => ['node_modules', '.preview', 'dist', 'Portfolio'].includes(part)) });
    // Build in private runtime storage while sharing this installation's dependencies.
    // The junction is excluded from both deployment and source ZIP exports.
    await symlink(dependencies, path.join(source, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    await mkdir(path.join(source, 'Portfolio'), { recursive: true });
    const background=validateHomeBackground(snapshot.settings.homeBackground,this.store), urls=new Map();
    await mkdir(path.join(source,'assets/home/uploads'),{recursive:true});
    for (const id of homeBackgroundAssets({homeBackground:background})) {
      const asset=this.store.asset(id), destination=`assets/home/uploads/${asset.file}`;
      await cp(path.join(this.store.directory,'uploads',asset.file),path.join(source,destination)); urls.set(id,destination);
    }
    await writeFile(path.join(source, 'site.json'), JSON.stringify({...snapshot.settings,homeBackground:{shadeOpacity:background.shadeOpacity,shadeColor:background.shadeColor,loop:background.loop,videos:background.videos.map(item=>({src:item.assetId?urls.get(item.assetId):'assets/home/home-background.mp4',...(item.type==='image'?{type:'image',duration:item.duration}:{playbackRate:item.playbackRate})})),finalFrame:urls.get(background.finalFrameAssetId)||null}}, null, 2));
    for (const project of snapshot.projects) {
      const folder = path.join(source, 'Portfolio', project.folder);
      if (!folder.startsWith(path.join(source, 'Portfolio') + path.sep)) fail('作品目录不正确。');
      await mkdir(path.join(folder, 'images'), { recursive: true });
      const assets = new Map();
      const coverId = coverAssetId(project);
      for (const id of new Set([coverId, ...project.blocks.map(block => block.assetId)].filter(Boolean))) {
        const asset = this.store.asset(id);
        if (!asset) fail(`作品“${project.title}”的素材缺失。`);
        await cp(path.join(this.store.directory, 'uploads', asset.file), path.join(folder, 'images', asset.file));
        assets.set(id, `images/${asset.file}`);
      }
      const metadata = {
        id: project.id, title: project.title, category: project.category, english: project.english || project.title,
        description: project.description || project.title, tags: spaceRender?project.labels||[]:projectLabels(project), labels: spaceRender?project.labels||[]:projectLabels(project), order: project.order,
        cover: assets.get(coverId) || '', useFirstImage: usesFirstImage(project), coverRatio: project.coverRatio, coverCrop: coverId ? project.coverCrop || null : null,
      };
      const body = serializeProjectBlocks(project, assets);
      await writeFile(path.join(folder, 'index.md'), `---\n${stringify(metadata)}---\n\n${body}\n`);
    }
    const settings = snapshot.settings;
    let html = await readFile(path.join(source, 'index.html'), 'utf8');
    html = html.replace(/(<p class="home-brand">)[\s\S]*?(<\/p>)/, (_, a, b) => a + escape(settings.brand) + b)
      .replace(/(<p class="home-tagline">)[\s\S]*?(<\/p>)/, (_, a, b) => a + escape(settings.tagline) + b)
      .replace(/(<p class="home-identity">)[\s\S]*?(<\/p>)/, (_, a, b) => a + '<span>你好，我是{{owner}}</span><span>' + escape(settings.role) + '</span>' + b);
    let index = 0;
    html = html.replace(/(<span class="paper-glyph(?: paper-glyph--wide)?">)[\s\S]*?(<\/span>)/g, () => {
      const word = settings.skills[index++][0]; return `<span class="paper-glyph${word.length > 3 ? ' paper-glyph--wide' : ''}">${escape(word)}</span>`;
    });
    index = 0;
    html = html.replace(/(<span class="paper-word">)[\s\S]*?(<\/span>)/g, () => `<span class="paper-word">${escape(settings.skills[index++][1])}</span>`);
    await writeFile(path.join(source, 'index.html'), html);
    const radius = settings.appearance.coverRadius, accent = settings.appearance.accent;
    const css = await readFile(path.join(source, 'origami-hero.css'), 'utf8');
    await writeFile(path.join(source, 'origami-hero.css'), css + `\n:root{--accent:${accent}}.home-primary{background:${accent}}.filters button[aria-pressed="true"]{color:${accent}}.project-card .card-image{border-radius:${radius}px}\n`);
    const homeCSS=await readFile(path.join(source,'home-image.css'),'utf8');
    await writeFile(path.join(source,'home-image.css'),homeCSS+`\n:root{--accent:${accent}}.filters button[aria-pressed="true"]{color:${accent}}.project-card .card-image{border-radius:${radius}px}\n`);
    await execute(process.execPath, [path.join(source, 'scripts/build.mjs')], { cwd: source, timeout: 90000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
    await access(path.join(source, 'dist/index.html'));
    JSON.parse(await readFile(path.join(source, 'dist/data/projects.json'), 'utf8'));
    await rename(path.join(source, 'dist'), path.join(directory, 'dist'));
    if(!spaceRender)await writeRestorePackage(path.join(directory,'dist'),source,snapshot,this.store);
    await writeFile(path.join(directory, 'snapshot.json'), JSON.stringify(complete, null, 2));
    if(!spaceRender)await this.buildSpaces(directory,complete,spaces,snapshot.projects);
  }
  async buildSpaces(directory,snapshot,spaces,publicProjects){
    // This directory is a sibling of dist, never a child of the public web root.
    const privateRoot=path.join(directory,'private');await mkdir(privateRoot,{recursive:true});
    const files=async root=>{const result={};async function walk(base,prefix=''){for(const entry of await readdir(base,{withFileTypes:true})){const name=prefix+entry.name;if(entry.isDirectory())await walk(path.join(base,entry.name),name+'/');else if(entry.isFile())result[name]=1;}}await walk(root);return result;};
    const catalog={format:'portfolio-private-spaces',version:1,spaces:[],publicFiles:await files(path.join(directory,'dist'))};
    for(const space of spaces.filter(space=>space.enabled)){
      const stage=path.join(directory,'space-builds',space.id),projects=snapshot.projects.filter(project=>(!snapshot.mainSpace&&publicProjects.some(item=>item.id===project.id))||includesProject(space,project)).map(project=>{const labels=spaceProjectLabels(space,project);return{...project,labels,tags:labels,category:labels[0]||'未分类'};});
      const settings={...snapshot.settings,categories:space.groups.map(group=>group.label),spaceGrouping:true,spaceProjectOrder:[]};
      await this.build(stage,{settings,projects,spaces:[]},true);
      const target=path.join(privateRoot,'spaces',space.id);await mkdir(path.dirname(target),{recursive:true});await rename(path.join(stage,'dist'),target);
      const bar=`<aside class="private-space-bar" style="position:fixed;top:12px;right:12px;z-index:1500;display:flex;align-items:center;gap:16px;padding:10px 14px;background:#111d;color:white;font:13px system-ui"><span>${escape(space.name)}</span>${space.accessMode==='public'?'':`<form data-space-logout method="post"><button style="background:transparent;border:1px solid #ffffff70;color:white;padding:4px 8px;cursor:pointer">退出空间</button></form>`}</aside>`;
      const sessionCode=`const root=new URL(document.querySelector('script[data-site-root]').dataset.siteRoot,location.href);const logout=document.querySelector('[data-space-logout]');if(logout)logout.action=new URL('logout',root);window.addEventListener('pageshow',e=>{if(e.persisted)location.reload();});`;
      await writeFile(path.join(target,'space-session.js'),sessionCode);
      const entries=await files(target);for(const name of Object.keys(entries).filter(name=>name.endsWith('.html'))){const file=path.join(target,name),prefix=name==='index.html'?'':'../../';let html=await readFile(file,'utf8');html=html.replace('</head>','<meta name="robots" content="noindex,nofollow,noarchive"></head>').replace('</body>',bar+`<script src="${prefix}space-session.js" type="module"></script></body>`);await writeFile(file,html);}
      if(space.accessMode==='public')await cp(target,path.join(directory,'dist','space',space.id),{recursive:true});
      const {displayCode,...publishedSpace}=space;catalog.spaces.push({...publishedSpace,files:await files(target)});
    }
    catalog.publicFiles=await files(path.join(directory,'dist'));
    const metadata=JSON.stringify(catalog);if(Buffer.byteLength(metadata)>30*1024**2)fail('分享空间索引过大，请减少单次发布的空间或作品数量。');await writeFile(path.join(privateRoot,'catalog.json'),metadata);
    await cp(fileURLToPath(new URL('../resources/space-gateway.mjs',import.meta.url)),path.join(privateRoot,'space-gateway.mjs'));
    const builds=path.join(directory,'space-builds');if(path.dirname(path.resolve(builds))!==path.resolve(directory))throw new Error('Invalid generated space directory');await rm(builds,{recursive:true,force:true});
  }
  async bootstrap() {
    await recoverReleaseCleanup(this.store);
    if (this.store.get('currentRelease')) return;
    const snapshot = this.liveSnapshot();
    const job = this.start('publish', snapshot, () => {}, '导入现有作品集');
    while (job.status === 'running') await new Promise(resolve => setTimeout(resolve, 50));
    if (job.status !== 'done') throw new Error(job.message);
  }
}
