import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,access,mkdir,writeFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import {Window} from 'happy-dom';
import {createApplication,root} from '../server.mjs';
import {createFolder} from '../lib/media-folders.mjs';
import {readZip,zipEntries} from '../lib/zip.mjs';
import {restoreJournalPath,activateUserData} from '../lib/restore-activation.mjs';
import {resolveRuntimeData} from '../lib/runtime-data.mjs';
import {randomUUID} from 'node:crypto';

const all=['settings','projects','media','history','preferences'],png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HA4CAAAAC0lEQVR42mP8/x8AAusB9Wl6XFAAAAAASUVORK5CYII=','base64');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){for(const end=Date.now()+30000;Date.now()<end;){if(check())return;await pause(15);}throw new Error('等待备份任务超时');}
async function fixture(t){
  const directory=await mkdtemp(path.join(os.tmpdir(),'pixix-user-backup-')),app=await createApplication({dataDir:path.join(directory,'user')});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(()=>app.close());const base=`http://127.0.0.1:${app.server.address().port}`;
  async function api(url,method='GET',data,status=200,raw=false){const response=await fetch(base+url,{method,headers:data===undefined?{}:{'Content-Type':raw?'application/zip':'application/json'},body:data===undefined?undefined:raw?data:JSON.stringify(data)});const value=await response.json();assert.equal(response.status,status,JSON.stringify(value));return value;}
  async function job(value){await until(()=>app.backups.jobs.get(value.id)?.status!=='running');const result=app.backups.jobs.get(value.id);assert.equal(result.status,'done',result.message);return result.result;}
  async function backup(sections=all){const result=await job(await api('/api/backups/create','POST',{sections},202));const response=await fetch(base+result.downloadUrl);assert.equal(response.status,200);return Buffer.from(await response.arrayBuffer());}
  async function restore(bytes,sections=all){const inspected=await api('/api/backups/inspect','POST',bytes,200,true),result=await job(await api('/api/backups/restore','POST',{token:inspected.token,sections},202));return{inspected,result};}
  return{app,directory,base,api,job,backup,restore};
}
async function customData(f){
  const draft=await f.api('/api/projects','POST',{title:'未公开的草稿',labels:['私有测试'],blocks:[{id:'paragraph',type:'text',text:'未公开正文 **保留格式**'}]},201);
  const discarded=await f.api('/api/projects','POST',{title:'回收站作品',blocks:[]},201);await f.api('/api/projects/'+discarded.id+'/trash','POST',{});
  const folder=createFolder(f.app.store,'素材分组',null),empty=createFolder(f.app.store,'空文件夹',folder.id);
  const asset=await f.app.store.addAsset(png,'未使用原图.png','image/png',{width:1,height:1},'png',null,folder.id);
  const state=await f.api('/api/state');await f.api('/api/settings','PUT',{...state.settings,revision:state.settingsRevision,owner:'备份中的姓名',homeBackground:{...state.settings.homeBackground,shadeColor:'#214d3d'}});
  f.app.store.set('releaseRetention',5);f.app.store.set('remoteDeployment',{host:'example.com',port:22,username:'root',directory:'/www/wwwroot/site',fingerprint:'SHA256:'+'a'.repeat(43),password:'MUST-NOT-BE-EXPORTED'});
  return{draft,discarded,folder,empty,asset};
}

