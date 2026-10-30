import {includeMainProjects} from './spaces.mjs';
import {readdir,readFile,writeFile,mkdir,unlink,stat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {readZip} from './zip.mjs';
import {digest,now} from './store.mjs';
import {fail,validateProject,validateSettings} from './validation.mjs';
import {inspectMedia} from './media.mjs';
import {folders,createFolder} from './media-folders.mjs';
import {homeBackgroundAssets,defaultHomeBackground} from './home-background.mjs';
import {usesFirstImage} from './cover.mjs';

export const restorePath='assets/home/portfolio-restore.json';
const clone=value=>JSON.parse(JSON.stringify(value));
const validId=value=>typeof value==='string'&&/^[\w-]{1,80}$/.test(value);
const cleanText=(value,max)=>typeof value==='string'&&value.length<=max&&!/[\x00-\x08]/.test(value);
function folderPath(store,id){const all=new Map(folders(store).map(row=>[row.id,row])),result=[];while(id){const row=all.get(id);if(!row||result.length>=20)fail('素材文件夹层级异常。');result.unshift(row.name);id=row.parentId;}return result;}

export async function writeRestorePackage(dist,source,snapshot,store){
  const projects=clone(snapshot.projects),settings=clone(snapshot.settings),needed=new Set();
  for(const project of projects){if(usesFirstImage(project))project.coverAssetId=null;if(project.coverAssetId)needed.add(project.coverAssetId);project.blocks.forEach(block=>{if(block.assetId)needed.add(block.assetId);});}
  settings.homeBackground ||= defaultHomeBackground();homeBackgroundAssets(settings).forEach(id=>needed.add(id));
  const files=new Map();async function scan(dir){for(const entry of await readdir(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())await scan(file);else if(entry.isFile()&&!files.has(entry.name))files.set(entry.name,file);}}await scan(dist);
  const assets=[];
  for(const id of needed){const asset=store.asset(id),file=asset&&files.get(asset.file);if(!file)fail('发布媒体缺失，无法生成可恢复部署包。');const bytes=await readFile(file);if(digest(bytes)!==asset.hash)fail('发布媒体校验失败。');assets.push({id,name:asset.name,mime:asset.mime,size:bytes.length,hash:asset.hash,file:path.relative(dist,file).split(path.sep).join('/'),folderPath:folderPath(store,asset.folderId)});}
  if(settings.homeBackground.videos.some(item=>!item.assetId)){
    const file='assets/home/home-background.mp4',bytes=await readFile(path.join(dist,file)),id='builtin-home-video';assets.push({id,name:'默认首页背景.mp4',mime:'video/mp4',size:bytes.length,hash:digest(bytes),file,folderPath:[]});settings.homeBackground.videos.forEach(item=>{if(!item.assetId)item.assetId=id;});
  }
  const manifest={format:'pixix-portfolio-deployment',version:1,scope:'published-only',createdAt:now(),settings,projects,assets};
  const content=JSON.stringify(manifest,null,2);await mkdir(path.dirname(path.join(dist,restorePath)),{recursive:true});await mkdir(path.dirname(path.join(source,restorePath)),{recursive:true});await writeFile(path.join(dist,restorePath),content);await writeFile(path.join(source,restorePath),content);
}

export function inspectProjectPackage(bytes,store){
  const entries=readZip(bytes),locations=['','public/'].filter(prefix=>entries.has(prefix+restorePath));
  if(locations.length>1)fail('部署包包含多个恢复描述，无法确定作品数据。');
  const prefix=locations[0]||'',entry=entries.get(prefix+restorePath);
  if(!entry)fail('这个部署包没有可编辑数据，请用新版后台重新发布并下载部署包。');if(entry.length>10*1024*1024)fail('项目描述文件过大。');
  let manifest;try{manifest=JSON.parse(entry.read().toString('utf8'));}catch(error){if(error.status)throw error;fail('项目描述文件无法读取。');}
  if(manifest?.format!=='pixix-portfolio-deployment'||manifest.version!==1||manifest.scope!=='published-only'||!Array.isArray(manifest.projects)||manifest.projects.length>300||!Array.isArray(manifest.assets)||manifest.assets.length>5000)fail('不支持的项目数据格式或版本。');
  const assets=new Map();
  for(const item of manifest.assets){
    if(!item||!validId(item.id)||assets.has(item.id)||!cleanText(item.name,255)||!item.name.trim()||typeof item.file!=='string'||!Array.isArray(item.folderPath)||item.folderPath.length>20||item.folderPath.some(name=>!cleanText(name,100)||!name.trim()||/[\\/\x00-\x1f]/.test(name)||['.','..'].includes(name.trim())))fail('素材信息或文件夹路径不正确。');
    const file=entries.get(prefix+item.file);if(!file||file.length!==item.size||typeof item.hash!=='string'||!/^[a-f0-9]{64}$/.test(item.hash))fail('部署包中的素材缺失或大小不匹配。');
    const media=file.read();if(digest(media)!==item.hash)fail('素材校验失败，文件可能被改动。');const info=inspectMedia(media,item.name,item.mime);if(info.mime!==item.mime||media.length>(info.mime.startsWith('image/')?30:200)*1024*1024)fail('素材类型或大小不正确。');
    assets.set(item.id,{...item,...info,bytes:media});
  }
  const lookup={asset:id=>assets.get(id)},settings=validateSettings(manifest.settings,lookup),ids=new Set(),projects=[];
  for(const item of manifest.projects){if(!item||!validId(item.id)||ids.has(item.id))fail('作品编号重复或不正确。');ids.add(item.id);const project=validateProject(item,{id:item.id,folder:`import-${item.id}`,english:cleanText(item.english,120)?item.english:item.title},lookup);projects.push(project);}
  const referenced=new Set(homeBackgroundAssets(settings));projects.forEach(project=>{if(project.coverAssetId)referenced.add(project.coverAssetId);project.blocks.forEach(block=>{if(block.assetId)referenced.add(block.assetId);});});
  if(assets.size!==referenced.size||[...assets.keys()].some(id=>!referenced.has(id)))fail('部署包包含未被已发布内容使用的素材。');
  return {settings,projects,assets:[...assets.values()],summary:{projects:projects.length,assets:assets.size,conflicts:projects.filter(item=>store.project(item.id)).map(item=>({id:item.id,title:store.project(item.id).draft.title})),title:settings.title}};
}

export class ProjectImporter {
  constructor(store,publisher){this.store=store;this.publisher=publisher;this.pending=new Map();this.directory=path.join(store.directory,'imports');}
  baseline(projects){return digest({settings:this.store.get('settingsDraft'),revision:this.store.get('settingsRevision'),projects:projects.map(item=>{const row=this.store.project(item.id);return row?{id:row.id,revision:row.revision,draft:row.draft,deletedAt:row.deletedAt}:null;})});}
  async inspect(bytes){
    if(this.publisher.busy)fail('正在预览、发布或导入，请稍后重试。',409);
    await this.expire();if(this.pending.size>=3)fail('请先完成或取消已有的导入。',429);
    const result=inspectProjectPackage(bytes,this.store),token=randomUUID(),baseline=this.baseline(result.projects);await mkdir(this.directory,{recursive:true});await writeFile(path.join(this.directory,token+'.zip'),bytes,{flag:'wx'});this.pending.set(token,{expires:Date.now()+3600000,baseline});return{token,...result.summary};
  }
  async expire(){await mkdir(this.directory,{recursive:true});for(const entry of await readdir(this.directory)){if(!/^[a-f0-9-]{36}\.zip$/.test(entry))continue;const file=path.join(this.directory,entry);if((await stat(file)).mtimeMs<Date.now()-3600000){await unlink(file);this.pending.delete(entry.slice(0,-4));}}}
  async discard(token){if(!this.pending.has(token))return;this.pending.delete(token);await unlink(path.join(this.directory,token+'.zip')).catch(error=>{if(error.code!=='ENOENT')throw error;});}
  async commit(input){
    if(this.publisher.busy)fail('正在预览、发布或导入，请稍后重试。',409);if(!this.pending.has(input?.token)||this.pending.get(input.token).expires<Date.now())fail('导入预览已失效，请重新选择部署包。',410);
    this.publisher.busy=true;const written=[],used=new Set();let committed=false;
    try{
      const data=inspectProjectPackage(await readFile(path.join(this.directory,input.token+'.zip')),this.store),mapping=new Map();
      for(const asset of data.assets){asset.localId=randomUUID();asset.localFile=asset.localId+'.'+asset.extension;const file=path.join(this.store.directory,'uploads',asset.localFile);await writeFile(file,asset.bytes,{flag:'wx'});written.push(file);}
      this.store.transaction(()=>{
        if(this.baseline(data.projects)!==this.pending.get(input.token)?.baseline)fail('导入预览后作品或设置已发生变化，请重新选择部署包并确认。',409);
        for(const asset of data.assets){let folder=null;for(const name of asset.folderPath)folder=createFolder(this.store,name,folder?.id||null,true);
          const existing=this.store.db.prepare('SELECT id FROM media WHERE hash=? AND folderId IS ?').get(asset.hash,folder?.id||null);
          if(existing){mapping.set(asset.id,existing.id);this.store.registerAsset(existing.id,null);continue;}
          const order=this.store.db.prepare('SELECT COALESCE(MIN(sortOrder),0)-1 AS n FROM media WHERE folderId IS ?').get(folder?.id||null).n;
          this.store.db.prepare('INSERT INTO media(id,name,file,mime,size,width,height,hash,createdAt,library,folderId,sortOrder) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(asset.localId,asset.name,asset.localFile,asset.mime,asset.size,asset.width,asset.height,asset.hash,now(),1,folder?.id||null,order);mapping.set(asset.id,asset.localId);used.add(path.join(this.store.directory,'uploads',asset.localFile));
        }
        for(const project of data.projects){const current=this.store.project(project.id);project.coverAssetId=mapping.get(project.coverAssetId)||null;project.blocks.forEach(block=>{if(block.assetId)block.assetId=mapping.get(block.assetId);});const document=validateProject(project,current||{id:project.id,folder:project.folder,english:project.english},this.store);
          this.store.db.prepare('INSERT INTO projects(id,draft,updatedAt) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET draft=excluded.draft,revision=projects.revision+1,deletedAt=NULL,updatedAt=excluded.updatedAt').run(project.id,JSON.stringify(document),now());
        }
        includeMainProjects(this.store,data.projects);this.store.set('spacesRevision',(this.store.get('spacesRevision')||1)+1);
        const settings=data.settings;settings.homeBackground.videos.forEach(item=>{if(item.assetId)item.assetId=mapping.get(item.assetId);});if(settings.homeBackground.finalFrameAssetId)settings.homeBackground.finalFrameAssetId=mapping.get(settings.homeBackground.finalFrameAssetId);
        settings.categories=[...new Set([...(this.store.get('settingsDraft')?.categories||[]),...settings.categories,...data.projects.flatMap(item=>item.labels)])];
        this.store.set('settingsDraft',validateSettings(settings,this.store));this.store.set('settingsRevision',(this.store.get('settingsRevision')||0)+1);
      });committed=true;await this.discard(input.token).catch(()=>{});return {ok:true,projectIds:data.projects.map(item=>item.id),assets:data.assets.length};
    }finally{for(const file of written)if(!committed||!used.has(file))await unlink(file).catch(()=>{});this.publisher.busy=false;}
  }
}
