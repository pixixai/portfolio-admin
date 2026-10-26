import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,mkdir,writeFile,readdir,access,symlink} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Window} from 'happy-dom';
import {createApplication,root} from '../server.mjs';
import {Store} from '../lib/store.mjs';
import {pruneSidebarPreviews} from '../lib/sidebar-previews.mjs';
import {inspectProjectPackage} from '../lib/project-package.mjs';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,label){for(let end=Date.now()+15000;Date.now()<end;){if(await check())return;await pause(15);}throw new Error('等待超时：'+label);}
async function fixture(t,{fakeBuild=false}={}){
  const app=await createApplication({dataDir:await mkdtemp(path.join(os.tmpdir(),'pixix-live-preview-'))});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(()=>app.close());
  const base=`http://127.0.0.1:${app.server.address().port}`,builds=[];
  if(fakeBuild)app.publisher.build=async(directory,snapshot)=>{builds.push(structuredClone(snapshot));await pause(80);await mkdir(path.join(directory,'dist'),{recursive:true});await writeFile(path.join(directory,'dist/index.html'),'<!doctype html><p>preview</p>');};
  const w=new Window({url:base,settings:{disableCSSFileLoading:true,disableJavaScriptFileLoading:true,disableIframePageLoading:true}});t.after(()=>w.happyDOM.abort());const errors=[],requests=[];
  const nativeTimeout=w.setTimeout.bind(w);w.setTimeout=(fn,ms,...args)=>nativeTimeout(fn,[300,450,900,1000].includes(ms)?20:ms,...args);
  w.fetch=(url,options={})=>{if(url==='/api/preview'&&options.method==='POST')requests.push(JSON.parse(options.body));return fetch(new URL(url,base),options);};w.addEventListener('error',event=>errors.push(event.message));
  w.document.write(await readFile(path.join(root,'public/index.html'),'utf8'));w.eval((await Promise.all(['media-browser.js','editor.js','document-selection.js','document.js','site-preview.js','app.js'].map(file=>readFile(path.join(root,'public',file),'utf8')))).join('\n'));
  const $=selector=>w.document.querySelector(selector),click=selector=>{assert.ok($(selector),selector);$(selector).click();},input=(selector,value)=>{const node=$(selector);node.value=value;node.dispatchEvent(new w.Event('input',{bubbles:true}));};
  await until(()=>$('.works-table'),'后台加载');return{app,base,w,$,click,input,builds,requests,errors};
}

test('循环开关联动定格帧，保存、预览、发布与可恢复部署包保留循环设置',async t=>{
  const f=await fixture(t),{app,base,$,click}=f;
  async function api(url,method='GET',data,status=200){const response=await fetch(base+url,{method,headers:data===undefined?{}:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)}),result=await response.json();assert.equal(response.status,status,JSON.stringify(result));return result;}
  const initial=await api('/api/state'),frame=initial.media[0];assert.equal(initial.capabilities.backgroundLoop,true);assert.equal(initial.capabilities.sidebarPreview,true);
  for(const loop of [0,'true',{},[]])await api('/api/settings','PUT',{...initial.settings,revision:initial.settingsRevision,homeBackground:{videos:[{assetId:null,playbackRate:1}],finalFrameAssetId:frame.id,shadeOpacity:80,loop}},400);
  await api('/api/settings','PUT',{...initial.settings,revision:initial.settingsRevision,homeBackground:{videos:[{assetId:null,playbackRate:1}],finalFrameAssetId:frame.id,shadeOpacity:80,loop:false}});
  await f.w.eval('loadState()');click('[data-nav=settings]');await until(()=>$('[data-action=home-bg-loop]'),'循环开关');assert.equal($('[data-action=home-bg-loop]').getAttribute('aria-checked'),'false');assert.equal($('#home-final-settings').hidden,false);
  assert.equal($('[data-action=home-bg-loop]').parentElement.lastElementChild,$('[data-action=home-bg-loop]'),'开关位于列表上方操作栏右侧');
  click('[data-action=home-bg-loop]');assert.equal($('#home-final-settings').hidden,true);assert.equal($('[data-action=home-bg-loop]').getAttribute('aria-checked'),'true');
  click('[data-action=home-bg-loop]');assert.equal($('#home-final-settings').hidden,false);assert.ok($('.home-final-preview'),'关闭循环恢复已选定格图');click('[data-action=home-bg-loop]');click('[data-action=save-settings]');
  await until(()=>app.store.get('settingsDraft').homeBackground?.loop===true,'保存循环设置');assert.equal(app.store.get('settingsDraft').homeBackground.finalFrameAssetId,frame.id);assert.deepEqual(app.store.get('settingsLive'),initial.settingsLive);
  const preview=await api('/api/preview','POST',{},202);await until(()=>app.publisher.jobs.get(preview.id).status==='done','预览完成');assert.equal((await api('/preview/'+preview.id+'/data/home-background.json')).loop,true);
  const job=await api('/api/publish','POST',{projectIds:[],includeSettings:true},202);await until(()=>app.publisher.jobs.get(job.id).status!=='running','发布完成');assert.equal(app.publisher.jobs.get(job.id).status,'done');assert.equal((await api('/site/data/home-background.json')).loop,true);
  const bytes=Buffer.from(await(await fetch(base+`/api/export/${job.id}?kind=dist`)).arrayBuffer()),restored=inspectProjectPackage(bytes,app.store);assert.equal(restored.settings.homeBackground.loop,true);assert.ok(restored.settings.homeBackground.finalFrameAssetId);
  const source=JSON.parse(await readFile(path.join(app.dataDir,'releases',job.id,'source/site.json'),'utf8'));assert.equal(source.homeBackground.loop,true);
  const state=await api('/api/state');await api('/api/settings','PUT',{...state.settings,revision:state.settingsRevision,homeBackground:{...state.settings.homeBackground,loop:false}});assert.equal(app.store.get('settingsDraft').homeBackground.finalFrameAssetId,frame.id);
});