test('完整用户备份包含草稿、回收站、空文件夹、未使用素材和历史，不包含服务器密码或程序文件',async t=>{
  const source=await fixture(t),data=await customData(source),bytes=await source.backup(),entries=readZip(bytes),manifest=JSON.parse(entries.get('user-data.json').read());
  assert.deepEqual(manifest.sections,all);assert.equal(manifest.settings.draft.owner,'备份中的姓名');assert.equal(manifest.settings.live.owner,'噼哩画啦');assert.ok(manifest.projects.some(row=>row.id===data.draft.id&&!row.live));assert.ok(manifest.projects.some(row=>row.id===data.discarded.id&&row.deletedAt));
  assert.ok(manifest.folders.some(folder=>folder.id===data.empty.id));assert.ok(manifest.assets.some(asset=>asset.id===data.asset.id));assert.equal(manifest.releases.length,source.app.store.releases().length);assert.equal(JSON.stringify(manifest).includes('MUST-NOT-BE-EXPORTED'),false);assert.equal(manifest.preferences.remoteDeployment.password,undefined);
  assert.ok([...entries.keys()].every(name=>name==='user-data.json'||name.startsWith('media/')));assert.ok(!entries.has('portfolio.sqlite')&&!entries.has('server.mjs'));
  const target=await fixture(t),extra=await target.api('/api/projects','POST',{title:'恢复前的数据',blocks:[]},201),result=await target.restore(bytes);
  assert.equal(target.app.store.project(extra.id),undefined);assert.equal(target.app.store.project(data.draft.id).draft.blocks[0].text,'未公开正文 **保留格式**');assert.ok(target.app.store.project(data.discarded.id).deletedAt);assert.equal(target.app.store.get('settingsDraft').owner,'备份中的姓名');assert.equal(target.app.store.get('settingsLive').owner,'噼哩画啦');assert.equal(target.app.store.get('releaseRetention'),5);
  assert.ok(target.app.store.db.prepare('SELECT * FROM media_folders WHERE name=?').get('空文件夹'));assert.ok(target.app.store.media().some(asset=>asset.name==='未使用原图.png'));assert.equal(target.app.store.releases().length,manifest.releases.length);
  const html=await(await fetch(target.base+'/site/')).text();assert.ok(html.includes('噼哩画啦'));assert.equal((await fetch(target.base+'/user/portfolio.sqlite')).status,404);
  await access(path.join(result.result.safetyBackup,'portfolio.sqlite'));const old=new DatabaseSync(path.join(result.result.safetyBackup,'portfolio.sqlite'),{readOnly:true});try{assert.ok(old.prepare('SELECT id FROM projects WHERE id=?').get(extra.id));}finally{old.close();}
  const second=await target.backup();assert.ok(readZip(second).has('user-data.json'),'恢复后可再次备份');
});

test('部分备份自动携带依赖素材；仅恢复设置不替换作品，未选素材不导入未使用原件',async t=>{
  const source=await fixture(t),data=await customData(source),bytes=await source.backup(['settings']),manifest=JSON.parse(readZip(bytes).get('user-data.json').read());assert.deepEqual(manifest.sections,['settings']);assert.equal(manifest.projects.length,0);assert.ok(manifest.assets.length);assert.equal(manifest.assets.some(asset=>asset.id===data.asset.id),false);
  const target=await fixture(t),before=JSON.stringify(target.app.store.projects());await target.restore(bytes,['settings']);assert.equal(JSON.stringify(target.app.store.projects()),before);assert.equal(target.app.store.get('settingsDraft').owner,'备份中的姓名');assert.equal(target.app.store.media().some(asset=>asset.name==='未使用原图.png'),false);
  const settingsBefore=JSON.stringify(target.app.store.get('settingsDraft')),works=await source.backup(['projects']);await target.restore(works,['projects']);assert.ok(target.app.store.project(data.draft.id));assert.equal(JSON.stringify(target.app.store.get('settingsDraft')),settingsBefore);
  await target.api('/api/backups/create','POST',{sections:[]},400);await target.api('/api/backups/create','POST',{sections:['unknown']},400);
});

test('只恢复素材库或后台偏好时保留作品、网站设置和当前发布；其他类别引用的素材不删除',async t=>{
  const source=await fixture(t),data=await customData(source),bytes=await source.backup();
  for(const section of ['media','preferences']){
    const target=await fixture(t),before={projects:JSON.stringify(target.app.store.projects()),settings:JSON.stringify(target.app.store.get('settingsDraft')),current:target.app.store.get('currentRelease'),assets:target.app.store.media().map(asset=>asset.id)};
    await target.restore(bytes,[section]);assert.equal(JSON.stringify(target.app.store.projects()),before.projects);assert.equal(JSON.stringify(target.app.store.get('settingsDraft')),before.settings);assert.equal(target.app.store.get('currentRelease'),before.current);
    if(section==='media'){assert.ok(target.app.store.media().some(asset=>asset.name==='未使用原图.png'));before.assets.forEach(id=>assert.ok(target.app.store.asset(id),'保留现有作品引用的素材'));}else{assert.equal(target.app.store.get('releaseRetention'),5);assert.equal(target.app.store.get('remoteDeployment').host,'example.com');assert.equal(target.app.store.asset(data.asset.id),undefined);}
  }
});

