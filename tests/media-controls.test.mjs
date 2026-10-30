import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,access} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Window} from 'happy-dom';
import {createApplication,root} from '../server.mjs';
import {folders} from '../lib/media-folders.mjs';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,label){const deadline=Date.now()+12000;while(Date.now()<deadline){if(await check())return;await pause(20);}throw new Error('等待超时：'+label);}
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6XFAAAAAASUVORK5CYII=','base64');
test('多选点击加选、预览Esc退出与缩放拖动、删除保护和直接上传',async t=>{
  const app=await createApplication({dataDir:await mkdtemp(path.join(os.tmpdir(),'pixix-media-controls-'))});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(()=>app.close());
  const base=`http://127.0.0.1:${app.server.address().port}`;let cookie='';
  async function request(url,method='GET',data){const r=await fetch(base+url,{method,headers:{Cookie:cookie,...(data===undefined?{}:{'Content-Type':'application/json'})},body:data===undefined?undefined:JSON.stringify(data)});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];return{status:r.status,value:await r.json()};}
  async function ok(url,method,data,status=200){const r=await request(url,method,data);assert.equal(r.status,status,JSON.stringify(r.value));return r.value;}
  
  const initial=await ok('/api/state'),images=initial.media.filter(row=>row.mime.startsWith('image/')).slice(0,3),used=initial.media.find(row=>row.references.projects.length||row.references.inHistory);
  const parent=await ok('/api/media/folders','POST',{name:'待删组'},201),child=await ok('/api/media/folders','POST',{name:'内层',parentId:parent.id},201);
  async function upload(name,folderId){const r=await fetch(base+'/api/media?name='+encodeURIComponent(name)+(folderId?'&folderId='+folderId:''),{method:'POST',headers:{Cookie:cookie,'Content-Type':'image/png'},body:png});assert.equal(r.status,201);return r.json();}
  const rootFile=await upload('未使用根图.png'),nestedFile=await upload('内层图片.png',child.id);
  const protectedItems=[{kind:'asset',id:used.id},{kind:'asset',id:rootFile.id}];const plan=await ok('/api/media/delete-plan','POST',{items:protectedItems});assert.equal(plan.allowed,false);assert.equal(plan.blocked.length,1);
  assert.equal((await request('/api/media/delete','POST',{items:protectedItems})).status,409);assert.ok(app.store.asset(rootFile.id),'混入引用素材时不会部分删除');
  assert.equal((await request('/api/media/delete','POST',{items:[{kind:'asset',id:rootFile.id},{kind:'asset',id:'missing'}]})).status,404);assert.ok(app.store.asset(rootFile.id));
  const project=await ok('/api/projects','POST',{title:'直接上传暂存测试',labels:[],blocks:[]},201);
  const w=new Window({url:base,settings:{disableCSSFileLoading:true,disableJavaScriptFileLoading:true,disableIframePageLoading:true}}),errors=[];t.after(()=>w.happyDOM.abort());w.fetch=(url,options={})=>fetch(new URL(url,base),{...options,headers:{...options.headers,Cookie:cookie}});w.addEventListener('error',event=>errors.push(event.message));
  w.XMLHttpRequest=class{upload={};open(method,url){this.method=method;this.url=url;}setRequestHeader(){}send(file){(async()=>{try{const r=await fetch(new URL(this.url,base),{method:this.method,headers:{Cookie:cookie,'Content-Type':file.type},body:Buffer.from(await file.arrayBuffer())});this.status=r.status;this.responseText=await r.text();this.onload();}catch{this.onerror();}})();}};
  w.document.write(await readFile(path.join(root,'public/index.html'),'utf8'));const style=w.document.createElement('style');style.textContent=await readFile(path.join(root,'public/style.css'),'utf8');w.document.head.append(style);
  w.eval((await Promise.all(['media-browser.js','editor.js','document-selection.js','document.js','spaces.js','app.js'].map(file=>readFile(path.join(root,'public',file),'utf8')))).join('\n'));
  const $=s=>w.document.querySelector(s),$$=s=>[...w.document.querySelectorAll(s)],node=id=>$(`[data-media-key="asset:${id}"]`),select=id=>$(`[data-media-select="asset:${id}"]`).click();
  const key=key=>w.document.dispatchEvent(new w.KeyboardEvent('keydown',{key,code:key===' '?'Space':'',bubbles:true,cancelable:true}));
  await until(()=>$('.works-table'),'后台加载');$('[data-nav=media]').click();await until(()=>$('.media-browser'),'素材库');
  select(images[0].id);node(images[1].id).click();assert.equal($$('input[data-media-select]:checked').length,2);assert.equal($('#media-preview-dialog'),null,'多选模式点击封面不会打开预览');
  $('[data-media-action=view][data-mode=list]').click();node(images[2].id).click();assert.equal($$('input[data-media-select]:checked').length,3);node(images[1].id).click();assert.equal($$('input[data-media-select]:checked').length,2,'列表点击可以取消选择');
  assert.ok($('[data-media-action=delete-selection]'));$('[data-media-action=clear-selection]').click();node(images[0].id).click();assert.ok($('#media-preview-dialog').open);
  let stage=$('.media-preview-stage'),image=$('#media-preview-dialog img');stage.getBoundingClientRect=()=>({left:0,top:0,width:800,height:500,right:800,bottom:500});Object.defineProperty(image,'offsetWidth',{get:()=>400});Object.defineProperty(image,'offsetHeight',{get:()=>300});
  stage.dispatchEvent(new w.WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:-Math.log(2)/.0015,clientX:400,clientY:250}));assert.ok(image.style.transform.includes('scale(2)'));assert.equal($('.media-preview-zoom').textContent,'200%');
  const pointer=(target,type,x,y)=>target.dispatchEvent(new w.PointerEvent(type,{bubbles:true,cancelable:true,button:0,pointerType:'mouse',pointerId:8,clientX:x,clientY:y}));pointer(image,'pointerdown',400,250);pointer(w.document,'pointermove',450,280);assert.ok(image.style.transform.includes('translate(50px, 30px)'),image.style.transform);pointer(w.document,'pointerup',450,280);stage.click();assert.ok($('#media-preview-dialog').open,'拖动结束不会误触空白关闭');
  key('ArrowRight');assert.equal($('.media-preview-zoom').textContent,'100%','切图重置缩放');
  const space=new w.KeyboardEvent('keydown',{key:' ',code:'Space',bubbles:true,cancelable:true});$('.media-preview-close').dispatchEvent(space);assert.equal(space.defaultPrevented,true,'阻止空格激活获得焦点的关闭按钮');assert.ok($('#media-preview-dialog').open,'空格不关闭预览');assert.ok($('.media-preview-hint').textContent.includes('Esc 关闭'));key('Escape');assert.equal($('#media-preview-dialog').open,false,'Esc退出预览');
  // Delete a nested folder selected before its parent, plus another unused asset.
  $(`[data-media-key="folder:${parent.id}"]`).click();$(`[data-media-select="folder:${child.id}"]`).click();$('.media-breadcrumbs [data-folder=""]').click();$(`[data-media-select="folder:${parent.id}"]`).click();select(rootFile.id);
  $('[data-media-action=delete-selection]').click();await until(()=>$('#media-operation-dialog')?.open,'删除确认');assert.ok($('#media-operation-dialog').textContent.includes('2 个文件夹、2 项素材'));$('[data-media-operation=delete]').click();await until(()=>!app.store.asset(rootFile.id)&&!$('#media-operation-dialog').open,'批量删除完成');assert.equal(app.store.asset(nestedFile.id),undefined);await assert.rejects(access(path.join(app.dataDir,'uploads',rootFile.file)));assert.ok(app.store.asset(used.id),'引用素材保留');
  // Native chooser is simulated, while the real upload API handles the files.
  const nativeClick=w.HTMLInputElement.prototype.click;let selectedFile=new w.File([png],'直接上传.png',{type:'image/png'}),chooserCount=0;
  w.HTMLInputElement.prototype.click=function(){if(this.type==='file'){chooserCount++;Object.defineProperty(this,'files',{value:[selectedFile]});this.dispatchEvent(new w.Event('change',{bubbles:true}));}else nativeClick.call(this);};
  const input=(el,value)=>{el.value=value;el.dispatchEvent(new w.Event('input',{bubbles:true}));};
  $('[data-action=upload-media]').click();assert.equal(chooserCount,1,'点击上传立即打开系统文件选择器');assert.equal($('#media-operation-dialog').open,false,'不再显示上传选项面板');assert.equal($('[data-media-pack]'),null);
  await until(()=>{const asset=app.store.media().find(row=>row.name==='直接上传.png');return asset&&node(asset.id)&&$('#upload-progress').hidden;},'直接上传完成');
  const direct=app.store.media().find(row=>row.name==='直接上传.png');assert.equal(direct.folderId,null);assert.equal(direct.library,1);assert.equal(folders(app.store).length,0,'直接上传不自动创建文件夹');
  async function createFolder(name,picking=false){$(`[data-media-action=create][data-media-scope=${picking?'picker':'library'}]`).click();input($('.media-folder-form input'),name);$('.media-folder-form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await until(()=>{const folder=folders(app.store).find(row=>row.name===name);return folder&&$(`[data-media-key="folder:${folder.id}"]`);},'创建文件夹 '+name);return folders(app.store).find(row=>row.name===name);}
  const folder=await createFolder('指定分组');$(`[data-media-key="folder:${folder.id}"]`).click();selectedFile=new w.File([png],'分组上传.png',{type:'image/png'});$('[data-action=upload-media]').click();assert.equal(chooserCount,2);await until(()=>{const asset=app.store.media().find(row=>row.name==='分组上传.png');return asset&&node(asset.id)&&$('#upload-progress').hidden;},'当前文件夹上传完成');assert.equal(app.store.media().find(row=>row.name==='分组上传.png').folderId,folder.id);$('.media-breadcrumbs [data-folder=""]').click();
  $('[data-nav=works]').click();await until(()=>$('.works-table'),'作品页');$(`[data-action=edit][data-id="${project.id}"]`).click();await until(()=>$('.editor-overlay'),'编辑器');$('[data-action=choose-cover]').click();const coverFolder=await createFolder('封面暂存',true);$(`[data-media-key="folder:${coverFolder.id}"]`).click();selectedFile=new w.File([png],'封面.png',{type:'image/png'});$('[data-action=upload-picker]').click();assert.equal(chooserCount,3);assert.ok($('#dialog').open,'上传保留原媒体选择窗口');assert.equal($('#media-operation-dialog').open,false);
  await until(()=>app.store.media().find(row=>row.name==='封面.png')&&$('[data-action=use-media]')?.textContent.includes('1')&&$('#upload-progress').hidden,'选择窗口直接上传完成');const temp=app.store.media().find(row=>row.name==='封面.png');assert.equal(temp.library,0);assert.equal(temp.folderId,coverFolder.id);$('[data-action=use-media]').click();assert.ok($('.crop-stage'));$('[data-action=apply-crop]').click();$('[data-action=close-editor]').click();await until(()=>!$('.editor-overlay'),'保存退出');assert.equal(app.store.project(project.id).draft.coverAssetId,temp.id);assert.equal(app.store.asset(temp.id).library,0);
  w.HTMLInputElement.prototype.click=nativeClick;assert.deepEqual(errors,[]);await w.happyDOM.abort();
});