test('右侧草稿预览可折叠、切换设备，合并输入刷新且保留编辑器与已发布站点',async t=>{
  const f=await fixture(t,{fakeBuild:true}),{app,w,$,click,input,requests,errors,builds}=f,initialRelease=app.store.get('currentRelease'),initialLive=app.store.get('settingsLive');
  assert.equal($('#site-preview-panel').hidden,true);click('[data-action=toggle-site-preview]');assert.equal($('#site-preview-panel').hidden,false);assert.equal($('[data-action=toggle-site-preview]').getAttribute('aria-expanded'),'true');
  await until(()=>$('.site-preview-frame').getAttribute('src')?.startsWith('/preview/'),'自动生成预览');const frame=$('.site-preview-frame');assert.ok($('a[href="/site/"][target="_blank"]'));assert.equal($('[data-site-preview-link]').getAttribute('href'),frame.getAttribute('src'));
  click('[data-site-preview=desktop]');assert.equal(frame.style.width,'1280px');assert.equal(frame.style.height,'800px');assert.ok(frame.style.transform.includes('scale'));click('[data-site-preview=mobile]');assert.equal(frame.style.width,'100%');
  click('[data-nav=settings]');await until(()=>$('[data-setting=owner]'),'展示设置');const count=requests.length;
  for(const value of ['新','新的','新的预览姓名'])input('[data-setting=owner]',value);
  await until(()=>builds.at(-1)?.settings.owner==='新的预览姓名'&&$('#site-preview-status').textContent==='草稿预览已更新','停止输入后刷新');assert.equal(requests.length,count+1,'连续输入只生成一次预览');assert.equal($('.site-preview-frame'),frame,'页面重新渲染不替换预览iframe节点');assert.equal(app.store.get('settingsDraft').owner,'噼哩画啦','预览不自动保存设置');assert.deepEqual(app.store.get('settingsLive'),initialLive);assert.equal(app.store.get('currentRelease'),initialRelease);
  click('[data-action=save-settings]');await until(()=>app.store.get('settingsDraft').owner==='新的预览姓名','保存设置');click('[data-nav=works]');await until(()=>$('.works-table'),'作品列表');click('[data-action=edit]');await until(()=>$('.editor-overlay'),'作品编辑器');input('[data-field=title]','未发布的作品标题');
  await until(()=>requests.at(-1)?.project?.title==='未发布的作品标题'&&$('.site-preview-frame').getAttribute('src')?.includes('?work='),'编辑作品同步右侧详情');assert.equal($('.editor-shell').getAttribute('aria-modal'),'false');assert.equal($('.document-preview iframe'),null,'展开右侧栏时不重复加载编辑器中的旧预览');
  const after=requests.length;click('[data-site-preview=refresh]');await until(()=>requests.length>after&&$('#site-preview-status').textContent==='草稿预览已更新','手动刷新');
  click('[data-site-preview=close]');assert.equal($('#site-preview-panel').hidden,true);assert.equal(frame.getAttribute('src'),null,'收起后停止加载预览');assert.equal($('.editor-shell').getAttribute('aria-modal'),'true');input('[data-field=title]','收起时继续编辑');await pause(120);assert.equal(requests.length,after+1,'收起状态不生成预览');assert.deepEqual(errors,[]);assert.equal(app.store.get('currentRelease'),initialRelease);
});

