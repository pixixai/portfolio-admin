import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,access,rename,readdir,symlink} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Window} from 'happy-dom';
import {Store} from '../lib/store.mjs';
import {releaseRetention,pruneReleases,recoverReleaseCleanup} from '../lib/release-retention.mjs';
import {createApplication,root} from '../server.mjs';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,label){for(let end=Date.now()+15000;Date.now()<end;){if(check())return;await pause(15);}throw new Error('等待超时：'+label);}
async function seed(store,count){
  await mkdir(path.join(store.directory,'uploads'),{recursive:true});
  for(let i=1;i<=count;i++){
    const id=`v-${String(i).padStart(2,'0')}`,dir=path.join(store.directory,'releases',id);
    await mkdir(path.join(dir,'source'),{recursive:true});await mkdir(path.join(dir,'dist'),{recursive:true});
    await writeFile(path.join(dir,'source/index.html'),id);await writeFile(path.join(dir,'dist/index.html'),id);
    store.db.prepare('INSERT INTO releases VALUES(?,?,?,?)').run(id,id,new Date(2026,0,i).toISOString(),JSON.stringify({settings:{},projects:[]}));
  }
  store.set('currentRelease',`v-${String(count).padStart(2,'0')}`);
}

test('保留数量包括当前版本，清理真实文件与历史引用，素材及目录外文件保留',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'pixix-retention-')),store=new Store(directory);await seed(store,12);assert.equal(releaseRetention(store),10);
  store.set('currentRelease','v-01');
  const asset=await store.addAsset(Buffer.from('original-media'),'原素材.png','image/png',{width:1,height:1},'png');
  store.db.prepare('UPDATE releases SET snapshot=? WHERE id=?').run(JSON.stringify({settings:{homeBackground:{videos:[{assetId:asset.id,playbackRate:1}]}},projects:[]}),'v-02');assert.ok(store.references(asset.id).inHistory);
  const external=await mkdtemp(path.join(os.tmpdir(),'pixix-retention-external-'));await writeFile(path.join(external,'keep.txt'),'必须保留');
  await symlink(external,path.join(directory,'releases/v-02/source/node_modules'),process.platform==='win32'?'junction':'dir');
  const result=await pruneReleases(store,5,true);assert.equal(result.removed.length,7);assert.equal(result.pending,0);assert.equal(store.releases().length,5);assert.ok(store.releases().some(row=>row.id==='v-01'));
  assert.deepEqual(store.releases().map(row=>row.id),['v-12','v-11','v-10','v-09','v-01']);await assert.rejects(access(path.join(directory,'releases/v-02')),error=>error.code==='ENOENT');assert.equal(await readFile(path.join(external,'keep.txt'),'utf8'),'必须保留');assert.equal((await readFile(path.join(directory,'uploads',asset.file))).toString(),'original-media');assert.equal(store.references(asset.id).inHistory,false);
  store.close();const reopened=new Store(directory);assert.equal(releaseRetention(reopened),5);assert.equal(reopened.releases().length,5);reopened.close();
});

test('中断恢复与数据库失败不损坏保留版本，拒绝超出数据目录的路径',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'pixix-retention-recovery-')),store=new Store(directory);await seed(store,8);const quarantine=path.join(directory,'.release-cleanup');await mkdir(quarantine);
  await rename(path.join(directory,'releases/v-01'),path.join(quarantine,'v-01'));await mkdir(path.join(quarantine,'v-orphan'));await writeFile(path.join(quarantine,'v-orphan/old.txt'),'待清理');
  await recoverReleaseCleanup(store);await access(path.join(directory,'releases/v-01/source/index.html'));assert.deepEqual(await readdir(quarantine),[]);
  const transaction=store.transaction;store.transaction=()=>{throw new Error('模拟数据库失败');};await assert.rejects(pruneReleases(store,5,true),/模拟数据库失败/);store.transaction=transaction;
  assert.equal(store.releases().length,8);assert.equal(releaseRetention(store),10);for(const row of store.releases())await access(path.join(directory,'releases',row.id,'dist/index.html'));assert.deepEqual(await readdir(quarantine),[]);
  store.db.prepare('INSERT INTO releases VALUES(?,?,?,?)').run('../outside','bad','2000-01-01',JSON.stringify({settings:{},projects:[]}));await assert.rejects(pruneReleases(store,5),/目录不正确/);assert.equal(store.releases().length,9);await access(path.join(directory,'releases/v-08/dist/index.html'));store.close();
});

