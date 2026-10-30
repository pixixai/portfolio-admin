import {createReadStream,createWriteStream} from 'node:fs';
import {mkdir,readFile,stat,open,link,copyFile} from 'node:fs/promises';
import {pipeline} from 'node:stream/promises';
import {Transform,Writable} from 'node:stream';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {ZipArchive} from 'archiver';
import unzipper from 'unzipper';
import {validateProject,validateSettings,fail} from './validation.mjs';
import {inspectMedia} from './media.mjs';
import {homeBackgroundAssets} from './home-background.mjs';
import {releaseRetention,validateRetention} from './release-retention.mjs';
import {deploymentTarget} from './deployment.mjs';
import {remoteProfile} from './remote-sync.mjs';
import {spacesDraft,spacesLive,validateSpaces,validateMainSpace} from './spaces.mjs';
import {validSpaceCodeKey,decryptSpaceCode} from './space-secrets.mjs';

export const backupSections=[{id:'settings',label:'网站设置',description:'首页背景、个人信息、联系方式、页脚，以及已保存和已发布的设置。'},{id:'projects',label:'作品',description:'所有作品的草稿、发布状态、标签、排序、封面取景和回收站。'},{id:'media',label:'素材库',description:'原始素材、未使用素材、文件夹和素材排序。'},{id:'history',label:'发布历史',description:'仍保留的历史版本；同时需要作品和网站设置。'},{id:'preferences',label:'后台偏好',description:'历史保留数量、导出平台及不含密码的服务器连接信息。'}];
const keys=new Set(backupSections.map(item=>item.id)),clone=value=>structuredClone(value),validId=value=>typeof value==='string'&&/^[\w-]{1,100}$/.test(value);
const extensions='png|jpg|jpeg|webp|gif|mp4|webm|mp3|wav|ogg|m4a';
export const backupByteLimit=50*1024**3;
export function selectedSections(input,available=[...keys]){
  if(!Array.isArray(input)||!input.length||input.some(id=>!keys.has(id)||!available.includes(id)))fail('请选择备份包中有效的数据类别。');
  const result=[...new Set(input)];if(result.includes('history'))for(const id of ['settings','projects'])if(!result.includes(id)){if(!available.includes(id))fail('发布历史缺少关联作品或设置。');result.push(id);}return result;
}
export function documentAssets(document){return[document?.coverAssetId,...(document?.blocks||[]).map(block=>block.assetId)].filter(Boolean);}
export async function hashFile(file){const hash=createHash('sha256');for await(const block of createReadStream(file))hash.update(block);return hash.digest('hex');}
export async function linkFile(source,target){await mkdir(path.dirname(target),{recursive:true});try{await link(source,target);}catch(error){if(!['EXDEV','EPERM','ENOTSUP'].includes(error.code))throw error;await copyFile(source,target);}}