test('实时预览临时缓存保留最近两份及当前画面，过期缓存清理不影响手动预览或外部依赖',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'pixix-sidebar-cache-'));await mkdir(path.join(directory,'previews'));const store=new Store(directory),outside=await mkdtemp(path.join(os.tmpdir(),'pixix-preview-external-'));await writeFile(path.join(outside,'keep.txt'),'保持不变');
  const client='client-a';for(let i=1;i<=5;i++){const id=`v-${i}-aaaaaaaa`,folder=path.join(directory,'previews',id);await mkdir(folder);await writeFile(path.join(folder,'sidebar-preview.json'),JSON.stringify({clientId:i===5?'old-client':client,createdAt:new Date(Date.now()-(5-i)*1000-(i===5?172800000:0)).toISOString()}));if(i===2)await symlink(outside,path.join(folder,'node_modules'),process.platform==='win32'?'junction':'dir');}
  await mkdir(path.join(directory,'previews/v-6-aaaaaaaa'));await writeFile(path.join(directory,'previews/v-6-aaaaaaaa/manual.txt'),'手动预览');
  const removed=await pruneSidebarPreviews(store,client,'v-1-aaaaaaaa');assert.deepEqual(new Set(removed),new Set(['v-2-aaaaaaaa','v-5-aaaaaaaa']));assert.deepEqual(new Set(await readdir(path.join(directory,'previews'))),new Set(['v-1-aaaaaaaa','v-3-aaaaaaaa','v-4-aaaaaaaa','v-6-aaaaaaaa']));assert.equal(await readFile(path.join(outside,'keep.txt'),'utf8'),'保持不变');await access(path.join(directory,'previews/v-6-aaaaaaaa/manual.txt'));store.close();
});

test('实时预览跳过过时结果，手动生成等待后台空闲，失败可重试且收起后不再更新',async t=>{
  const f=await fixture(t,{fakeBuild:true}),{app,w,$,click,input,requests,errors}=f;
  click('[data-action=toggle-site-preview]');await until(()=>app.publisher.busy,'第一版正在生成');click('[data-nav=settings]');await until(()=>$('[data-setting=owner]'),'设置页');input('[data-setting=owner]','生成期间的更新');
  await until(()=>$('#site-preview-status').textContent==='草稿预览已更新'&&requests.at(-1).settings.owner==='生成期间的更新','使用最新快照');assert.ok(requests.length>=2);assert.ok(!$('.site-preview-frame').getAttribute('src').includes([...app.publisher.jobs.values()].find(job=>job.sidebar)?.id+'/'),'过期结果不替换当前iframe');
  input('[data-setting=owner]','并发预览');await until(()=>app.publisher.busy,'自动预览占用生成器');const manual=await w.eval("api('/api/preview','POST',{})");assert.equal(manual.status,'running','手动预览等待自动任务后成功创建');await until(()=>!app.publisher.busy,'手动任务结束');
  const nativeFetch=w.fetch;let rejected=false;w.fetch=(url,options={})=>{if(url==='/api/preview'&&options.method==='POST'&&!rejected){rejected=true;return Promise.resolve(new w.Response(JSON.stringify({error:'预览测试失败'}),{status:400,headers:{'Content-Type':'application/json'}}));}return nativeFetch(url,options);};
  input('[data-setting=owner]','需要重试的预览');await until(()=>$('#site-preview-status').textContent.includes('预览测试失败'),'失败反馈');const failedCount=requests.length;await pause(100);assert.equal(requests.length,failedCount,'输入未变化时不重复生成失败快照');
  click('[data-site-preview=refresh]');await until(()=>$('#site-preview-status').textContent==='草稿预览已更新','刷新重试成功');
  input('[data-setting=owner]','关闭期间完成');await until(()=>app.publisher.busy,'收起前任务开始');click('[data-site-preview=close]');await until(()=>!app.publisher.busy,'已启动任务完成');assert.equal($('#site-preview-panel').hidden,true);assert.equal($('.site-preview-frame').getAttribute('src'),null);assert.deepEqual(errors,[]);
});
