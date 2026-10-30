import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {deflateRawSync} from 'node:zlib';
import {Window} from 'happy-dom';
import {createApplication,root} from '../server.mjs';
import {ProjectImporter,inspectProjectPackage,restorePath} from '../lib/project-package.mjs';
import {crc32,readZip,zipDirectory,packageLimit} from '../lib/zip.mjs';
import {createFolder,folders} from '../lib/media-folders.mjs';
import {digest} from '../lib/store.mjs';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,label){for(let end=Date.now()+20000;Date.now()<end;){if(check())return;await pause(20);}throw new Error('等待超时：'+label);}
function archive(entries,method=0){
  const chunks=[],central=[];let offset=0;
  for(const [filename,value] of entries){const name=Buffer.from(filename),bytes=Buffer.isBuffer(value)?value:Buffer.from(value),packed=method===8?deflateRawSync(bytes):bytes,crc=crc32(bytes),local=Buffer.alloc(30),record=Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50);local.writeUInt16LE(method,8);local.writeUInt32LE(crc,14);local.writeUInt32LE(packed.length,18);local.writeUInt32LE(bytes.length,22);local.writeUInt16LE(name.length,26);
    record.writeUInt32LE(0x02014b50);record.writeUInt16LE(method,10);record.writeUInt32LE(crc,16);record.writeUInt32LE(packed.length,20);record.writeUInt32LE(bytes.length,24);record.writeUInt16LE(name.length,28);record.writeUInt32LE(offset,42);
    chunks.push(local,name,packed);central.push(record,name);offset+=30+name.length+packed.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...chunks,directory,end]);
}
test('ZIP读取支持压缩，拒绝路径、重名、加密、超限、损坏与符号链接',()=>{
  for(const method of [0,8])assert.equal(readZip(archive([['中文.txt','测试内容']],method)).get('中文.txt').read().toString(),'测试内容');
  for(const names of [['../outside'],['/absolute'],['C:bad'],['a\\b'],['same','SAME']])assert.throws(()=>readZip(archive(names.map(name=>[name,'x']))),/部署包/);
  for(const kind of ['encryption','size','symlink','offset','truncated','crc']){
    let bytes=archive([['test.txt','hello']]);const central=bytes.readUInt32LE(bytes.length-6);
    if(kind==='encryption')bytes.writeUInt16LE(1,central+8);
    if(kind==='size')bytes.writeUInt32LE(packageLimit+1,central+24);
    if(kind==='symlink')bytes.writeUInt32LE((0xa000*65536)>>>0,central+38);
    if(kind==='offset')bytes.writeUInt32LE(central,central+42);
    if(kind==='truncated')bytes=bytes.subarray(0,bytes.length-1);
    if(kind==='crc')bytes[30+8]^=1;
    assert.throws(()=>{for(const entry of readZip(bytes).values())entry.read();},/部署包/,kind);
  }
});

