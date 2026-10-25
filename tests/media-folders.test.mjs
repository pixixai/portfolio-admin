import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Window } from 'happy-dom';
import { createApplication, root } from '../server.mjs';
import { Store } from '../lib/store.mjs';

const pause = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,label){const deadline=Date.now()+12000;while(Date.now()<deadline){if(await check())return;await pause(20);}throw new Error('等待超时：'+label);}
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6XFAAAAAASUVORK5CYII=','base64');

test('原素材数据自动迁移，保留素材编号和文件名，重复启动不重排',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'pixix-folder-migration-'));
  const old=new DatabaseSync(path.join(directory,'portfolio.sqlite'));
  old.exec(`CREATE TABLE media(id TEXT PRIMARY KEY,name TEXT NOT NULL,file TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL,width INTEGER NOT NULL,height INTEGER NOT NULL,hash TEXT NOT NULL,createdAt TEXT NOT NULL,library INTEGER NOT NULL DEFAULT 1);
    INSERT INTO media VALUES('old','原图.png','original.png','image/png',12,2,3,'hash','2026-01-01',1);`);old.close();
  const store=new Store(directory);assert.equal(store.asset('old').file,'original.png');assert.equal(store.asset('old').library,1);assert.equal(store.asset('old').folderId,null);assert.equal(store.asset('old').sortOrder,-1);store.close();
  const reopened=new Store(directory);assert.equal(reopened.asset('old').sortOrder,-1);reopened.close();
});

