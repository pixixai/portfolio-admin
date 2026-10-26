import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,open,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Window} from 'happy-dom';
import {createApplication,root} from '../server.mjs';
import {deploymentTarget,deploymentReport,deploymentPackage} from '../lib/deployment.mjs';
import {readZip,zipEntries} from '../lib/zip.mjs';
import {inspectProjectPackage,restorePath} from '../lib/project-package.mjs';
const MB=1024*1024,pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,label){for(let end=Date.now()+20000;Date.now()<end;){if(check())return;await pause(20);}throw new Error('等待超时：'+label);}

test('平台配置与配额在边界检查，通用包不套用云平台限制',()=>{
  assert.deepEqual(deploymentTarget(),{platform:'generic',projectName:'portfolio-site'});
  for(const input of [null,[],{platform:'unknown'},{platform:'esa',projectName:'../x'},{platform:'esa',projectName:'A'},{platform:'esa',projectName:'a--b'},{platform:'esa',projectName:'a-'}])assert.throws(()=>deploymentTarget(input));
  const files=[{name:'index.html',size:1},{name:'assets/video.mp4',displayName:'背景原片.mp4',size:25*MB}];
  assert.deepEqual(deploymentReport(files,{platform:'esa'}).errors,[]);
  files[1].size++;assert.match(deploymentReport(files,{platform:'edgeone'}).errors.join(''),/背景原片.mp4.*25 MB/);
  assert.deepEqual(deploymentReport(files).errors,[]);
  assert.match(deploymentReport([{name:'public/index.html',size:1}],{platform:'esa'}).errors.join(''),/index.html/);
  assert.match(deploymentReport([{name:'index.html',size:1},{name:'a?.png',size:1}],{platform:'edgeone'}).errors.join(''),/文件名/);
  assert.match(deploymentReport([{name:'index.html',size:1},{name:'INDEX.HTML',size:1}]).errors.join(''),/重复/);
  assert.match(deploymentReport([{name:'index.html',size:1},{name:'edgeone.json',size:1}],{platform:'edgeone'}).errors.join(''),/自定义配置/);
  const count=n=>Array.from({length:n},(_,i)=>({name:i?'assets/'+i+'.png':'index.html',size:1}));
  assert.deepEqual(deploymentReport(count(19998),{platform:'edgeone'}).errors,[]);
  assert.match(deploymentReport(count(19999),{platform:'edgeone'}).errors.join(''),/20000/);
  assert.deepEqual(deploymentReport(count(2000),{platform:'esa'}).errors,[]);
  assert.match(deploymentReport(count(2001),{platform:'esa'}).errors.join(''),/2000/);
  assert.match(deploymentReport(count(50).map(file=>({...file,size:25*MB})),{platform:'esa'}).errors.join(''),/1024 MB/);
  assert.throws(()=>zipEntries([{name:'../bad',bytes:Buffer.from('x')}]));
  assert.throws(()=>zipEntries([{name:'x',bytes:Buffer.from('x')},{name:'X',bytes:Buffer.from('y')}]));
});

