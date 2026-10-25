import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Window} from 'happy-dom';
import {createApplication,root} from '../server.mjs';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,label){for(let end=Date.now()+15000;Date.now()<end;){if(check())return;await pause(15);}throw new Error('等待超时：'+label);}
async function fixture(t,seed=false){
  const app=await createApplication({dataDir:await mkdtemp(path.join(os.tmpdir(),'pixix-settings-ui-'))});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(()=>app.close());
  const base=`http://127.0.0.1:${app.server.address().port}`;let cookie='';
  async function api(url,method='GET',data){const r=await fetch(base+url,{method,headers:{Cookie:cookie,...(data===undefined?{}:{'Content-Type':'application/json'})},body:data===undefined?undefined:JSON.stringify(data)});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];const value=await r.json();assert.ok(r.ok,JSON.stringify(value));return value;}
  
  let assets=[];
  if(seed){
    const folder=(await api('/api/media/folders/ensure','POST',{parentId:null,path:['首页背景','原始视频']})).folder;
    const video=await readFile(path.join(root,'renderer/assets/home/home-background.mp4'));
    const r=await fetch(base+'/api/media?name=定位视频.mp4&folderId='+folder.id,{method:'POST',headers:{Cookie:cookie,'Content-Type':'video/mp4'},body:video});assert.equal(r.status,201);const asset=await r.json();
    const before=await api('/api/state'),image=before.media.find(item=>item.mime.startsWith('image/'));assets=[asset,image];
    await api('/api/settings','PUT',{...before.settings,revision:before.settingsRevision,homeBackground:{videos:[{assetId:asset.id,playbackRate:1},{assetId:image.id,type:'image',duration:5}],finalFrameAssetId:null,shadeOpacity:80}});
  }
  const w=new Window({url:base,settings:{disableCSSFileLoading:true,disableJavaScriptFileLoading:true,disableIframePageLoading:true}}),errors=[];t.after(()=>w.happyDOM.abort());
  const realFetch=(url,options={})=>fetch(new URL(url,base),{...options,headers:{...options.headers,Cookie:cookie}});w.fetch=realFetch;w.addEventListener('error',event=>errors.push(event.message));
  w.document.write(await readFile(path.join(root,'public/index.html'),'utf8'));
  w.eval((await Promise.all(['media-browser.js','editor.js','document-selection.js','document.js','app.js'].map(file=>readFile(path.join(root,'public',file),'utf8')))).join('\n'));
  const $=selector=>w.document.querySelector(selector),$$=selector=>[...w.document.querySelectorAll(selector)];
  const click=selector=>{const node=$(selector);assert.ok(node,selector);node.click();};
  const input=(key,value)=>{const node=$(`[data-setting="${key}"]`);node.value=value;node.dispatchEvent(new w.Event('input',{bubbles:true}));};
  await until(()=>$('.works-table'),'加载');click('[data-nav=settings]');await until(()=>$('.settings-page'),'展示设置');
  return {app,w,$,$$,click,input,api,realFetch,assets,errors};
}

test('设置未修改、改回原值、重复点击当前导航以及保存后离开均不误弹窗',async t=>{
  const f=await fixture(t),initial=f.$('[data-setting=tagline]').value;
  f.input('tagline',initial);f.input('tagline','暂时修改');f.input('tagline',initial);f.click('[data-nav=works]');await until(()=>f.$('.works-table'),'无修改直接离开');assert.equal(f.$('#dialog').open,false);
  f.click('[data-nav=settings]');await until(()=>f.$('.settings-page'),'重回设置');f.input('tagline','新介绍');f.click('[data-nav=settings]');await pause(20);assert.equal(f.$('#dialog').open,false);assert.equal(f.$('[data-setting=tagline]').value,'新介绍');
  f.click('[data-action=save-settings]');await until(()=>f.app.store.get('settingsDraft').tagline==='新介绍','保存');await pause(20);f.click('[data-nav=works]');await until(()=>f.$('.works-table'),'刚保存后直接离开');assert.equal(f.$('#dialog').open,false);assert.deepEqual(f.errors,[]);
});