test('素材文件夹、上传层级、两处视图与排序拖动的完整工作流',async t=>{
  const dataDir=await mkdtemp(path.join(os.tmpdir(),'pixix-media-folders-')),app=await createApplication({dataDir});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(()=>app.close());
  const base=`http://127.0.0.1:${app.server.address().port}`;let cookie='';
  async function request(url,method='GET',data){const r=await fetch(base+url,{method,headers:{Cookie:cookie,...(data===undefined?{}:{'Content-Type':'application/json'})},body:data===undefined?undefined:JSON.stringify(data)});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];return {status:r.status,value:await r.json()};}
  async function ok(url,method,data,status=200){const r=await request(url,method,data);assert.equal(r.status,status,JSON.stringify(r.value));return r.value;}
  
  const folderA=await ok('/api/media/folders','POST',{name:'A 文件夹'},201),folderB=await ok('/api/media/folders','POST',{name:'B 文件夹'},201);
  const nested=(await ok('/api/media/folders/ensure','POST',{parentId:folderA.id,path:['子文件夹','更深一层']})).folder;
  assert.equal((await ok('/api/media/folders/ensure','POST',{parentId:folderA.id,path:['子文件夹','更深一层']})).folder.id,nested.id,'重复路径复用');
  assert.equal((await request('/api/media/folders','POST',{name:'../坏名称'})).status,400);
  assert.equal((await request('/api/media/folders','POST',{name:'A 文件夹'})).status,409);
  assert.equal((await request('/api/media/folders/ensure','POST',{path:['ok','..']})).status,400);
  assert.equal((await request('/api/media/arrange','POST',{kind:'folder',id:folderA.id,folderId:nested.id})).status,400);
  assert.equal((await request('/api/media/arrange','POST',{kind:'asset',id:'missing',folderId:folderA.id})).status,404);
  async function upload(name,folderId,projectId){const r=await fetch(base+'/api/media?name='+encodeURIComponent(name)+(folderId?'&folderId='+folderId:'')+(projectId?'&projectId='+projectId:''),{method:'POST',headers:{Cookie:cookie,'Content-Type':'image/png'},body:png});assert.equal(r.status,201);return r.json();}
  const a=await upload('Alpha.png',folderA.id),b=await upload('Beta.png',folderB.id);
  assert.notEqual(a.id,b.id,'同一文件上传到不同文件夹保留各自归属');assert.equal((await upload('重复.png',folderA.id)).id,a.id);
  const project=await ok('/api/projects','POST',{title:'素材分组检查',labels:[],blocks:[]},201),pending=await upload('暂存.png',nested.id,project.id);
  assert.equal(pending.library,0);const before=await ok('/api/state');
  await ok('/api/media/arrange','POST',{kind:'asset',id:b.id,folderId:folderA.id,targetId:a.id,after:false});
  let state=await ok('/api/state');assert.ok(state.media.find(row=>row.id===b.id).sortOrder<state.media.find(row=>row.id===a.id).sortOrder);
  assert.deepEqual(state.projects,before.projects,'整理素材不改作品数据');assert.equal(state.currentRelease,before.currentRelease);
  await ok('/api/media/arrange','POST',{kind:'asset',id:b.id,folderId:folderB.id});
  await ok('/api/media/arrange','POST',{kind:'folder',id:folderB.id,folderId:null,targetId:folderA.id,after:false});

  const window=new Window({url:base,settings:{disableCSSFileLoading:true,disableJavaScriptFileLoading:true,disableIframePageLoading:true}}),errors=[];t.after(()=>window.happyDOM.abort());
  window.fetch=(url,options={})=>fetch(new URL(url,base),{...options,headers:{...options.headers,Cookie:cookie}});window.addEventListener('error',event=>errors.push(event.message));
  // Send File bytes to the real upload API while simulating the local file chooser.
  window.XMLHttpRequest=class {upload={};open(method,url){this.method=method;this.url=url;}setRequestHeader(){}send(file){(async()=>{try{const r=await fetch(new URL(this.url,base),{method:this.method,headers:{Cookie:cookie,'Content-Type':file.type},body:Buffer.from(await file.arrayBuffer())});this.status=r.status;this.responseText=await r.text();this.onload();}catch{this.onerror();}})();}};
  window.document.write(await readFile(path.join(root,'public/index.html'),'utf8'));
  window.eval((await Promise.all(['media-browser.js','editor.js','document-selection.js','document.js','app.js'].map(file=>readFile(path.join(root,'public',file),'utf8')))).join('\n')+'\nwindow.testMediaReady = () => !mediaMoveSaving;');
  const $=selector=>window.document.querySelector(selector),$$=selector=>[...window.document.querySelectorAll(selector)];
  const change=(node,value)=>{node.value=value;node.dispatchEvent(new window.Event('change',{bubbles:true}));};
  await until(()=>$('.works-table'),'后台加载');$('[data-nav=media]').click();await until(()=>$('.media-browser'),'素材库');
  assert.equal($('[data-media-key]').dataset.mediaKey,'folder:'+folderB.id,'文件夹排在媒体前，保存手动文件夹顺序');
  $('[data-media-action=create][data-media-scope=library]').click();const name=$('.media-folder-form input');name.value='UI 创建';name.dispatchEvent(new window.Event('input',{bubbles:true}));$('.media-folder-form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await until(()=>$$('.media-name').some(node=>node.textContent==='UI 创建'),'创建文件夹');
  change($('[data-media-filter]'),'folders');assert.ok($$('[data-media-key]').every(node=>node.dataset.mediaKey.startsWith('folder:')));
  change($('[data-media-filter]'),'assets');assert.ok($$('[data-media-key]').every(node=>node.dataset.mediaKey.startsWith('asset:')));
  change($('[data-media-filter]'),'all');$(`[data-folder="${folderA.id}"][data-media-key]`).click();assert.ok($(`[data-media-key="asset:${a.id}"]`));
  $('[data-media-action=view][data-mode=list]').click();assert.ok($('.media-list'));$('.media-list [data-sort=name]').click();assert.equal($('.media-list [data-sort=name]').closest('th').getAttribute('aria-sort'),'ascending');$('.media-list [data-sort=name]').click();assert.equal($('.media-list [data-sort=name]').closest('th').getAttribute('aria-sort'),'descending');assert.ok($('[data-media-key]').dataset.mediaKey.startsWith('folder:'));
  const pointer=(node,type,x,y)=>node.dispatchEvent(new window.PointerEvent(type,{bubbles:true,cancelable:true,pointerType:'mouse',pointerId:5,button:0,clientX:x,clientY:y}));
  const drag=async(source,target,into=true)=>{const a=source.getBoundingClientRect(),b=target.getBoundingClientRect();pointer(source,'pointerdown',a.left+15,a.top+15);pointer(window.document,'pointermove',b.left+b.width/2,b.top+b.height/2);assert.ok(into?target.classList.contains('media-drop-folder'):$('#media-drop-marker'));pointer(window.document,'pointerup',b.left+b.width/2,b.top+b.height/2);};
  let source=$(`[data-media-key="asset:${a.id}"]`),target=$('.media-list .media-folder');source.getBoundingClientRect=()=>({left:0,right:500,top:200,bottom:250,width:500,height:50});target.getBoundingClientRect=()=>({left:0,right:500,top:100,bottom:150,width:500,height:50});const childId=target.dataset.folder;
  await drag(source,target);await until(()=>app.store.asset(a.id).folderId===childId&&!$(`[data-media-key="asset:${a.id}"]`),'列表拖入文件夹');
  await pause(360);$(`[data-media-key="folder:${childId}"]`).click();assert.ok($(`[data-media-key="asset:${a.id}"]`));
  // Move back through a breadcrumb target.
  source=$(`[data-media-key="asset:${a.id}"]`);target=$('.media-breadcrumbs [data-folder=""]');source.getBoundingClientRect=()=>({left:0,right:500,top:200,bottom:250,width:500,height:50});target.getBoundingClientRect=()=>({left:0,right:100,top:40,bottom:70,width:100,height:30});await drag(source,target);await until(()=>app.store.asset(a.id).folderId===null&&!$(`[data-media-key="asset:${a.id}"]`),'拖到面包屑返回根目录');
  $('.media-breadcrumbs [data-folder=""]').click();await until(()=>$(`[data-media-key="asset:${a.id}"]`),'根目录刷新');
  // A directory chooser keeps top and nested folders, under the current location.
  const file=new window.File([png],'层级.png',{type:'image/png'});Object.defineProperty(file,'webkitRelativePath',{value:'上传目录/内层/层级.png'});
  const nativeClick=window.HTMLInputElement.prototype.click;let directoryChosen=false;
  window.HTMLInputElement.prototype.click=function(){if(this.type==='file'){directoryChosen=this.hasAttribute('webkitdirectory');Object.defineProperty(this,'files',{value:[file]});this.dispatchEvent(new window.Event('change',{bubbles:true}));}else nativeClick.call(this);};
  $('[data-media-action=upload-folder][data-media-scope=library]').click();await until(()=>app.store.media().some(row=>row.name==='层级.png'),'文件夹上传');await until(()=>$$('[data-media-key]').some(node=>node.textContent.includes('上传目录')),'上传后界面更新');assert.equal(directoryChosen,true);
  state=await ok('/api/state');const uploaded=state.media.find(row=>row.name==='层级.png'),inner=state.folders.find(row=>row.id===uploaded.folderId);assert.equal(inner.name,'内层');assert.equal(state.folders.find(row=>row.id===inner.parentId).name,'上传目录');
  window.HTMLInputElement.prototype.click=nativeClick;
  $('[data-media-action=view][data-mode=grid]').click();
  let mediaNodes=$$('[data-media-key^="asset:"]');source=mediaNodes[1];target=mediaNodes[0];const sourceId=source.dataset.mediaKey.split(':')[1],targetId=target.dataset.mediaKey.split(':')[1];
  source.getBoundingClientRect=()=>({left:0,right:180,top:200,bottom:350,width:180,height:150});target.getBoundingClientRect=()=>({left:200,right:380,top:100,bottom:250,width:180,height:150});
  await drag(source,target,false);await until(()=>app.store.asset(sourceId).sortOrder<app.store.asset(targetId).sortOrder&&$('[data-media-sort]').value==='manual'&&window.testMediaReady(),'缩略图手动排序');
  $('[data-nav=works]').click();await until(()=>$('.works-table'),'返回作品');$(`[data-action=edit][data-id="${project.id}"]`).click();await until(()=>$('.editor-overlay'),'编辑器');$('[data-action=choose-cover]').click();assert.ok($('.modal-foot [data-media-action=create]'));assert.ok($('.modal-foot [data-media-action=upload-folder]'));
  $('.modal [data-media-action=view][data-mode=list]').click();assert.ok($('.modal .media-list'));$('.modal [data-sort=createdAt]').click();$('.modal [data-sort=createdAt]').click();assert.equal($('.modal th[aria-sort=descending] button').dataset.sort,'createdAt');
  // The unpublished nested asset stays out of the library but can be chosen here.
  $(`.modal [data-folder="${folderA.id}"][data-media-key]`).click();$(`.modal [data-folder="${childId}"][data-media-key]`).click();$(`.modal [data-folder="${nested.id}"][data-media-key]`).click();assert.ok($(`[data-pick="${pending.id}"]`));$(`[data-pick="${pending.id}"]`).click();
  source=$(`[data-pick="${pending.id}"]`).closest('[data-media-key]');target=$(`.modal .media-breadcrumbs [data-folder="${folderA.id}"]`);source.getBoundingClientRect=()=>({left:0,right:500,top:200,bottom:250,width:500,height:50});target.getBoundingClientRect=()=>({left:120,right:230,top:40,bottom:70,width:110,height:30});await drag(source,target);
  await until(()=>app.store.asset(pending.id).folderId===folderA.id&&!$(`[data-pick="${pending.id}"]`),'选择窗口拖拽归类');assert.ok($('[data-action=use-media]').textContent.includes('1'),'移动后保留媒体选择');
  $('[data-action=use-media]').click();assert.ok($('.crop-stage'),'文件夹导航和归类后原选择回调仍有效');
  $('[data-action=close-dialog]').click();$('[data-action=close-editor]').click();await until(()=>!$('.editor-overlay'),'关闭编辑');
  assert.deepEqual(errors,[]);assert.equal(app.store.asset(pending.id).library,0,'选择和归类不会提前入库');
  const reopened=new Store(dataDir);assert.equal(reopened.asset(uploaded.id).folderId,inner.id);reopened.close();await window.happyDOM.abort();
});