test('三种部署包目录、配置、字节统计与恢复数据一致，历史导出不更改发布记录',async t=>{
  const app=await createApplication({dataDir:await mkdtemp(path.join(os.tmpdir(),'pixix-platform-'))});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(()=>app.close());
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const request=async(url,method='GET',data,status=200)=>{const response=await fetch(base+url,{method,headers:data===undefined?{}:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});const value=await response.json();assert.equal(response.status,status,JSON.stringify(value));return value;};
  const initial=await request('/api/state');assert.equal(initial.capabilities.platformExport,true);assert.equal(initial.deploymentPlatforms.length,3);
  const publish=await request('/api/publish','POST',{projectIds:initial.projects.map(row=>row.id),includeSettings:true,deployment:{platform:'esa',projectName:'pixix-gallery'}},202);
  await until(()=>app.publisher.jobs.get(publish.id).status!=='running','ESA发布');assert.equal(app.publisher.jobs.get(publish.id).status,'done',app.publisher.jobs.get(publish.id).message);
  const state=await request('/api/state');assert.equal(state.deploymentTarget.platform,'esa');assert.equal(state.releases[0].deployment.projectName,'pixix-gallery');
  let original;
  for(const platform of ['generic','edgeone','esa']){
    const query=`/api/export/${publish.id}?platform=${platform}&projectName=pixix-gallery`,report=await request(query+'&check=1');assert.deepEqual(report.errors,[]);
    const response=await fetch(base+query),bytes=Buffer.from(await response.arrayBuffer()),entries=readZip(bytes);
    assert.equal(response.status,200);assert.match(response.headers.get('content-disposition'),new RegExp(platform==='generic'?'portfolio-dist-':'portfolio-'+platform+'-'));
    assert.equal(report.packageSize,bytes.length);
    const prefix=platform==='esa'?'public/':'';assert.ok(entries.has(prefix+'index.html'));assert.ok(entries.has(prefix+restorePath));
    assert.equal(entries.has('esa.jsonc'),platform==='esa');assert.equal(entries.has('edgeone.json'),platform==='edgeone');
    if(platform==='esa'){assert.equal(entries.has('index.html'),false);const config=JSON.parse(entries.get('esa.jsonc').read());assert.deepEqual(config,{name:'pixix-gallery',installCommand:'',buildCommand:'',assets:{directory:'./public',notFoundStrategy:'singlePageApplication'}});assert.match(entries.get('DEPLOY.md').read().toString(),/先解压/);}
    if(platform==='edgeone'){const config=JSON.parse(entries.get('edgeone.json').read());assert.equal(config.headers[0].headers[0].key,'Cache-Control');}
    const restored=inspectProjectPackage(bytes,app.store);assert.equal(restored.projects.length,2);
    const values=JSON.stringify({projects:restored.projects,settings:restored.settings,assets:restored.assets.map(asset=>({id:asset.id,hash:asset.hash}))});
    if(original)assert.equal(values,original);else original=values;
    if(platform==='esa'){
      const ambiguous=zipEntries([...entries].map(([name,entry])=>({name,bytes:entry.read()})).concat({name:restorePath,bytes:entries.get(prefix+restorePath).read()}));
      assert.throws(()=>inspectProjectPackage(ambiguous,app.store),/多个|不明确|描述/);
    }
  }
  const saved=await fetch(base+`/api/export/${publish.id}`);assert.match(saved.headers.get('content-disposition'),/portfolio-esa-/);await saved.arrayBuffer();
  const source=await fetch(base+`/api/export/${publish.id}?kind=source`),sourceEntries=readZip(Buffer.from(await source.arrayBuffer()));assert.ok(sourceEntries.has('scripts/build.mjs'));assert.equal(sourceEntries.has('esa.jsonc'),false);
  for(const query of ['platform=bad','platform=esa&projectName=Bad'])await request(`/api/export/${publish.id}?${query}`, 'GET',undefined,400);
  await request('/api/publish','POST',{projectIds:[],includeSettings:true,deployment:{platform:'invalid'}},400);
  assert.deepEqual((await request('/api/state')).releases,state.releases);assert.equal(app.store.get('currentRelease'),publish.id);

  // DOM exercises the real API while keeping actual local user data untouched.
  const w=new Window({url:base,settings:{disableCSSFileLoading:true,disableJavaScriptFileLoading:true,disableIframePageLoading:true}});t.after(()=>w.happyDOM.abort());
  const errors=[];w.addEventListener('error',event=>errors.push(event.message));w.fetch=(url,options)=>fetch(new URL(url,base),options);
  w.document.write(await readFile(path.join(root,'public/index.html'),'utf8'));w.eval((await Promise.all(['media-browser.js','editor.js','document-selection.js','document.js','app.js'].map(file=>readFile(path.join(root,'public',file),'utf8')))).join('\n'));
  const $=selector=>w.document.querySelector(selector);
  await until(()=>$('[data-action=publish-dialog]'),'发布入口');$('[data-action=publish-dialog]').click();await until(()=>$('#publish-form'),'发布面板');
  const select=$('[data-deployment-platform]');assert.equal(select.querySelector('[selected]').value,'esa');assert.equal($('.esa-project-field').hidden,false);
  select.value='edgeone';select.dispatchEvent(new w.Event('change',{bubbles:true}));assert.equal($('.esa-project-field').hidden,true);assert.match($('.deployment-description').textContent,/20000/);
  $('[data-action=close-dialog]').click();$('[data-nav=releases]').click();await until(()=>$('[data-action=export-release]'),'发布记录');$('[data-action=export-release]').click();
  await until(()=>$('#export-form'),'历史导出');$('[data-deployment-platform]').value='esa';$('#export-form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await until(()=>$('.deployment-report a'),'预检下载');assert.match($('.deployment-report a').getAttribute('href'),/platform=esa/);
  assert.match($('.deployment-report').textContent,/解压/);assert.deepEqual(errors,[]);assert.deepEqual((await request('/api/state')).releases,state.releases);
  $('[data-action=close-dialog]').click();$('[data-action=publish-dialog]').click();await until(()=>$('#publish-form'),'再次发布');
  $('[data-deployment-platform]').value='edgeone';$('[data-deployment-platform]').dispatchEvent(new w.Event('change',{bubbles:true}));$('#publish-form [name=settings]').checked=true;
  $('#publish-form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await until(()=>$('#dialog a[href*="platform=edgeone"]'),'发布完成下载');
  assert.equal((await request('/api/state')).deploymentTarget.platform,'edgeone');assert.deepEqual(errors,[]);
});

test('云平台超限时阻止发布和下载，保留当前站点与设置；通用导出仍可检查',async t=>{
  const app=await createApplication({dataDir:await mkdtemp(path.join(os.tmpdir(),'pixix-platform-reject-'))});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(()=>app.close());
  const base=`http://127.0.0.1:${app.server.address().port}`,current=app.store.get('currentRelease'),releases=app.store.releases(),live=JSON.stringify(app.store.get('settingsLive'));
  app.publisher.build=async directory=>{await mkdir(path.join(directory,'dist'),{recursive:true});await writeFile(path.join(directory,'dist/index.html'),'test');const file=await open(path.join(directory,'dist/oversized.mp4'),'w');try{await file.truncate(25*MB+1);}finally{await file.close();}};
  const response=await fetch(base+'/api/publish',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({projectIds:[],includeSettings:true,deployment:{platform:'edgeone'}})}),job=await response.json();assert.equal(response.status,202);
  await until(()=>app.publisher.jobs.get(job.id).status!=='running','超限发布');assert.equal(app.publisher.jobs.get(job.id).status,'failed');assert.match(app.publisher.jobs.get(job.id).message,/oversized.mp4.*25 MB/);
  assert.equal(app.store.get('currentRelease'),current);assert.deepEqual(app.store.releases(),releases);assert.equal(JSON.stringify(app.store.get('settingsLive')),live);assert.equal(app.store.get('deploymentTarget'),null);
  const directory=path.join(app.dataDir,'jobs',job.id,'dist');await assert.rejects(deploymentPackage(directory,{platform:'esa'}),/25 MB/);
  const report=deploymentReport([{name:'index.html',size:4},{name:'oversized.mp4',size:25*MB+1}]);assert.deepEqual(report.errors,[]);
});
