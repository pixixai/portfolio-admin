import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Window} from 'happy-dom';
import {createApplication,root} from '../server.mjs';
import {digest,openStore} from '../lib/store.mjs';
import {readZip} from '../lib/zip.mjs';
import {restorePath} from '../lib/project-package.mjs';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,label){for(let end=Date.now()+15000;Date.now()<end;){if(check())return;await pause(15);}throw new Error('等待超时：'+label);}

test('新安装仅包含两个示例、四张图片和六个标签，使用默认视频与公开署名',async t=>{
  const app=await createApplication({dataDir:await mkdtemp(path.join(os.tmpdir(),'pixix-default-version-'))});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(()=>app.close());const base=`http://127.0.0.1:${app.server.address().port}`;
  const state=await(await fetch(base+'/api/state')).json();assert.equal(state.projects.length,2);assert.equal(state.media.length,4);assert.equal(state.releases.length,1);
  assert.deepEqual(state.settings.categories,['品牌 / IP','包装设计','UI / UX','平面视觉','空间设计','电商视觉']);assert.equal(state.settings.owner,'噼哩画啦');assert.equal(state.settings.brand,'噼哩画啦');assert.equal(state.settings.footer.text,'© 2026 噼哩画啦 · 作品集');assert.equal(state.settings.appearance.coverRadius,0);assert.equal(state.settings.homeBackground.loop,true);
  const docs=state.projects.map(row=>row.draft);assert.deepEqual(docs.map(row=>row.id),['sample-palette','sample-prism']);
  for(const document of docs){assert.equal(document.blocks.length,1);assert.equal(document.blocks[0].type,'image');assert.notEqual(document.coverAssetId,document.blocks[0].assetId);assert.equal(document.coverRatio,'16:9');const cover=state.media.find(asset=>asset.id===document.coverAssetId),content=state.media.find(asset=>asset.id===document.blocks[0].assetId),folder=path.join(root,'renderer/Portfolio',document.folder);assert.equal(cover.hash,digest(await readFile(path.join(folder,'cover.png'))));assert.equal(content.hash,digest(await readFile(path.join(folder,'content.png'))));}
  const config=await(await fetch(base+'/site/data/home-background.json')).json();assert.equal(config.videos[0].src,'assets/home/home-background.mp4');assert.equal(config.videos[0].playbackRate,1);assert.equal(config.shadeOpacity,80);assert.equal(config.shadeColor,'#000000');assert.equal(config.finalFrame,null);assert.equal(config.loop,true);
  const exported=Buffer.from(await(await fetch(base+`/api/export/${state.currentRelease}?kind=dist`)).arrayBuffer()),entries=readZip(exported),manifest=JSON.parse(entries.get(restorePath).read());assert.equal(manifest.projects.length,2);assert.equal(manifest.assets.length,5);assert.equal(entries.get('assets/home/home-background.mp4').read().length,9034874);
});

test('左上角名称双击编辑，对号、失焦、回车保存，取消和失败保留输入，不覆盖其它设置',async t=>{
  const dataDir=await mkdtemp(path.join(os.tmpdir(),'pixix-brand-edit-')),app=await createApplication({dataDir});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(()=>app.close());const base=`http://127.0.0.1:${app.server.address().port}`;
  const w=new Window({url:base,settings:{disableCSSFileLoading:true,disableJavaScriptFileLoading:true,disableIframePageLoading:true}});t.after(()=>w.happyDOM.abort());const errors=[];w.addEventListener('error',event=>errors.push(event.message));let failOnce=false;
  w.fetch=(url,options={})=>url==='/api/brand'&&failOnce?(failOnce=false,Promise.resolve(new w.Response(JSON.stringify({error:'模拟名称保存失败'}),{status:409,headers:{'Content-Type':'application/json'}}))):fetch(new URL(url,base),options);
  w.document.write(await readFile(path.join(root,'public/index.html'),'utf8'));w.eval((await Promise.all(['media-browser.js','editor.js','document-selection.js','document.js','spaces.js','app.js'].map(file=>readFile(path.join(root,'public',file),'utf8')))).join('\n'));
  const $=s=>w.document.querySelector(s),input=value=>{const field=$('[data-brand-editor] input');field.value=value;field.dispatchEvent(new w.Event('input',{bubbles:true}));},edit=()=>{$('[data-brand-name]').dispatchEvent(new w.MouseEvent('dblclick',{bubbles:true,cancelable:true}));};
  await until(()=>$('[data-brand-name]'),'名称');assert.equal($('[data-brand-name]').textContent,'噼哩画啦');const live=app.store.get('settingsLive'),projectCount=app.store.projects().length;
  edit();assert.equal(w.document.activeElement,$('[data-brand-editor] input'));input('我的创作空间');$('[data-brand-editor]').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await until(()=>!$('[data-brand-editor]'),'对号保存');assert.equal($('[data-brand-name]').textContent,'我的创作空间');assert.equal(app.store.get('settingsDraft').brand,'我的创作空间');assert.deepEqual(app.store.get('settingsLive'),live);
  edit();input('失焦完成');$('[data-brand-editor] input').dispatchEvent(new w.FocusEvent('focusout',{bubbles:true,relatedTarget:w.document.body}));await until(()=>!$('[data-brand-editor]'),'失焦保存');assert.equal(app.store.get('settingsDraft').brand,'失焦完成');
  edit();input('不保存');$('[data-brand-editor] input').dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));assert.equal($('[data-brand-name]').textContent,'失焦完成');
  edit();input('');$('[data-brand-editor] input').dispatchEvent(new w.FocusEvent('focusout',{bubbles:true}));assert.equal($('[data-brand-name]').textContent,'失焦完成');
  $('[data-nav=settings]').click();await until(()=>$('[data-setting=owner]'),'设置页');const owner=$('[data-setting=owner]');owner.value='还未保存的姓名';owner.dispatchEvent(new w.Event('input',{bubbles:true}));
  edit();input('保留输入的名称');failOnce=true;$('[data-brand-editor] input').dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));await until(()=>$('.brand-edit-error'),'失败显示');assert.equal($('[data-brand-editor] input').value,'保留输入的名称');
  $('[data-brand-editor]').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await until(()=>!$('[data-brand-editor]'),'重试保存');assert.equal($('[data-setting=owner]').value,'还未保存的姓名');assert.equal(app.store.get('settingsDraft').owner,'噼哩画啦');
  $('[data-action=save-settings]').click();await until(()=>app.store.get('settingsDraft').owner==='还未保存的姓名','保存设置');assert.equal(app.store.get('settingsDraft').brand,'保留输入的名称');assert.equal(app.store.projects().length,projectCount);assert.deepEqual(errors,[]);
  for(const [data,status] of [[{name:'',revision:app.store.get('settingsRevision')},400],[{name:'x'.repeat(51),revision:app.store.get('settingsRevision')},400],[{name:'冲突',revision:0},409]]){const response=await fetch(base+'/api/brand',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});assert.equal(response.status,status);}
  await w.happyDOM.abort();const reopened=await openStore(dataDir,path.join(root,'renderer'));t.after(()=>reopened.close());assert.equal(reopened.get('settingsDraft').brand,'保留输入的名称');assert.equal(reopened.projects().length,2);
});