test('离开设置提供取消、丢弃与保存并离开，失败保留输入且可重试',async t=>{
  const f=await fixture(t),initial=f.app.store.get('settingsDraft').tagline;
  f.input('tagline','尚未保存');f.click('[data-nav=works]');await until(()=>f.$('#dialog[open]'),'未保存提示');assert.deepEqual(f.$$('#dialog .modal-foot button').map(node=>node.textContent),['取消','离开','保存设置并离开']);
  f.click('[data-action=close-dialog]');await pause(20);assert.equal(f.$('[data-setting=tagline]').value,'尚未保存');f.click('[data-nav=works]');await until(()=>f.$('#dialog[open]'),'再次提示');f.click('[data-action=settings-leave]');await until(()=>f.$('.works-table'),'丢弃后离开');assert.equal(f.app.store.get('settingsDraft').tagline,initial);
  f.click('[data-nav=settings]');await until(()=>f.$('.settings-page'),'进入设置');f.input('tagline','保存再离开');
  f.w.fetch=(url,options)=>String(url)==='/api/settings'&&options?.method==='PUT'?Promise.resolve({ok:false,status:400,json:async()=>({error:'模拟保存失败'})}):f.realFetch(url,options);
  f.click('[data-nav=media]');await until(()=>f.$('#dialog[open]'),'提示保存');f.click('[data-action=settings-save-leave]');await until(()=>f.$('.toast.error'),'显示保存失败');assert.ok(f.$('.settings-page'));assert.equal(f.$('[data-setting=tagline]').value,'保存再离开');assert.equal(f.app.store.get('settingsDraft').tagline,initial);
  f.w.fetch=f.realFetch;f.click('[data-nav=media]');await until(()=>f.$('#dialog[open]'),'重试提示');f.click('[data-action=settings-save-leave]');await until(()=>f.$('#media-results'),'保存后离开');assert.equal(f.app.store.get('settingsDraft').tagline,'保存再离开');
  f.click('[data-nav=settings]');await until(()=>f.$('.settings-page'),'再次进入');f.click('[data-nav=works]');await until(()=>f.$('.works-table'),'再次离开无提示');assert.equal(f.$('#dialog').open,false);assert.deepEqual(f.errors,[]);
});

test('保存中离开等待提交，保存期间的新输入不会被旧请求覆盖或误认为已保存',async t=>{
  const f=await fixture(t);let release=null,requests=0;
  const gate=()=>{f.w.fetch=(url,options)=>{if(String(url)==='/api/settings'&&options?.method==='PUT'){requests++;return new Promise(resolve=>{release=()=>resolve(f.realFetch(url,options));});}return f.realFetch(url,options);};};
  f.input('tagline','第一份提交');gate();f.click('[data-action=save-settings]');await until(()=>release,'开始保存');assert.equal(f.$('[data-action=save-settings]').disabled,true);f.click('[data-nav=media]');await pause(20);assert.ok(f.$('.settings-page'));assert.equal(f.$('#dialog').open,false);release();await until(()=>f.$('#media-results'),'等待保存后离开');assert.equal(requests,1);assert.equal(f.app.store.get('settingsDraft').tagline,'第一份提交');
  f.click('[data-nav=settings]');await until(()=>f.$('.settings-page'),'再次进入');f.input('tagline','第二份提交');release=null;f.click('[data-action=save-settings]');await until(()=>release,'第二次保存');f.input('tagline','请求期间继续编辑');release();await until(()=>!f.$('[data-action=save-settings]').disabled,'保存完成');assert.equal(f.app.store.get('settingsDraft').tagline,'第二份提交');assert.equal(f.$('[data-setting=tagline]').value,'请求期间继续编辑');
  f.click('[data-nav=works]');await until(()=>f.$('#dialog[open]'),'新输入仍需保存');f.click('[data-action=close-dialog]');f.w.fetch=f.realFetch;assert.deepEqual(f.errors,[]);
});

test('缩略图没有播放控件，素材库定位可跨文件夹与视图、清除筛选并高亮',async t=>{
  const f=await fixture(t,true);assert.equal(f.$('.home-background-list video[controls]'),null);assert.ok(f.$('.home-background-list video[hidden]'));assert.equal(f.$$('.home-background-list [data-action=home-reveal-asset]').length,2);
  for(const mode of ['grid','list']){
    f.click('[data-nav=media]');await until(()=>f.$('#media-results'),'素材库');f.click(`[data-media-action=view][data-mode=${mode}]`);
    const search=f.$('#media-search');search.value='不存在的文件';search.dispatchEvent(new f.w.Event('input',{bubbles:true}));const unused=f.$('#unused-only');unused.checked=true;unused.dispatchEvent(new f.w.Event('change',{bubbles:true}));
    f.click('[data-nav=settings]');await until(()=>f.$('.settings-page'),'设置列表');f.click(`[data-action=home-reveal-asset][data-id="${f.assets[0].id}"]`);await until(()=>f.$('.is-located'),'定位视频');
    assert.equal(f.$('.is-located').dataset.mediaKey,'asset:'+f.assets[0].id);assert.ok(f.$('.media-breadcrumbs').textContent.includes('原始视频'));assert.equal(f.$('#media-search').value,'');assert.equal(f.$('#unused-only').checked,false);assert.equal(f.$('.media-batchbar'),null);
    f.click('[data-nav=settings]');await until(()=>f.$('.settings-page'),'重回设置');
  }
  f.input('tagline','定位前的未保存修改');f.click(`[data-action=home-reveal-asset][data-id="${f.assets[1].id}"]`);await until(()=>f.$('#dialog[open]'),'定位遵守未保存检查');f.click('[data-action=close-dialog]');assert.ok(f.$('.settings-page'));assert.equal(f.$('[data-setting=tagline]').value,'定位前的未保存修改');assert.deepEqual(f.errors,[]);
});