test('部署包跨后台恢复正文、媒体、目录、封面与设置，隔离草稿并支持安全确认',async t=>{
  const source=await createApplication({dataDir:await mkdtemp(path.join(os.tmpdir(),'pixix-package-source-'))}),target=await createApplication({dataDir:await mkdtemp(path.join(os.tmpdir(),'pixix-package-target-'))});
  for(const app of [source,target]){await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(()=>app.close());}
  async function client(app){const base=`http://127.0.0.1:${app.server.address().port}`;let cookie='';return{base,get cookie(){return cookie;},async request(url,method='GET',data,status=200,raw=false){const response=await fetch(base+url,{method,headers:{Cookie:cookie,...(data===undefined?{}:{'Content-Type':raw?'application/zip':'application/json'})},body:data===undefined?undefined:raw?data:JSON.stringify(data)});if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];const result=await response.json();assert.equal(response.status,status,JSON.stringify(result));return result;}};}
  const a=await client(source),b=await client(target);
  
  source.store.db.exec('DELETE FROM projects');
  const parent=createFolder(source.store,'项目素材',null),child=createFolder(source.store,'图片',parent.id);
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HA4CAAAAC0lEQVR42mP8/x8AAusB9Wl6XFAAAAAASUVORK5CYII=','base64');
  const image=await source.store.addAsset(png,'封面.png','image/png',{width:1,height:1},'png',null,child.id);
  const videoBytes=await readFile(path.join(root,'renderer/assets/home/home-background.mp4'));
  const video=await source.store.addAsset(videoBytes,'背景.mp4','video/mp4',{width:0,height:0},'mp4');
  const audio=await source.store.addAsset(Buffer.from('ID3'+'.'.repeat(40)),'声音.mp3','audio/mpeg',{width:0,height:0},'mp3');
  const document={title:'可恢复作品',labels:['品牌 / IP','导入测试'],description:'原始简介',useFirstImage:true,coverRatio:'3:4',coverCrop:{x:.3,y:.6,zoom:1.7},blocks:[{id:'text',type:'text',text:'**加粗**\n- 列表',indent:1},{id:'img',type:'image',assetId:image.id,alt:'原始图片'},{id:'table',type:'table',text:'| A | B |\n| --- | --- |\n| C | D |'},{id:'video',type:'video',assetId:video.id},{id:'audio',type:'audio',assetId:audio.id}]};
  const work=await a.request('/api/projects','POST',document,201),hidden=await a.request('/api/projects','POST',{...document,title:'未发布草稿'},201);
  const spaces=(await a.request('/api/state')).spaces;await a.request('/api/spaces/main','PUT',{revision:spaces.revision,groups:document.labels.map(label=>({label,mode:'selected',projectIds:[work.id]}))});
  const before=await a.request('/api/state');await a.request('/api/settings','PUT',{...before.settings,revision:before.settingsRevision,title:'可恢复网站',footer:{text:'自定义页脚',registrationText:'',registrationUrl:''},homeBackground:{videos:[{assetId:video.id,playbackRate:.5},{assetId:image.id,type:'image',duration:7}],finalFrameAssetId:image.id,shadeOpacity:45,shadeColor:'#173d7a'}});
  const job=await a.request('/api/publish','POST',{projectIds:[work.id],includeSettings:true},202);await until(()=>source.publisher.jobs.get(job.id).status!=='running','发布');assert.equal(source.publisher.jobs.get(job.id).status,'done',source.publisher.jobs.get(job.id).message);
  const response=await fetch(a.base+`/api/export/${job.id}?kind=dist`,{headers:{Cookie:a.cookie}}),bytes=Buffer.from(await response.arrayBuffer());assert.equal(response.status,200);
  const entries=readZip(bytes),manifest=JSON.parse(entries.get(restorePath).read());assert.equal(manifest.projects.length,1);assert.equal(manifest.projects[0].id,work.id);assert.ok(!manifest.projects.some(row=>row.id===hidden.id));assert.equal(manifest.assets.length,3);assert.equal(manifest.account,undefined);assert.equal(JSON.stringify(manifest).includes('source-package-password'),false);assert.equal(manifest.projects[0].coverAssetId,null);
  assert.equal(inspectProjectPackage(bytes,target.store).projects[0].blocks[0].text,document.blocks[0].text);
  assert.deepEqual(JSON.parse(await readFile(path.join(source.dataDir,'releases',job.id,'source',restorePath),'utf8')),manifest,'源文件包保留同一恢复描述');
  // Prepare a conflicting draft without changing the target's live copy.
  target.store.db.prepare('INSERT INTO projects(id,draft,live,updatedAt) VALUES(?,?,?,?)').run(work.id,JSON.stringify({...work.draft,title:'本机旧草稿'}),JSON.stringify({...work.draft,title:'本机已发布'}),new Date().toISOString());
  const initial=await b.request('/api/state'),account=target.store.get('account'),live=target.store.get('settingsLive'),unrelated=initial.projects.find(row=>row.id!==work.id);
  const foreign=await fetch(b.base+'/api/import/inspect',{method:'POST',headers:{Origin:'http://evil.invalid'},body:bytes});assert.equal(foreign.status,403);
  let preview=await b.request('/api/import/inspect','POST',bytes,200,true);assert.equal(preview.projects,1);assert.equal(preview.assets,3);assert.deepEqual(preview.conflicts,[{id:work.id,title:'本机旧草稿'}]);assert.equal(target.store.project(work.id).draft.title,'本机旧草稿');
  await b.request('/api/import/'+preview.token,'DELETE');await b.request('/api/import/commit','POST',{token:preview.token},410);
  preview=await b.request('/api/import/inspect','POST',bytes,200,true);target.store.set('settingsRevision',initial.settingsRevision+1);await b.request('/api/import/commit','POST',{token:preview.token},409);await b.request('/api/import/'+preview.token,'DELETE');assert.equal(target.store.project(work.id).draft.title,'本机旧草稿');
  // Force a failure after inserting assets: SQLite and new media files both roll back.
  const importer=new ProjectImporter(target.store,target.publisher),pending=await importer.inspect(bytes),files=await readdir(path.join(target.dataDir,'uploads')),mediaCount=target.store.media().length;
  target.store.db.exec(`CREATE TRIGGER package_failure BEFORE UPDATE ON projects BEGIN SELECT RAISE(ABORT,'package test failure'); END;`);
  await assert.rejects(importer.commit({token:pending.token}),/package test failure/);assert.equal(target.store.media().length,mediaCount);assert.deepEqual(await readdir(path.join(target.dataDir,'uploads')),files);assert.equal(target.publisher.busy,false);target.store.db.exec('DROP TRIGGER package_failure');await importer.discard(pending.token);
  preview=await b.request('/api/import/inspect','POST',bytes,200,true);await b.request('/api/import/commit','POST',{token:preview.token});
  let state=await b.request('/api/state'),restored=target.store.project(work.id).draft;
  assert.equal(restored.title,document.title);assert.equal(restored.coverRatio,'3:4');assert.deepEqual(restored.coverCrop,document.coverCrop);assert.equal(restored.useFirstImage,true);assert.equal(restored.blocks.length,5);assert.equal(restored.blocks[0].indent,1);assert.equal(restored.blocks[2].text,document.blocks[2].text);assert.notEqual(restored.blocks[1].assetId,image.id);assert.equal(target.store.asset(restored.blocks[1].assetId).hash,digest(png));
  const localFolder=folders(target.store).find(row=>row.id===target.store.asset(restored.blocks[1].assetId).folderId);assert.equal(localFolder.name,'图片');assert.equal(folders(target.store).find(row=>row.id===localFolder.parentId).name,'项目素材');
  assert.equal(state.settings.title,'可恢复网站');assert.equal(state.settings.footer.text,'自定义页脚');assert.equal(state.settings.homeBackground.shadeOpacity,45);assert.equal(state.settings.homeBackground.shadeColor,'#173d7a');assert.equal(state.settings.homeBackground.videos[0].playbackRate,.5);assert.equal(state.settings.homeBackground.videos[1].duration,7);assert.equal(state.settings.homeBackground.finalFrameAssetId,restored.blocks[1].assetId);
  assert.deepEqual(target.store.project(unrelated.id),unrelated);assert.equal(target.store.project(work.id).live.title,'本机已发布');assert.deepEqual(target.store.get('settingsLive'),live);assert.deepEqual(target.store.get('account'),account);assert.equal(state.currentRelease,initial.currentRelease);assert.equal(state.releases.length,initial.releases.length);assert.equal(state.releaseRetention,initial.releaseRetention);
  const count=state.media.length;preview=await b.request('/api/import/inspect','POST',bytes,200,true);await b.request('/api/import/commit','POST',{token:preview.token});assert.equal(target.store.media().length,count,'重复导入重用同目录、同内容媒体');
  // Import UI checks against the real API, without opening a browser.
  const w=new Window({url:b.base,settings:{disableCSSFileLoading:true,disableJavaScriptFileLoading:true,disableIframePageLoading:true}});t.after(()=>w.happyDOM.abort());const errors=[];w.addEventListener('error',event=>errors.push(event.message));
  // Convert Happy DOM File bodies using their supported arrayBuffer API.
  w.fetch=async(url,options={})=>fetch(new URL(url,b.base),{...options,headers:{...options.headers,Cookie:b.cookie},body:options.body instanceof w.File?Buffer.from(await options.body.arrayBuffer()):options.body});
  w.document.write(await readFile(path.join(root,'public/index.html'),'utf8'));w.eval((await Promise.all(['media-browser.js','editor.js','document-selection.js','document.js','user-backup.js','spaces.js','app.js'].map(file=>readFile(path.join(root,'public',file),'utf8')))).join('\n'));
  const $=s=>w.document.querySelector(s);await until(()=>$('[data-action=restore-data]'),'恢复入口');assert.equal($('[data-action=import-dialog]'),null);assert.equal($('[data-action=publish-dialog]').textContent,'发布');
  $('[data-action=restore-data]').click();await until(()=>$('[data-backup=choose]'),'恢复窗口');
  const nativeClick=w.HTMLInputElement.prototype.click;let upload=bytes;
  w.HTMLInputElement.prototype.click=function(){if(this.type==='file'){assert.ok(this.accept.includes('.zip'));Object.defineProperty(this,'files',{value:[new w.File([upload],'恢复.zip',{type:'application/zip'})],configurable:true});this.dispatchEvent(new w.Event('change'));}else nativeClick.call(this);};
  $('[data-backup=choose]').click();await until(()=>$('.backup-summary').textContent.includes('可恢复网站'),'恢复预览');assert.ok($('.backup-warning').textContent.includes('草稿'));$('[data-action=close-dialog]').click();assert.equal($('#dialog').open,false);
  $('[data-action=restore-data]').click();await until(()=>$('#dialog').open&&$('[data-backup=choose]'),'重新打开');upload=archive([['index.html','old']]);$('[data-backup=choose]').click();await until(()=>!$('#dialog [role=alert]').hidden,'旧包提示');assert.ok($('#dialog [role=alert]').textContent.includes('新版'));assert.equal($('#user-backup-form [type=submit]').disabled,true);
  upload=bytes;$('[data-backup=choose]').click();await until(()=>!$('#user-backup-form [type=submit]').disabled,'新版包预览');$('#user-backup-form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));assert.ok($('#user-backup-form [type=submit]').disabled);await until(()=>!$('#dialog').open,'确认后关闭');await until(()=>$('.toast')?.textContent.includes('已恢复'),'恢复反馈');assert.deepEqual(errors,[]);w.HTMLInputElement.prototype.click=nativeClick;
  // Malformed manifests are rejected without changing existing works/settings.
  const snapshot=JSON.stringify(target.store.projects()),settings=JSON.stringify(target.store.get('settingsDraft'));
  const pairs=[...entries].map(([name,entry])=>[name,entry.read()]);
  for(const mutate of [m=>m.version=99,m=>m.assets[0]=null,m=>m.projects[0]=null,m=>m.assets[0].hash='0'.repeat(64),m=>m.assets[0].file='missing.png',m=>m.assets[0].folderPath=['../bad'],m=>m.settings=null,m=>m.projects[0].blocks[0].type='script']){
    const changed=structuredClone(manifest);mutate(changed);const invalid=archive(pairs.map(([name,value])=>[name,name===restorePath?JSON.stringify(changed):value]),8);await b.request('/api/import/inspect','POST',invalid,400,true);
  }
  assert.equal(JSON.stringify(target.store.projects()),snapshot);assert.equal(JSON.stringify(target.store.get('settingsDraft')),settings);
  const republish=await b.request('/api/publish','POST',{projectIds:[work.id],includeSettings:true},202);await until(()=>target.publisher.jobs.get(republish.id).status!=='running','恢复后重新发布');assert.equal(target.publisher.jobs.get(republish.id).status,'done',target.publisher.jobs.get(republish.id).message);
  const next=inspectProjectPackage(await zipDirectory(path.join(target.dataDir,'releases',republish.id,'dist')),target.store);assert.ok(next.projects.some(row=>row.id===work.id&&row.title==='可恢复作品'),'恢复的数据可再次编辑发布和导出');
});

test('默认背景随部署包恢复且不依赖目标电脑的内置文件',async t=>{
  const app=await createApplication({dataDir:await mkdtemp(path.join(os.tmpdir(),'pixix-package-default-'))});t.after(()=>app.close());
  const release=app.store.get('currentRelease'),bytes=await zipDirectory(path.join(app.dataDir,'releases',release,'dist')),result=inspectProjectPackage(bytes,app.store);
  assert.ok(result.assets.some(asset=>asset.id==='builtin-home-video'));assert.equal(result.settings.homeBackground.videos[0].assetId,'builtin-home-video');assert.ok(result.assets.find(asset=>asset.id==='builtin-home-video').bytes.length>100);
});