test('恢复拒绝损坏、越界路径、缺失素材、循环目录及检查后的数据变化，原数据保持不变',async t=>{
  const f=await fixture(t),bytes=await f.backup(),entries=readZip(bytes),original=JSON.parse(entries.get('user-data.json').read()),baseline=JSON.stringify(f.app.store.projects());
  const modified=change=>{const data=structuredClone(original);change(data);return zipEntries([...entries].map(([name,entry])=>({name,bytes:name==='user-data.json'?Buffer.from(JSON.stringify(data)):entry.read()})));};
  for(const change of [data=>data.version=99,data=>data.assets[0].hash='0'.repeat(64),data=>data.assets[0].file='../outside',data=>data.projects[0].draft.blocks[0].type='script',data=>{data.folders=[{id:'cycle',name:'循环',parentId:'cycle',sortOrder:0}];}])await f.api('/api/backups/inspect','POST',modified(change),400,true);
  const unsafe=zipEntries([{name:'safe-file.txt',bytes:Buffer.from('bad')}]);for(let offset=unsafe.indexOf('safe-file.txt');offset>=0;offset=unsafe.indexOf('safe-file.txt',offset+1))Buffer.from('../escape.txt').copy(unsafe,offset);
  await f.api('/api/backups/inspect','POST',unsafe,400,true);await f.api('/api/backups/inspect','POST',Buffer.from('not a zip'),400,true);assert.equal(JSON.stringify(f.app.store.projects()),baseline);
  const inspected=await f.api('/api/backups/inspect','POST',bytes,200,true);await f.api('/api/projects','POST',{title:'检查后新增',blocks:[]},201);await f.api('/api/backups/restore','POST',{token:inspected.token,sections:all},409);
});

test('恢复构建失败不启用新数据，恢复过程中拒绝写入，完成后服务可继续编辑',async t=>{
  const f=await fixture(t),bytes=await f.backup(),inspected=await f.api('/api/backups/inspect','POST',bytes,200,true),before=JSON.stringify(f.app.store.projects()),activate=f.app.backups.activate;
  f.app.backups.activate=async()=>{throw new Error('模拟切换失败');};const failed=await f.api('/api/backups/restore','POST',{token:inspected.token,sections:all},202);await until(()=>f.app.backups.jobs.get(failed.id).status!=='running');assert.equal(f.app.backups.jobs.get(failed.id).status,'failed');assert.equal(JSON.stringify(f.app.store.projects()),before);assert.equal((await fetch(f.base+'/site/')).status,200);
  let release;f.app.backups.activate=async stage=>{await new Promise(resolve=>release=resolve);return activate(stage);};const next=await f.api('/api/backups/restore','POST',{token:inspected.token,sections:all},202);await until(()=>release);
  const blocked=await fetch(f.base+'/api/projects',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'不应写入',blocks:[]})});assert.ok([409,503].includes(blocked.status));release();await f.job(next);await f.api('/api/projects','POST',{title:'恢复后继续编辑',blocks:[]},201);
});

test('恢复入口兼容旧部署包，只恢复选定草稿且保留当前发布与其他作品',async t=>{
  const source=await fixture(t),state=await source.api('/api/state'),id=state.projects[0].id,row=state.projects[0];await source.api('/api/projects/'+id,'PUT',{...row.draft,title:'部署包中的作品',revision:row.revision});
  const publish=await source.api('/api/publish','POST',{projectIds:[id],includeSettings:true},202);await until(()=>source.app.publisher.jobs.get(publish.id).status!=='running');
  const bytes=Buffer.from(await(await fetch(source.base+'/api/export/'+publish.id)).arrayBuffer()),target=await fixture(t),extra=await target.api('/api/projects','POST',{title:'保留的草稿',blocks:[]},201),current=target.app.store.get('currentRelease'),live=structuredClone(target.app.store.project(id).live);
  const result=await target.restore(bytes,['projects']);assert.equal(result.inspected.legacy,true);assert.equal(target.app.store.project(id).draft.title,'部署包中的作品');assert.deepEqual(target.app.store.project(id).live,live);assert.ok(target.app.store.project(extra.id));assert.equal(target.app.store.get('currentRelease'),current);
});

test('部署包的内置背景编号转换为有效素材编号，恢复后管理页面可读取原视频',async t=>{
  const source=await fixture(t),target=await fixture(t),bytes=Buffer.from(await(await fetch(source.base+'/api/export/'+source.app.store.get('currentRelease'))).arrayBuffer());
  await target.restore(bytes,['settings','projects','media']);const id=target.app.store.get('settingsDraft').homeBackground.videos[0].assetId;assert.match(id,/^[a-f\d-]{36}$/i);
  const asset=target.app.store.asset(id),response=await fetch(target.base+'/api/media/'+id+'/file',{headers:{Range:'bytes=0-31'}});assert.equal(response.status,206);assert.equal(asset.name,'默认首页背景.mp4');assert.equal((await response.arrayBuffer()).byteLength,32);
});

