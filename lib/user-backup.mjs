import {mkdir,readdir,lstat,unlink,rm,realpath} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {Store,digest} from './store.mjs';
import {Publisher} from './publisher.mjs';
import {createFolder} from './media-folders.mjs';
import {initializeDisplaySpaces,includeMainProjects} from './spaces.mjs';
import {validateProject,validateSettings,fail} from './validation.mjs';
import {homeBackgroundAssets} from './home-background.mjs';
import {backupSections,selectedSections,backupSnapshot,receiveBackup,hashFile,linkFile,documentAssets,streamBackup} from './user-backup-data.mjs';

const clone=value=>structuredClone(value),tokenPattern=/^[a-f\d-]{36}$/;
export async function removeBackupDirectory(directory,parent,prefix=''){
  directory=path.resolve(directory);parent=path.resolve(parent);
  if(path.dirname(directory)!==parent||prefix&&!path.basename(directory).startsWith(prefix))throw new Error('备份临时目录超出清理范围。');
  const info=await lstat(directory).catch(error=>{if(error.code!=='ENOENT')throw error;});if(!info)return;if(info.isSymbolicLink()||!info.isDirectory()||await realpath(parent)!==parent||path.dirname(await realpath(directory))!==parent)throw new Error('备份临时目录类型或位置不正确。');await rm(directory,{recursive:true,force:true});
}
async function copyTree(source,target){
  await mkdir(target,{recursive:true});for(const entry of await readdir(source,{withFileTypes:true})){if(entry.name==='node_modules')continue;const file=path.join(source,entry.name);if(entry.isSymbolicLink())fail('用户数据包含无法备份的符号链接。');if(entry.isDirectory())await copyTree(file,path.join(target,entry.name));else if(entry.isFile())await linkFile(file,path.join(target,entry.name));}
}
function remapSettings(settings,map){const value=clone(settings);value.homeBackground?.videos.forEach(item=>{if(item.assetId)item.assetId=map.get(item.assetId)||item.assetId;});if(value.homeBackground?.finalFrameAssetId)value.homeBackground.finalFrameAssetId=map.get(value.homeBackground.finalFrameAssetId)||value.homeBackground.finalFrameAssetId;return value;}
function remapDocument(document,map){if(!document)return null;const value=clone(document);if(value.coverAssetId)value.coverAssetId=map.get(value.coverAssetId)||value.coverAssetId;value.blocks.forEach(block=>{if(block.assetId)block.assetId=map.get(block.assetId)||block.assetId;});return value;}
function remapSnapshot(snapshot,map){return{...clone(snapshot),settings:remapSettings(snapshot.settings,map),projects:snapshot.projects.map(document=>remapDocument(document,map))};}

