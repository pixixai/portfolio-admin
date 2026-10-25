import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Window} from 'happy-dom';
import {createApplication,root} from '../server.mjs';

const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,label){const deadline=Date.now()+12000;while(Date.now()<deadline){if(await check())return;await wait(20);}throw new Error('等待超时：'+label);}
test('素材批量移动原子校验、成组排序、两处复选框、铺满封面与独立预览',async t=>{
  const app=await createApplication({dataDir:await mkdtemp(path.join(os.tmpdir(),'pixix-media-batch-'))});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(()=>app.close());
  const seedImage=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HA4CAAAAC0lEQVR42mP8/x8AAusB9Wl6XFAAAAAASUVORK5CYII=','base64');
  for(let i=0;i<8;i++){const asset=await app.store.addAsset(Buffer.concat([seedImage,Buffer.from('fixture-'+i)]),'选择测试-'+i+'.png','image/png',{width:1,height:1},'png');app.store.db.prepare('UPDATE media SET createdAt=? WHERE id=?').run('2000-01-01T00:00:00.000Z',asset.id);}
  const base=`http://127.0.0.1:${app.server.address().port}`;let cookie='';
  async function request(url,method='GET',data){const r=await fetch(base+url,{method,headers:{Cookie:cookie,...(data===undefined?{}:{'Content-Type':'application/json'})},body:data===undefined?undefined:JSON.stringify(data)});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];return{status:r.status,value:await r.json()};}
  async function ok(url,method,data,status=200){const r=await request(url,method,data);assert.equal(r.status,status,JSON.stringify(r.value));return r.value;}
  
  const initial=await ok('/api/state'),assets=initial.media.filter(row=>row.mime.startsWith('image/')).slice(0,6),item=id=>({kind:'asset',id}),folderItem=id=>({kind:'folder',id});
  const A=await ok('/api/media/folders','POST',{name:'集合 A'},201),B=await ok('/api/media/folders','POST',{name:'集合 B'},201),C=await ok('/api/media/folders','POST',{name:'目标 C'},201);
  const child=(await ok('/api/media/folders/ensure','POST',{parentId:A.id,path:['子目录']})).folder;
  await ok('/api/media/arrange','POST',{kind:'asset',id:assets[5].id,folderId:child.id});
  const snapshot=()=>app.store.media().map(row=>[row.id,row.folderId,row.sortOrder]);const original=snapshot();
  assert.equal((await request('/api/media/arrange','POST',{items:[item(assets[0].id),item('missing')],folderId:C.id})).status,404);assert.deepEqual(snapshot(),original,'部分项目失效时整组保持原位');
  assert.equal((await request('/api/media/arrange','POST',{items:[folderItem(A.id),item(assets[0].id)],folderId:child.id})).status,400);assert.deepEqual(snapshot(),original,'循环嵌套失败不移动其他媒体');
  const same1=await ok('/api/media/folders','POST',{name:'同名',parentId:A.id},201),same2=await ok('/api/media/folders','POST',{name:'同名',parentId:B.id},201);
  assert.equal((await request('/api/media/arrange','POST',{items:[folderItem(same1.id),folderItem(same2.id),item(assets[0].id)],folderId:C.id})).status,409);assert.deepEqual(snapshot(),original,'目标重名时媒体也不会被部分移动');
  const grouped=await ok('/api/media/arrange','POST',{items:[folderItem(A.id),folderItem(child.id),item(assets[5].id)],folderId:C.id});assert.equal(grouped.moved,1,'选中父目录与子项时保留层级整体移动');
  let state=await ok('/api/state');assert.equal(state.folders.find(row=>row.id===child.id).parentId,A.id);assert.equal(app.store.asset(assets[5].id).folderId,child.id);
  await ok('/api/media/arrange','POST',{kind:'asset',id:assets[3].id,folderId:C.id});
  const project=await ok('/api/projects','POST',{title:'多选媒体插入',labels:[],blocks:[]},201);
  const window=new Window({url:base,settings:{disableCSSFileLoading:true,disableJavaScriptFileLoading:true,disableIframePageLoading:true}}),errors=[];t.after(()=>window.happyDOM.abort());
  window.fetch=(url,options={})=>fetch(new URL(url,base),{...options,headers:{...options.headers,Cookie:cookie}});window.addEventListener('error',event=>errors.push(event.message));window.document.write(await readFile(path.join(root,'public/index.html'),'utf8'));
  const css=window.document.createElement('style');css.textContent=await readFile(path.join(root,'public/style.css'),'utf8');window.document.head.append(css);
  window.eval((await Promise.all(['media-browser.js','editor.js','document-selection.js','document.js','app.js'].map(file=>readFile(path.join(root,'public',file),'utf8')))).join('\n')+'\nwindow.mediaBatchTest={ready:()=>!mediaMoveSaving, selection:()=>[...libraryBrowser.selection]};');
  const $=s=>window.document.querySelector(s),$$=s=>[...window.document.querySelectorAll(s)],node=id=>$(`[data-media-key="asset:${id}"]`),select=id=>$(`[data-media-select="asset:${id}"]`).click();
  await until(()=>$('.works-table'),'后台加载');$('[data-nav=media]').click();await until(()=>$('.media-browser'),'素材库');
  assert.equal(window.getComputedStyle($('.media-grid>.media-folder')).aspectRatio,window.getComputedStyle(node(assets[0].id)).aspectRatio,'文件夹与素材卡片比例一致');
  const slider=$('[data-media-size]'),browser=$('.media-browser');slider.value='260';slider.dispatchEvent(new window.Event('input',{bubbles:true}));assert.equal($('.media-browser'),browser,'调节滑杆时不重建界面，保持连续拖动');assert.equal(browser.style.getPropertyValue('--media-thumbnail-size'),'260px');assert.equal(slider.nextElementSibling.value,'260');
  assert.equal(window.getComputedStyle(node(assets[0].id).querySelector('.media-cover-visual img')).objectFit,'cover');assert.ok(node(assets[0].id).querySelector('.media-card-caption small').textContent.includes('×'));assert.ok(node(assets[0].id).querySelector('.media-card-size'));assert.ok(node(assets[0].id).querySelector('.media-card-reference'));
  assert.equal(window.getComputedStyle(node(assets[0].id).querySelector('.media-card-select')).opacity,'0');
  select(assets[2].id);select(assets[0].id);assert.equal($('.media-batchbar').textContent.includes('2'),true);assert.equal(window.getComputedStyle(node(assets[0].id).querySelector('.media-card-select')).opacity,'1');
  const pointer=(n,type,x,y)=>n.dispatchEvent(new window.PointerEvent(type,{bubbles:true,cancelable:true,button:0,pointerType:'mouse',pointerId:11,clientX:x,clientY:y}));
  const drag=async(source,target,into=true,cancel=false)=>{source.getBoundingClientRect=()=>({left:0,right:180,top:220,bottom:360,width:180,height:140});target.getBoundingClientRect=()=>({left:220,right:400,top:100,bottom:200,width:180,height:100});pointer(source,'pointerdown',20,240);pointer(window.document,'pointermove',into?310:390,185);assert.equal($$('.media-drag-source').length,2);assert.ok($('#media-drag-preview').textContent.includes('2'));if(cancel)window.document.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));else{pointer(window.document,'pointerup',into?310:390,185);await until(()=>window.mediaBatchTest.ready(),'批量移动保存');}};
  let folder=$(`[data-media-key="folder:${C.id}"]`);const priorSelection=Array.from(window.mediaBatchTest.selection());
  await drag(node(assets[0].id),folder,true,true);assert.deepEqual(Array.from(window.mediaBatchTest.selection()),priorSelection);assert.equal(app.store.asset(assets[0].id).folderId,null);assert.equal($('#media-drop-marker'),null);
  await drag(node(assets[0].id),folder);assert.equal(app.store.asset(assets[0].id).folderId,C.id);assert.equal(app.store.asset(assets[2].id).folderId,C.id);assert.equal($('#media-drop-marker'),null);
  await wait(360);$(`[data-media-key="folder:${C.id}"]`).click();assert.equal($$('input[data-media-select]:checked').length,2,'进入文件夹保留选择');$('[data-media-action=view][data-mode=list]').click();assert.equal($$('.media-check-cell input[data-media-select]:checked').length,2,'列表视图保留勾选');
  const compact=()=>{const toggle=$('[data-media-compact]');toggle.checked=!toggle.checked;toggle.dispatchEvent(new window.Event('change',{bubbles:true}));};
  compact();assert.ok($('.media-compact-grid'));assert.equal($('.media-list'),null,'列表预览隐藏属性表格');assert.equal($$('.media-compact-grid input[data-media-select]:checked').length,2,'列表预览保留多选');assert.equal($('.media-compact-grid [data-media-key]').dataset.mediaKey,'folder:'+A.id,'预览列表仍先展示文件夹');
  compact();assert.ok($('.media-list th [data-sort=createdAt]'),'关闭后恢复可排序的属性列');assert.equal($$('.media-check-cell input[data-media-select]:checked').length,2);compact();
  $('[data-media-action=view][data-mode=grid]').click();assert.equal($('[data-media-size]').value,'260','进入文件夹和切换视图后保留大小');$('[data-media-action=view][data-mode=list]').click();assert.ok($('[data-media-compact]').checked,'回到列表保留开关状态');
  // Existing selected media are placed as one group after the third media.
  let target=node(assets[3].id);await drag(node(assets[2].id),target,false);let ordered=app.store.media().filter(row=>row.folderId===C.id).sort((a,b)=>a.sortOrder-b.sortOrder).map(row=>row.id);assert.equal(ordered[0],assets[3].id);assert.deepEqual(new Set(ordered.slice(1)),new Set([assets[0].id,assets[2].id]));
  $('[data-media-action=clear-selection]').click();await wait(360);node(assets[0].id).click();assert.ok($('#media-preview-dialog').open);const first=$('#media-preview-dialog img').getAttribute('src');window.document.dispatchEvent(new window.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));assert.notEqual($('#media-preview-dialog img').getAttribute('src'),first);window.document.dispatchEvent(new window.KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));assert.equal($('#media-preview-dialog img').getAttribute('src'),first);$('.media-preview-stage').click();assert.equal($('#media-preview-dialog').open,false);assert.equal($('.media-browser').classList.contains('is-selecting'),false,'预览不进入选择模式');
  $('[data-nav=works]').click();await until(()=>$('.works-table'),'作品列表');$(`[data-action=edit][data-id="${project.id}"]`).click();await until(()=>$('.editor-overlay'),'编辑器');$('[data-action=add-images]').click();assert.ok($('#dialog').open);
  assert.equal($('[data-media-size]').value,'180','选择窗口与素材库大小状态独立');const pickerSlider=$('[data-media-size]');pickerSlider.value='120';pickerSlider.dispatchEvent(new window.Event('input',{bubbles:true}));assert.equal($('.modal .media-browser').style.getPropertyValue('--media-thumbnail-size'),'120px');
  $('.modal [data-media-action=view][data-mode=list]').click();compact();assert.ok($('.modal .media-compact-grid'),'选择窗口也支持列表预览');
  $(`.modal [data-media-key="folder:${C.id}"]`).click();node(assets[0].id).click();assert.ok($('#media-preview-dialog').open&&$('#dialog').open,'独立预览位于媒体选择窗口上方');window.document.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert.equal($('#media-preview-dialog').open,false);assert.equal($('#dialog').open,true);assert.ok($('.editor-overlay'));
  node(assets[0].id).click();$('[data-media-preview-action=choose]').click();assert.ok($('[data-action=use-media]').textContent.includes('1'));select(assets[2].id);assert.ok($('[data-action=use-media]').textContent.includes('2'));
  folder=$(`.modal [data-media-key="folder:${A.id}"]`);await drag(node(assets[0].id),folder);assert.equal(app.store.asset(assets[0].id).folderId,A.id);assert.equal(app.store.asset(assets[2].id).folderId,A.id);assert.ok($('[data-action=use-media]').textContent.includes('2'),'移动后保留用于插入的选择');
  $('[data-action=use-media]').click();assert.equal($('#dialog').open,false);assert.equal($$('.editor-shell [data-block].image').length,2);$('[data-action=close-editor]').click();await until(()=>!$('.editor-overlay'),'保存编辑');
  const saved=app.store.project(project.id).draft.blocks.filter(row=>row.type==='image').map(row=>row.assetId);assert.deepEqual(new Set(saved),new Set([assets[0].id,assets[2].id]));assert.deepEqual(app.store.project(initial.projects[0].id).live,initial.projects[0].live,'分组不改已有发布作品');assert.deepEqual(errors,[]);await window.happyDOM.abort();
});