test('恢复切换中断时启动先回退原数据，已提交则保留新数据，不误初始化旧默认版本',async()=>{
  for(const phase of ['before','between','after','committed']){
    const base=await mkdtemp(path.join(os.tmpdir(),'pixix-backup-crash-')),directory=path.join(base,'user'),stage=path.join(base,'.portfolio-user-restore-'+randomUUID()),previous=path.join(base,'.portfolio-user-before-restore-'+Date.now()+'-'+randomUUID().slice(0,8));
    const marker=async(folder,value)=>{await mkdir(folder);await writeFile(path.join(folder,'portfolio.sqlite'),value);};
    if(phase==='before'){await marker(directory,'old');await marker(stage,'new');}else if(phase==='between'){await marker(previous,'old');await marker(stage,'new');}else{await marker(directory,'new');await marker(previous,'old');}
    await writeFile(restoreJournalPath(directory),JSON.stringify({format:'portfolio-user-switch',directory,stage,previous,phase:phase==='committed'?'committed':'prepared'}));
    assert.equal(await resolveRuntimeData(base,{env:{},legacyDirectory:path.join(base,'unused')}),directory);assert.equal(await readFile(path.join(directory,'portfolio.sqlite'),'utf8'),phase==='committed'?'new':'old');await assert.rejects(access(restoreJournalPath(directory)),{code:'ENOENT'});
  }
});

test('实际切换失败会恢复原目录和服务，未完成阶段不删除原始数据',async()=>{
  for(const failure of ['rename','reopen']){
    const base=await mkdtemp(path.join(os.tmpdir(),'pixix-backup-activation-')),directory=path.join(base,'user'),stage=path.join(base,'.portfolio-user-restore-'+randomUUID());await mkdir(directory);await writeFile(path.join(directory,'portfolio.sqlite'),'original');
    if(failure==='reopen'){await mkdir(stage);await writeFile(path.join(stage,'portfolio.sqlite'),'restored');}
    let opened=0;await assert.rejects(activateUserData(directory,stage,{close(){},async reopen(){opened++;if(failure==='reopen'&&opened===1)throw new Error('模拟重开失败');}}));
    assert.equal(await readFile(path.join(directory,'portfolio.sqlite'),'utf8'),'original');assert.ok(opened>=1);await assert.rejects(access(restoreJournalPath(directory)),{code:'ENOENT'});
  }
});

test('右上角为备份数据、恢复数据、发布；备份与恢复可选择类别并自动处理历史依赖',async t=>{
  const f=await fixture(t),w=new Window({url:f.base,settings:{disableCSSFileLoading:true,disableJavaScriptFileLoading:true,disableIframePageLoading:true}});t.after(()=>w.happyDOM.abort());let downloaded='';
  w.HTMLAnchorElement.prototype.click=function(){downloaded=this.getAttribute('href');};w.fetch=async(url,options={})=>fetch(new URL(url,f.base),{...options,body:options.body instanceof w.Blob?Buffer.from(await options.body.arrayBuffer()):options.body});w.document.write(await readFile(path.join(root,'public/index.html'),'utf8'));
  w.eval((await Promise.all(['media-browser.js','editor.js','document-selection.js','document.js','user-backup.js','spaces.js','app.js'].map(file=>readFile(path.join(root,'public',file),'utf8')))).join('\n'));
  const $=selector=>w.document.querySelector(selector);await until(()=>$('[data-action=backup-data]'));assert.equal($('[data-action=import-dialog]'),null);assert.equal($('[data-action=publish-dialog]').textContent,'发布');
  $('[data-action=backup-data]').click();await until(()=>$('#user-backup-form'));const form=$('#user-backup-form');assert.equal(form.querySelectorAll('[name=section]:checked').length,5);
  const settings=form.querySelector('[value=settings]');settings.checked=false;settings.dispatchEvent(new w.Event('change',{bubbles:true}));assert.equal(form.querySelector('[value=history]').checked,false);const history=form.querySelector('[value=history]');history.checked=true;history.dispatchEvent(new w.Event('change',{bubbles:true}));assert.equal(settings.checked,true);
  form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await until(()=>downloaded);assert.ok(downloaded.startsWith('/api/backups/file/'));$('[data-action=close-dialog]').click();
  const bytes=await f.backup(['preferences']);$('[data-action=restore-data]').click();await until(()=>$('#user-backup-form [data-backup-file]'));const file=$('[data-backup-file]');Object.defineProperty(file,'files',{value:[new w.File([bytes],'用户备份.zip',{type:'application/zip'})]});file.dispatchEvent(new w.Event('change',{bubbles:true}));await until(()=>$('.backup-summary').textContent.includes('用户数据备份'));assert.equal($('#user-backup-form [value=projects]').closest('label').hidden,true);assert.equal($('#user-backup-form [value=preferences]').disabled,false);
});