export async function backupSnapshot(store,renderer,sections){
  sections=selectedSections(sections);const has=id=>sections.includes(id),projects=has('projects')?clone(store.projects()):[],settings=has('settings')?{draft:clone(store.get('settingsDraft')),live:clone(store.get('settingsLive'))}:null;
  const releases=has('history')?clone(store.releases()):[],needed=new Set(),all=store.media();
  projects.forEach(row=>[row.draft,row.live].forEach(doc=>documentAssets(doc).forEach(id=>needed.add(id))));
  const settingsDocs=settings?[settings.draft,settings.live]:[];
  for(const release of releases){settingsDocs.push(release.snapshot.settings);release.snapshot.projects.forEach(doc=>documentAssets(doc).forEach(id=>needed.add(id)));}
  settingsDocs.forEach(value=>homeBackgroundAssets(value).forEach(id=>needed.add(id)));
  if(has('projects'))for(const asset of all)if(asset.pendingProjects.some(id=>projects.some(row=>row.id===id)))needed.add(asset.id);
  const assets=all.filter(asset=>has('media')||needed.has(asset.id)).map(asset=>({...asset,source:path.join(store.directory,'uploads',asset.file)}));
  if(settingsDocs.some(value=>value?.homeBackground?.videos?.some(item=>!item.assetId))){
    const id=randomUUID(),source=path.join(renderer,'assets/home/home-background.mp4'),size=(await stat(source)).size;
    assets.push({id,name:'默认首页背景.mp4',file:id+'.mp4',mime:'video/mp4',size,width:0,height:0,hash:await hashFile(source),createdAt:new Date().toISOString(),library:1,folderId:null,sortOrder:0,pendingProjects:[],source});
    settingsDocs.forEach(value=>value?.homeBackground?.videos?.forEach(item=>{if(!item.assetId)item.assetId=id;}));
  }
  const folders=store.db.prepare('SELECT * FROM media_folders').all(),folderIds=new Set(has('media')?folders.map(row=>row.id):assets.map(asset=>asset.folderId).filter(Boolean));
  for(const id of [...folderIds]){let item=folders.find(row=>row.id===id),depth=0;while(item?.parentId){if(++depth>20)fail('素材文件夹层级异常。');folderIds.add(item.parentId);item=folders.find(row=>row.id===item.parentId);}}
  const preferences=has('preferences')?{releaseRetention:releaseRetention(store),deploymentTarget:deploymentTarget(store.get('deploymentTarget')||{}),remoteDeployment:store.get('remoteDeployment')||null}:null;
  if(preferences?.remoteDeployment)preferences.remoteDeployment=remoteProfile(preferences.remoteDeployment);
  return{format:'pixix-portfolio-user-backup',version:1,createdAt:new Date().toISOString(),sections,settings,projects,...(has('projects')?{spaces:{draft:clone(spacesDraft(store)),live:clone(spacesLive(store)),mainDraft:clone(store.get('mainSpaceDraft')),mainLive:clone(store.get('mainSpaceLive')),siteUrl:store.get('spacesSiteUrl')||'',displayKey:store.get('spaceCodeKey')||null}}:{}),folders:folders.filter(row=>folderIds.has(row.id)),assets,releases,currentRelease:has('history')?store.get('currentRelease'):null,preferences};
}
export async function streamBackup(snapshot,response){
  const archive=new ZipArchive({store:true});
  archive.on('warning',error=>archive.destroy(error));
  const manifest={...snapshot,assets:snapshot.assets.map(({source,...asset})=>asset)};
  const done=pipeline(archive,response);
  archive.append(JSON.stringify(manifest),{name:'user-data.json'});
  for(const asset of snapshot.assets)archive.file(asset.source,{name:'media/'+asset.file});
  await Promise.all([archive.finalize(),done]);
}
function archivePath(value){
  if(typeof value!=='string'||value.length>600||value.startsWith('/')||/[\\:\x00-\x1f]/.test(value)||value.split('/').some(part=>part==='.'||part==='..'))fail('备份包包含不安全的文件路径。');return value.replace(/\/$/,'');
}
export async function receiveBackup(request,directory){
  if(Number(request.headers?.['content-length']||0)>backupByteLimit)fail('备份文件超过50 GB限制。',413);
  await mkdir(directory,{recursive:true});const files=new Map();let compressed=0,total=0;
  const limit=new Transform({transform(chunk,encoding,callback){compressed+=chunk.length;callback(compressed>backupByteLimit?Object.assign(new Error('备份文件超过50 GB限制。'),{status:413}):null,chunk);}});
  const parser=unzipper.Parse({forceStream:true}),abort=error=>parser.destroy(error);
  request.on('error',abort);request.once('aborted',()=>abort(new Error('上传已中断。')));limit.on('error',abort);request.pipe(limit).pipe(parser);
  try{
    let count=0;
    for await(const entry of parser){
      const name=archivePath(entry.path);if(++count>50000||files.has(name))fail('备份包文件过多或存在重复路径。');
      const capture=entry.type==='File'&&(name==='user-data.json'||/^(?:public\/)?assets\/home\/portfolio-restore\.json$/.test(name)||new RegExp(`\\.(${extensions})$`,'i').test(name));
      const file=path.join(directory,randomUUID()),max=name==='user-data.json'||name.endsWith('portfolio-restore.json')?20*1024**2:200*1024**2;let size=0;
      const counter=new Transform({transform(chunk,encoding,callback){size+=chunk.length;total+=chunk.length;callback(size>max||total>backupByteLimit?Object.assign(new Error('备份包展开后超过大小限制。'),{status:413}):null,chunk);}});
      await pipeline(entry,counter,capture?createWriteStream(file,{flags:'wx'}):new Writable({write(chunk,encoding,callback){callback();}}));
      files.set(name,{file:capture?file:null,size});
    }
    if(!compressed||!files.size)fail('无法读取备份ZIP。');
    const own=files.get('user-data.json');
    if(own){const data=JSON.parse(await readFile(own.file,'utf8'));return await validateBackup(data,files);}
    const legacy=files.get('assets/home/portfolio-restore.json')||files.get('public/assets/home/portfolio-restore.json');
    if(!legacy)fail('请选择“备份数据”导出的ZIP，或新版网站部署包。');
    const prefix=files.has('public/assets/home/portfolio-restore.json')?'public/':'';
    return await validateBackup(legacyBackup(JSON.parse(await readFile(legacy.file,'utf8')),prefix),files,true);
  }catch(error){request.unpipe(limit);request.resume();limit.unpipe(parser);limit.destroy();parser.destroy();if(!error.status)error.status=400;throw error;}finally{request.removeListener('error',abort);}
}
function legacyBackup(value,prefix){
  if(value?.format!=='pixix-portfolio-deployment'||value.version!==1||value.scope!=='published-only'||!Array.isArray(value.projects)||!Array.isArray(value.assets))fail('不支持此部署包的数据格式。');
  const folders=[],byPath=new Map();
  const assets=value.assets.map(asset=>{
    let parentId=null;const parts=[];for(const name of asset.folderPath||[]){parts.push(name);const key=parts.join('/');let folder=byPath.get(key);if(!folder){folder={id:randomUUID(),name,parentId,createdAt:value.createdAt,sortOrder:folders.length};folders.push(folder);byPath.set(key,folder);}parentId=folder.id;}
    return{...asset,archiveFile:prefix+asset.file,file:randomUUID()+path.extname(asset.file),createdAt:value.createdAt,library:1,folderId:parentId,sortOrder:0,pendingProjects:[]};
  });
  return{format:'pixix-portfolio-user-backup',version:1,createdAt:value.createdAt,sections:['settings','projects','media'],settings:{draft:value.settings,live:value.settings},projects:value.projects.map(document=>({id:document.id,draft:document,live:null,revision:1,deletedAt:null,updatedAt:value.createdAt})),assets,folders,releases:[],preferences:null,currentRelease:null};
}
export async function validateBackup(data,files,legacy=false){
  if(data?.format!=='pixix-portfolio-user-backup'||data.version!==1)fail('不支持此用户备份格式或版本。');
  const sections=selectedSections(data.sections);if(sections.length!==data.sections.length)fail('备份包缺少关联数据类别。');
  if(sections.includes('projects')&&!legacy){data.spaces={draft:validateSpaces(data.spaces?.draft||[],(data.projects||[]).map(row=>row.draft)),live:validateSpaces(data.spaces?.live||[],(data.projects||[]).map(row=>row.live).filter(Boolean)),mainDraft:data.spaces?.mainDraft?validateMainSpace(data.spaces.mainDraft,(data.projects||[]).map(row=>row.draft)):null,mainLive:data.spaces?.mainLive?validateMainSpace(data.spaces.mainLive,(data.projects||[]).map(row=>row.live).filter(Boolean)):null,siteUrl:data.spaces?.siteUrl||'',displayKey:data.spaces?.displayKey||null};if(data.spaces.displayKey!=null&&!validSpaceCodeKey(data.spaces.displayKey))fail('访问码显示密钥格式不正确。');for(const space of [...data.spaces.draft,...data.spaces.live])if(space.displayCode&&decryptSpaceCode(space,data.spaces.displayKey)==null)fail('备份中的访问码显示数据无法解密。');if(typeof data.spaces.siteUrl!=='string'||data.spaces.siteUrl.length>500)fail('分享空间网站地址不正确。');if(data.spaces.siteUrl){const url=new URL(data.spaces.siteUrl);if(!['https:','http:'].includes(url.protocol)||url.origin!==data.spaces.siteUrl)fail('分享空间网站地址不正确。');}}
  if(!Array.isArray(data.assets)||data.assets.length>30000||!Array.isArray(data.folders)||data.folders.length>10000||!Array.isArray(data.projects)||data.projects.length>5000||!Array.isArray(data.releases)||data.releases.length>100)fail('备份包的数据数量或格式不正确。');
  const assetMap=new Map(),folderMap=new Map();
  for(const folder of data.folders){if(!validId(folder.id)||folderMap.has(folder.id)||typeof folder.name!=='string'||!folder.name.trim()||folder.name.length>100||/[\\/\x00-\x1f]/.test(folder.name)||['.','..'].includes(folder.name)||!Number.isFinite(folder.sortOrder))fail('备份文件夹数据不正确。');folderMap.set(folder.id,folder);}
  for(const folder of data.folders){let cursor=folder,seen=new Set();while(cursor){if(seen.has(cursor.id)||seen.size>=20)fail('备份文件夹存在循环或层级过深。');seen.add(cursor.id);if(cursor.parentId&&!folderMap.has(cursor.parentId))fail('备份文件夹的上级缺失。');cursor=folderMap.get(cursor.parentId);}}
  for(const asset of data.assets){
    if(!validId(asset.id)||assetMap.has(asset.id)||typeof asset.name!=='string'||!asset.name.trim()||asset.name.length>255||!new RegExp(`^[a-f\\d-]{36}\\.(${extensions})$`,'i').test(asset.file)||!/^[a-f\d]{64}$/.test(asset.hash)||asset.folderId&&!folderMap.has(asset.folderId)||![0,1].includes(asset.library)||!Number.isFinite(asset.sortOrder))fail('备份素材信息不正确。');
    const entry=files.get(asset.archiveFile||'media/'+asset.file);if(!entry?.file||entry.size!==asset.size||await hashFile(entry.file)!==asset.hash)fail('备份素材缺失、大小不匹配或校验失败。');
    let bytes;if(asset.mime?.startsWith('image/'))bytes=await readFile(entry.file);else{const file=await open(entry.file);try{bytes=Buffer.alloc(Math.min(4096,asset.size));await file.read(bytes,0,bytes.length,0);}finally{await file.close();}}
    const info=inspectMedia(bytes,asset.name,asset.mime);if(legacy){asset.width=info.width;asset.height=info.height;}if(info.mime!==asset.mime||asset.size>(info.mime.startsWith('image/')?30:200)*1024**2||info.width!==asset.width||info.height!==asset.height)fail('备份素材类型、尺寸或大小不正确。');
    asset.source=entry.file;assetMap.set(asset.id,asset);
  }
  const lookup={asset:id=>assetMap.get(id)},checkDocument=document=>{
    if(!document||typeof document.id!=='string'||!/^[a-z][a-z\d-]*$/.test(document.id)||typeof document.folder!=='string'||!document.folder.trim()||document.folder.length>180||/[<>:"/\\|?*\x00-\x1f]/.test(document.folder)||['.','..'].includes(document.folder)||document.english!=null&&(typeof document.english!=='string'||document.english.length>120))fail('备份作品编号或目录不正确。');
    return validateProject(document,document,lookup);
  };
  const ids=new Set(),paths=new Set();for(const row of data.projects){if(ids.has(row.id)||paths.has(row.draft?.folder?.toLowerCase())||row.draft?.id!==row.id||!Number.isInteger(row.revision)||row.revision<1)fail('备份作品存在重复或版本数据不正确。');ids.add(row.id);row.draft=checkDocument(row.draft);paths.add(row.draft.folder.toLowerCase());if(row.live){if(row.live.id!==row.id||row.live.folder!==row.draft.folder)fail('作品发布数据不匹配。');row.live=checkDocument(row.live);}if(row.deletedAt&&row.live)fail('回收站作品不能同时发布。');}
  if(sections.includes('settings')){data.settings={draft:validateSettings(data.settings?.draft,lookup),live:validateSettings(data.settings?.live,lookup)};}else if(data.settings)fail('备份数据类别与设置内容不匹配。');
  const releaseIds=new Set();for(const release of data.releases){if(!validId(release.id)||releaseIds.has(release.id)||typeof release.title!=='string'||release.title.length>300||!Array.isArray(release.snapshot?.projects)||release.snapshot.projects.length>5000)fail('发布历史数据不正确。');releaseIds.add(release.id);const seen=new Set(),directories=new Set();release.snapshot.projects=release.snapshot.projects.map(document=>{const result=checkDocument(document);if(seen.has(result.id)||directories.has(result.folder.toLowerCase()))fail('历史作品编号或目录重复。');seen.add(result.id);directories.add(result.folder.toLowerCase());return result;});release.snapshot.settings=validateSettings(release.snapshot.settings,lookup);if(release.snapshot.deployment)release.snapshot.deployment=deploymentTarget(release.snapshot.deployment);}
  for(const release of data.releases){release.snapshot.spaces=validateSpaces(release.snapshot.spaces||[],release.snapshot.projects);if(release.snapshot.mainSpace)release.snapshot.mainSpace=validateMainSpace(release.snapshot.mainSpace,release.snapshot.projects);}
  if(sections.includes('history')&&!releaseIds.has(data.currentRelease))fail('备份中的当前发布版本缺失。');
  if(sections.includes('preferences')){validateRetention(data.preferences?.releaseRetention);data.preferences.deploymentTarget=deploymentTarget(data.preferences.deploymentTarget);if(data.preferences.remoteDeployment)data.preferences.remoteDeployment=remoteProfile(data.preferences.remoteDeployment);}
  if(!sections.includes('projects')&&data.projects.length||!sections.includes('history')&&data.releases.length)fail('备份数据类别与内容不匹配。');
  return{...data,legacy,sections,assets:[...assetMap.values()],counts:{projects:data.projects.length,media:data.assets.length,folders:data.folders.length,history:data.releases.length}};
}