test('发布自动保留10条，可切换5条；回退、失败保护、本机保护和管理界面一致',async t=>{
  const app=await createApplication({dataDir:await mkdtemp(path.join(os.tmpdir(),'pixix-retention-api-'))});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(()=>app.close());const base=`http://127.0.0.1:${app.server.address().port}`;let cookie='';
  async function api(url,method='GET',data,status=200,anonymous=false){const r=await fetch(base+url,{method,headers:{Cookie:anonymous?'':cookie,...(data===undefined?{}:{'Content-Type':'application/json'})},body:data===undefined?undefined:JSON.stringify(data)});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];const value=await r.json();assert.equal(r.status,status,JSON.stringify(value));return value;}
  assert.equal((await fetch(base+'/api/release-retention',{method:'PUT',headers:{Origin:'http://evil.invalid','Content-Type':'application/json'},body:JSON.stringify({keep:5})})).status,403);
  for(const keep of [0,6,'10',null])await api('/api/release-retention','PUT',{keep},400);
  app.publisher.busy=true;await api('/api/release-retention','PUT',{keep:5},409);app.publisher.busy=false;
  const original=(await api('/api/state')).currentRelease;
  app.publisher.build=async directory=>{await mkdir(path.join(directory,'dist'),{recursive:true});await mkdir(path.join(directory,'source'),{recursive:true});await writeFile(path.join(directory,'dist/index.html'),'发布副本');await writeFile(path.join(directory,'source/index.html'),'源文件');};
  async function job(value){await until(()=>app.publisher.jobs.get(value.id)?.status!=='running'&&!app.publisher.busy,'发布完成');assert.equal(app.publisher.jobs.get(value.id).status,'done');}
  for(let i=0;i<12;i++)await job(await api('/api/publish','POST',{projectIds:[],includeSettings:false},202));
  let state=await api('/api/state');assert.equal(state.releases.length,10);assert.equal(state.releaseRetention,10);assert.equal((await fetch(base+'/site/')).status,200);assert.equal((await fetch(base+'/history/'+original+'/',{headers:{Cookie:cookie}})).status,404);await api('/api/export/'+original, 'GET',undefined,404);
  const current=state.currentRelease,result=await api('/api/release-retention','PUT',{keep:5});assert.equal(result.removed.length,5);state=await api('/api/state');assert.equal(state.releases.length,5);assert.equal(state.currentRelease,current);
  const w=new Window({url:base,settings:{disableCSSFileLoading:true,disableJavaScriptFileLoading:true}});t.after(()=>w.happyDOM.abort());w.fetch=(url,options={})=>fetch(new URL(url,base),{...options,headers:{...options.headers,Cookie:cookie}});w.document.write(await readFile(path.join(root,'public/index.html'),'utf8'));w.eval((await Promise.all(['media-browser.js','editor.js','document-selection.js','document.js','spaces.js','app.js'].map(file=>readFile(path.join(root,'public',file),'utf8')))).join('\n'));
  await until(()=>w.document.querySelector('.works-table'),'后台');w.document.querySelector('[data-nav=releases]').click();await until(()=>w.document.querySelector('#release-retention'),'保留数量控件');assert.equal(w.document.querySelector('#release-retention').value,'5');assert.equal(w.document.querySelectorAll('.release-item').length,5);const control=w.document.querySelector('#release-retention');control.value='10';control.dispatchEvent(new w.Event('change',{bubbles:true}));await until(()=>app.store.get('releaseRetention')===10,'界面保存10条');
  await api('/api/release-retention','PUT',{keep:5});await job(await api('/api/rollback','POST',{id:app.store.releases().at(-1).id},202));assert.equal(app.store.releases().length,5);assert.notEqual(app.store.get('currentRelease'),current);
  const retained=app.store.releases().map(row=>row.id),live=app.store.get('currentRelease');app.publisher.build=async()=>{throw new Error('模拟构建失败');};const failure=await api('/api/publish','POST',{projectIds:[],includeSettings:false},202);await until(()=>app.publisher.jobs.get(failure.id).status==='failed','失败结果');assert.deepEqual(app.store.releases().map(row=>row.id),retained);assert.equal(app.store.get('currentRelease'),live);assert.equal((await fetch(base+'/site/')).status,200);await access(path.join(root,'node_modules/gsap/package.json'));
});