export class UserBackup {
  constructor({getStore,renderer,activate,isBusy}){this.getStore=getStore;this.renderer=renderer;this.activate=activate;this.isBusy=isBusy;this.busy=false;this.activating=false;this.uploads=0;this.downloads=0;this.prepared=new Map();this.pending=new Map();this.jobs=new Map();}
  get store(){return this.getStore();}
  get transferRoot(){return path.join(path.dirname(this.store.directory),'.portfolio-user-transfer-'+digest(this.store.directory).slice(0,16));}
  baseline(){return digest({meta:this.store.db.prepare('SELECT * FROM meta ORDER BY key').all(),projects:this.store.projects(),media:this.store.media(),folders:this.store.db.prepare('SELECT * FROM media_folders ORDER BY id').all(),releases:this.store.releases()});}
  ensureIdle(){if(this.busy||this.uploads||this.downloads||this.isBusy())fail('正在保存、预览、发布、部署或处理数据，请完成后重试。',409);}
  state(){return{sections:backupSections,counts:{projects:this.store.projects().length,media:this.store.media().length,history:this.store.releases().length},busy:this.busy};}
  job(kind,work){const job={id:randomUUID(),kind,status:'running',message:kind==='backup'?'正在准备备份…':'正在恢复数据…'};this.busy=true;this.jobs.set(job.id,job);(async()=>{try{job.result=await work(job);job.status='done';job.message=kind==='backup'?'备份已准备，可以下载':'所选数据已恢复';}catch(error){job.status='failed';job.message=error.message;}finally{this.busy=false;this.activating=false;}})();return job;}
  async expire(){
    if(this.busy||this.uploads||this.downloads)return;
    for(const [map,name]of [[this.prepared,'backups'],[this.pending,'restores']]){
      const root=path.join(this.transferRoot,name);await mkdir(root,{recursive:true});
      for(const entry of await readdir(root,{withFileTypes:true})){if(!entry.isDirectory()||!tokenPattern.test(entry.name))continue;const directory=path.join(root,entry.name),info=await lstat(directory);if(info.mtimeMs<Date.now()-3600000){await removeBackupDirectory(directory,root);map.delete(entry.name);}}
    }
  }
  create(input){this.ensureIdle();const sections=selectedSections(input?.sections);return this.job('backup',async job=>{
    const snapshot=await backupSnapshot(this.store,this.renderer,sections),metadata=JSON.stringify({...snapshot,assets:snapshot.assets.map(({source,...asset})=>asset)}),root=path.join(this.transferRoot,'backups'),directory=path.join(root,job.id);
    if(Buffer.byteLength(metadata)>20*1024**2||snapshot.assets.length>30000||snapshot.projects.length>5000||snapshot.folders.length>10000||snapshot.releases.length>100||snapshot.assets.reduce((sum,asset)=>sum+asset.size+512,Buffer.byteLength(metadata)+1024)>50*1024**3)fail('所选数据超过备份包限制，请分类别备份。');await mkdir(directory,{recursive:true});
    try{for(let i=0;i<snapshot.assets.length;i++){const asset=snapshot.assets[i];job.message=`正在校验素材 ${i+1}/${snapshot.assets.length}`;if(await hashFile(asset.source)!==asset.hash)fail('素材文件校验失败，请先检查素材库。');const target=path.join(directory,asset.file);await linkFile(asset.source,target);asset.source=target;}
      this.prepared.set(job.id,{snapshot,directory});return{downloadUrl:'/api/backups/file/'+job.id,sections,assets:snapshot.assets.length};
    }catch(error){await removeBackupDirectory(directory,root);throw error;}
  });}
  async download(id,response){const item=this.prepared.get(id);if(!item)fail('备份已过期，请重新备份。',410);this.downloads++;try{response.writeHead(200,{'Content-Type':'application/zip','Content-Disposition':`attachment; filename="portfolio-user-backup-${new Date().toISOString().slice(0,10)}.zip"`});await streamBackup(item.snapshot,response);}finally{this.downloads--;}}
  async inspect(request){if(this.busy||this.uploads>=2)fail('正在处理数据，请稍后选择备份。',409);this.uploads++;const token=randomUUID(),root=path.join(this.transferRoot,'restores'),directory=path.join(root,token);
    try{const data=await receiveBackup(request,directory),baseline=this.baseline();this.pending.set(token,{data,baseline,directory,createdAt:Date.now()});return{token,sections:data.sections,counts:data.counts,createdAt:data.createdAt,legacy:data.legacy,title:data.settings?.draft?.title||'',conflicts:data.projects.filter(row=>this.store.project(row.id)).map(row=>({id:row.id,title:this.store.project(row.id).draft.title}))};}
    catch(error){await removeBackupDirectory(directory,root).catch(()=>{});throw error;}finally{this.uploads--;}
  }
  async discard(token){if(this.busy)return;const item=this.pending.get(token);if(!item)return;this.pending.delete(token);await removeBackupDirectory(item.directory,path.dirname(item.directory));}
  restore(input){this.ensureIdle();const item=this.pending.get(input?.token);if(!item||Date.now()-item.createdAt>3600000)fail('恢复预览已过期，请重新选择文件。',410);const sections=selectedSections(input.sections,item.data.sections);if(this.baseline()!==item.baseline)fail('检查备份后已有数据发生变化，请重新选择备份并确认。',409);return this.job('restore',job=>this.restoreData(item,sections,job));}
  async restoreData(item,sections,job){
    const old=this.store,parent=path.dirname(old.directory),stage=path.join(parent,'.portfolio-user-restore-'+job.id);await mkdir(stage);let candidate,activated=false;
    const has=id=>sections.includes(id),data=item.data;
    try{
      old.db.prepare('VACUUM INTO ?').run(path.join(stage,'portfolio.sqlite'));candidate=new Store(stage);
      for(const name of ['uploads','jobs','previews','releases'])await mkdir(path.join(stage,name));
      job.message='正在准备恢复副本，原数据保持可用…';
      for(const asset of old.media()){const source=path.join(old.directory,'uploads',asset.file);try{await linkFile(source,path.join(stage,'uploads',asset.file));}catch(error){if(error.code!=='ENOENT')throw error;}}
      if(!has('history'))for(const release of old.releases())await copyTree(path.join(old.directory,'releases',release.id),path.join(stage,'releases',release.id));
      const needed=new Set();
      if(has('projects'))data.projects.forEach(row=>{[row.draft,row.live].forEach(document=>documentAssets(document).forEach(id=>needed.add(id)));data.assets.forEach(asset=>{if(asset.pendingProjects?.includes(row.id))needed.add(asset.id);});});
      if(has('settings'))[data.settings.draft,data.settings.live].forEach(settings=>homeBackgroundAssets(settings).forEach(id=>needed.add(id)));
      if(has('history'))data.releases.forEach(release=>{homeBackgroundAssets(release.snapshot.settings).forEach(id=>needed.add(id));release.snapshot.projects.forEach(document=>documentAssets(document).forEach(id=>needed.add(id)));});
      const incoming=data.assets.filter(asset=>has('media')||needed.has(asset.id)),folderMap=new Map();
      function getFolder(id){if(!id)return null;if(folderMap.has(id))return folderMap.get(id);const source=data.folders.find(folder=>folder.id===id);if(!source)fail('恢复素材的文件夹缺失。');const parentId=getFolder(source.parentId),folder=createFolder(candidate,source.name,parentId,true);folderMap.set(id,folder.id);if(has('media'))candidate.db.prepare('UPDATE media_folders SET sortOrder=? WHERE id=?').run(source.sortOrder,folder.id);return folder.id;}
      if(has('media'))data.folders.forEach(folder=>getFolder(folder.id));
      const mapping=new Map();
      for(const asset of incoming){
        const existing=candidate.asset(asset.id),same=existing?.hash===asset.hash&&existing?.mime===asset.mime&&/^[a-f\d-]{36}$/i.test(existing.id),id=same?existing.id:!existing&&/^[a-f\d-]{36}$/i.test(asset.id)?asset.id:randomUUID();
        const file=same?existing.file:randomUUID()+path.extname(asset.file),folderId=getFolder(asset.folderId),library=!has('projects')&&!asset.library?1:asset.library;
        if(!same){await linkFile(asset.source,path.join(stage,'uploads',file));candidate.db.prepare('INSERT INTO media(id,name,file,mime,size,width,height,hash,createdAt,library,folderId,sortOrder) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,asset.name,file,asset.mime,asset.size,asset.width,asset.height,asset.hash,asset.createdAt||new Date().toISOString(),library,folderId,asset.sortOrder);}
        else {try{await lstat(path.join(stage,'uploads',file));}catch(error){if(error.code!=='ENOENT')throw error;await linkFile(asset.source,path.join(stage,'uploads',file));}if(has('media'))candidate.db.prepare('UPDATE media SET name=?,library=?,folderId=?,sortOrder=? WHERE id=?').run(asset.name,library,folderId,asset.sortOrder,id);}
        mapping.set(asset.id,id);
      }
      if(has('projects')){
        if(!data.legacy){candidate.db.exec('DELETE FROM pending_media; DELETE FROM projects');candidate.set('mainSpaceDraft',data.spaces?.mainDraft||null);candidate.set('mainSpaceLive',data.spaces?.mainLive||null);candidate.set('displaySpacesVersion',data.spaces?.mainDraft?1:0);candidate.set('spacesDraft',data.spaces?.draft||[]);candidate.set('spacesLive',data.spaces?.live||[]);candidate.set('spacesSiteUrl',data.spaces?.siteUrl||'');candidate.set('spaceCodeKey',data.spaces?.displayKey||null);candidate.set('spacesRevision',(old.get('spacesRevision')||1)+1);}
        for(const row of data.projects){
          const previous=old.project(row.id),draft=remapDocument(row.draft,mapping),live=remapDocument(row.live,mapping);if(data.legacy&&previous){draft.folder=previous.draft.folder;draft.english=previous.draft.english;}
          const validated=validateProject(draft,draft,candidate),published=data.legacy?previous?.live||null:live?validateProject(live,live,candidate):null;
          candidate.db.prepare('INSERT OR REPLACE INTO projects(id,draft,live,revision,deletedAt,updatedAt) VALUES(?,?,?,?,?,?)').run(row.id,JSON.stringify(validated),published?JSON.stringify(published):null,Math.max(previous?.revision||0,row.revision)+1,data.legacy?null:row.deletedAt||null,row.updatedAt||new Date().toISOString());
        }
        for(const asset of incoming)for(const projectId of asset.pendingProjects||[])if(candidate.project(projectId))candidate.db.prepare('INSERT OR IGNORE INTO pending_media VALUES(?,?)').run(mapping.get(asset.id),projectId);
      }
      if(has('projects')){if(data.legacy)includeMainProjects(candidate,data.projects.map(row=>row.draft));else initializeDisplaySpaces(candidate);}
      if(has('settings')){
        candidate.set('settingsDraft',validateSettings(remapSettings(data.settings.draft,mapping),candidate));
        if(!data.legacy)candidate.set('settingsLive',validateSettings(remapSettings(data.settings.live,mapping),candidate));
        candidate.set('settingsRevision',(old.get('settingsRevision')||0)+1);
      }
      if(has('preferences')){candidate.set('releaseRetention',data.preferences.releaseRetention);candidate.set('deploymentTarget',data.preferences.deploymentTarget);if(data.preferences.remoteDeployment)candidate.set('remoteDeployment',data.preferences.remoteDeployment);else candidate.db.prepare("DELETE FROM meta WHERE key='remoteDeployment'").run();}
      const publisher=new Publisher(candidate,this.renderer);
      if(has('history')){
        candidate.db.exec('DELETE FROM releases');let current;
        for(let i=0;i<data.releases.length;i++){
          const release=data.releases[i],id=`v-${Date.now()}-${randomUUID().slice(0,8)}`,snapshot=remapSnapshot(release.snapshot,mapping);job.message=`正在恢复发布版本 ${i+1}/${data.releases.length}`;
          await publisher.build(path.join(stage,'releases',id),snapshot);candidate.db.prepare('INSERT INTO releases VALUES(?,?,?,?)').run(id,release.title,release.createdAt||new Date().toISOString(),JSON.stringify(snapshot));if(release.id===data.currentRelease)current=id;
        }
        candidate.set('currentRelease',current);
      }else if(!data.legacy&&(has('projects')||has('settings'))){
        job.message='正在生成恢复后的展示版本…';const id=`v-${Date.now()}-${randomUUID().slice(0,8)}`,snapshot=publisher.liveSnapshot();await publisher.build(path.join(stage,'releases',id),snapshot);candidate.db.prepare('INSERT INTO releases VALUES(?,?,?,?)').run(id,'恢复用户数据',new Date().toISOString(),JSON.stringify(snapshot));candidate.set('currentRelease',id);
      }
      if(has('media')){
        const keep=new Set(mapping.values());[candidate.get('settingsDraft'),candidate.get('settingsLive')].forEach(settings=>homeBackgroundAssets(settings).forEach(id=>keep.add(id)));
        candidate.projects().forEach(row=>[row.draft,row.live].forEach(document=>documentAssets(document).forEach(id=>keep.add(id))));candidate.releases().forEach(release=>{homeBackgroundAssets(release.snapshot.settings).forEach(id=>keep.add(id));release.snapshot.projects.forEach(document=>documentAssets(document).forEach(id=>keep.add(id)));});
        candidate.media().forEach(asset=>{if(asset.pendingProjects.length)keep.add(asset.id);});
        for(const asset of candidate.media())if(!keep.has(asset.id)){candidate.db.prepare('DELETE FROM pending_media WHERE assetId=?').run(asset.id);candidate.db.prepare('DELETE FROM media WHERE id=?').run(asset.id);await unlink(path.join(stage,'uploads',asset.file)).catch(error=>{if(error.code!=='ENOENT')throw error;});}
        const requiredFolders=new Set(folderMap.values()),allFolders=candidate.db.prepare('SELECT * FROM media_folders').all();for(const asset of candidate.media()){let id=asset.folderId;while(id){requiredFolders.add(id);id=allFolders.find(folder=>folder.id===id)?.parentId;}}
        candidate.transaction(()=>{candidate.db.exec('PRAGMA defer_foreign_keys=ON');for(const folder of allFolders)if(!requiredFolders.has(folder.id))candidate.db.prepare('DELETE FROM media_folders WHERE id=?').run(folder.id);});
      }
      const check=candidate.db.prepare('PRAGMA integrity_check').get();if(check.integrity_check!=='ok'||candidate.db.prepare('PRAGMA foreign_key_check').all().length)fail('恢复副本检查失败，原数据未更改。');
      candidate.close();candidate=null;this.activating=true;job.message='正在启用恢复后的数据…';
      const safetyBackup=await this.activate(stage);activated=true;const temporary=[...this.prepared.values(),...this.pending.values()];this.prepared.clear();this.pending.clear();for(const entry of temporary)await removeBackupDirectory(entry.directory,path.dirname(entry.directory)).catch(()=>{});return{sections,safetyBackup,legacy:data.legacy};
    }finally{candidate?.close();if(!activated)await removeBackupDirectory(stage,parent,'.portfolio-user-restore-');}
  }
}
