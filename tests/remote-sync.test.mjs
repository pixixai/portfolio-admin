import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,copyFile,access,readdir,symlink} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createHash,randomUUID,generateKeyPairSync} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import ssh2 from 'ssh2';
import {Window} from 'happy-dom';
import {createApplication,root as projectRoot} from '../server.mjs';
import {remoteProfile,probeFingerprint,connectRemote} from '../lib/remote-sync.mjs';

const helper=path.join(projectRoot,'resources/remote-sync.py'),hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const {Server}=ssh2;
const profile={host:'example.com',port:22,username:'root',directory:'/www/wwwroot/pixixai.com',fingerprint:'SHA256:'+'a'.repeat(43)};
const manifest=files=>Object.fromEntries(Object.entries(files).map(([name,bytes])=>[name,{hash:hash(bytes),size:Buffer.byteLength(bytes)}]));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){for(const end=Date.now()+20000;Date.now()<end;){if(check())return;await pause(15);}throw new Error('等待部署超时');}
async function python(request,fault=''){
  const wrapper=`import importlib.util,json,os,sys\nspec=importlib.util.spec_from_file_location('sync',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\nr=json.load(sys.stdin);original=os.replace;fault=sys.argv[2]\ndef replace(a,b):\n if fault and a.endswith(os.sep+'upload'+os.sep+'index.html'):\n  if fault=='crash': os._exit(7)\n  raise OSError('simulated activation failure')\n return original(a,b)\nm.os.replace=replace\ntry: print(json.dumps({'ok':True,'result':m.execute(r)},ensure_ascii=False))\nexcept BaseException as e: print(json.dumps({'ok':False,'error':str(e)},ensure_ascii=False))`;
  return new Promise((resolve,reject)=>{
    const child=spawn(process.platform==='win32'?'python':'python3',['-X','utf8','-c',wrapper,helper,fault],{windowsHide:true,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});let stdout='',stderr='';
    child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);child.on('error',reject);child.on('close',()=>{try{const value=JSON.parse(stdout);if(!value.ok)throw new Error(value.error);resolve(value.result);}catch(error){reject(new Error(stdout?error.message:stderr||'remote interrupted'));}});child.stdin.end(JSON.stringify(request));
  });
}
async function fixture(){const base=await mkdtemp(path.join(os.tmpdir(),'pixix-remote-')),root=path.join(base,'site');await mkdir(root);return{base,root,rpc:input=>python({...input,root})};}
async function put(root,files){for(const [name,bytes]of Object.entries(files)){const file=path.join(root,...name.split('/'));await mkdir(path.dirname(file),{recursive:true});await writeFile(file,bytes);}}
async function stage(f,files){const entries=manifest(files),plan=await f.rpc({action:'plan',files:entries}),token=randomUUID(),begin=await f.rpc({action:'begin',files:entries,planHash:plan.hash,token});await put(begin.uploadDirectory,Object.fromEntries(plan.changed.map(name=>[name,files[name]])));return{plan,token,begin};}

test('配置拒绝系统目录与错误地址，只返回连接字段、不保存凭据',()=>{
  for(const directory of ['/','/www','/www/wwwroot','/etc','/www/../root','/www//site','relative','/www/.private'])assert.throws(()=>remoteProfile({...profile,directory}));
  for(const input of [{...profile,host:'x;whoami'},{...profile,username:'root;whoami'},{...profile,port:0},{...profile,fingerprint:'wrong'}])assert.throws(()=>remoteProfile(input));
  assert.deepEqual(remoteProfile({...profile,password:'secret',privateKey:'secret'}),profile);
});

test('首次按内容接管、增量只传变化文件、成功后清理失效文件，保留宝塔与未知文件',async()=>{
  const f=await fixture(),old={'index.html':'old','assets/keep.bin':'keep','assets/gone.bin':'gone','data/old.json':'{}'};
  await put(f.root,{...old,'.user.ini':'BT config','.well-known/acme-challenge/token':'certificate','notes.txt':'unmanaged'});
  const first=await stage(f,old);assert.equal(first.plan.firstSync,true);assert.deepEqual(first.plan.changed,[]);assert.deepEqual(first.plan.deleted,[]);await f.rpc({action:'apply',token:first.token});
  const files={'index.html':'new','assets/keep.bin':'keep','assets/new.bin':'new asset'},second=await stage(f,files);
  assert.deepEqual(new Set(second.plan.changed),new Set(['index.html','assets/new.bin']));assert.equal(second.plan.unchanged,1);assert.deepEqual(new Set(second.plan.deleted),new Set(['assets/gone.bin','data/old.json']));
  const result=await f.rpc({action:'apply',token:second.token});assert.equal(result.uploaded,2);assert.equal(result.deleted,2);assert.equal(result.uploadBytes,12);
  assert.equal(await readFile(path.join(f.root,'index.html'),'utf8'),'new');for(const name of ['.user.ini','.well-known/acme-challenge/token','notes.txt'])await access(path.join(f.root,name));
  for(const name of second.plan.deleted)await assert.rejects(access(path.join(f.root,name)),{code:'ENOENT'});
  const again=await f.rpc({action:'plan',files:manifest(files)});assert.equal(again.uploadBytes,0);assert.equal(again.changed.length,0);
  assert.deepEqual(await f.rpc({action:'status',token:second.token}),result);
  const folders=await readdir(path.dirname(f.root));assert.ok(folders.includes('.portfolio-admin-sync'));assert.equal(folders.includes('backup'),false);
});

test('外部修改的旧文件不自动删除，过期差异和损坏上传均不改变当前网站',async()=>{
  const f=await fixture(),old={'index.html':'old','old.txt':'old file'},first=await stage(f,old);await f.rpc({action:'apply',token:first.token});await put(f.root,{'old.txt':'external edit'});
  const files={'index.html':'new'},report=await f.rpc({action:'plan',files:manifest(files)});assert.deepEqual(report.deleted,[]);assert.deepEqual(report.preserved,['old.txt']);
  const broken=await stage(f,files);await put(broken.begin.uploadDirectory,{'index.html':'corrupt'});await assert.rejects(f.rpc({action:'apply',token:broken.token}),/校验失败/);assert.equal(await readFile(path.join(f.root,'index.html'),'utf8'),'old');
  const stale=await stage(f,files);await put(f.root,{'index.html':'external index'});await assert.rejects(f.rpc({action:'apply',token:stale.token}),/已变化/);assert.equal(await readFile(path.join(f.root,'index.html'),'utf8'),'external index');
  await f.rpc({action:'abort',token:broken.token});await f.rpc({action:'abort',token:stale.token});
});

test('更新中失败及进程中断可回退，旧媒体在成功激活之前不删除',async()=>{
  for(const fault of ['failure','crash']){
    const f=await fixture(),old={'index.html':'old','assets/existing.bin':'old media','assets/remove.bin':'retain until success'},first=await stage(f,old);await f.rpc({action:'apply',token:first.token});
    const files={'index.html':'new','assets/existing.bin':'changed media','assets/new.bin':'new media'},next=await stage(f,files);
    await assert.rejects(python({root:f.root,action:'apply',token:next.token},fault));
    // A new process recovers any incomplete journal before evaluating the next plan.
    await f.rpc({action:'plan',files:manifest(old)});
    for(const [name,bytes]of Object.entries(old))assert.equal(await readFile(path.join(f.root,name),'utf8'),bytes);
    await assert.rejects(access(path.join(f.root,'assets/new.bin')),{code:'ENOENT'});
  }
});

test('拒绝穿越、配置目录和符号链接，站点外文件不被读写或删除',async()=>{
  const f=await fixture();
  for(const name of ['../outside','/absolute','.well-known/token','assets/../file','assets\\file'])await assert.rejects(f.rpc({action:'plan',files:manifest({'index.html':'index',[name]:'x'})}));
  const outside=path.join(f.base,'outside');await mkdir(outside);await writeFile(path.join(outside,'secret'),'preserve');await symlink(outside,path.join(f.root,'assets'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(f.rpc({action:'plan',files:manifest({'index.html':'index','assets/secret':'x'})}),/符号链接/);assert.equal(await readFile(path.join(outside,'secret'),'utf8'),'preserve');
});

test('私密发布命名空间写到站点外并随事务回退，公开目录始终没有访问码与私密原件',async()=>{
  const f=await fixture(),privateRoot=path.join(f.base,'.portfolio-spaces',hash(f.root).slice(0,20));
  const old={'index.html':'public only','_portfolio_private/catalog.json':'old verifier','_portfolio_private/spaces/s-example/media.bin':'private media'};
  const first=await stage(f,old);await f.rpc({action:'apply',token:first.token});
  await assert.rejects(access(path.join(f.root,'_portfolio_private')),{code:'ENOENT'});assert.equal(await readFile(path.join(privateRoot,'catalog.json'),'utf8'),'old verifier');
  const next=await stage(f,{'index.html':'new public','_portfolio_private/catalog.json':'new verifier','_portfolio_private/new.bin':'new media'});await assert.rejects(python({root:f.root,action:'apply',token:next.token},'failure'));
  await f.rpc({action:'plan',files:manifest(old)});assert.equal(await readFile(path.join(privateRoot,'catalog.json'),'utf8'),'old verifier');assert.equal(await readFile(path.join(privateRoot,'spaces/s-example/media.bin'),'utf8'),'private media');
  const update=await stage(f,{'index.html':'new public','_portfolio_private/catalog.json':'new verifier'});await f.rpc({action:'apply',token:update.token});await assert.rejects(access(path.join(privateRoot,'spaces/s-example/media.bin')),{code:'ENOENT'});assert.equal(await readFile(path.join(privateRoot,'catalog.json'),'utf8'),'new verifier');
});

test('SSH指纹先验证再发送凭据，指纹改变拒绝连接，RPC参数通过stdin传递',async t=>{
  const key=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs1',format:'pem'});let authentications=0,received,uploaded=Buffer.alloc(0),uploadPath;
  const server=new Server({hostKeys:[key]},client=>{
    client.on('error',()=>{});client.on('authentication',context=>{authentications++;context.method==='password'&&context.password==='secret'?context.accept():context.reject(['password']);});
    client.on('ready',()=>client.on('session',accept=>{
      const session=accept();
      session.on('exec',(accept,reject,info)=>{assert.ok(info.command.startsWith("PYTHONIOENCODING=utf-8 python3 -c '"));assert.equal(info.command.includes('/www/wwwroot/pixixai.com'),false);const stream=accept();let input='';stream.on('data',chunk=>input+=chunk);stream.on('end',()=>{received=JSON.parse(input);stream.exit(0);stream.end(JSON.stringify({ok:true,result:{checked:true}}));});});
      session.on('sftp',accept=>{
        const stream=accept();stream.on('OPEN',(id,file)=>{uploadPath=file;stream.handle(id,Buffer.from([1]));});
        stream.on('WRITE',(id,handle,offset,data)=>{const bytes=Buffer.alloc(Math.max(uploaded.length,offset+data.length));uploaded.copy(bytes);data.copy(bytes,offset);uploaded=bytes;stream.status(id,0);});
        stream.on('CLOSE',id=>stream.status(id,0));
      });
    }));
  });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const config={...profile,host:'127.0.0.1',port:server.address().port},found=await probeFingerprint(config);assert.match(found.fingerprint,/^SHA256:/);assert.equal(authentications,0);
  await assert.rejects(connectRemote(config,{password:'secret'}),/指纹发生变化/);assert.equal(authentications,0);
  const connection=await connectRemote({...config,...found},{password:'secret'});try{
    assert.deepEqual(await connection.rpc({action:'plan',root:config.directory}),{checked:true});assert.equal(received.root,config.directory);
    const folder=await mkdtemp(path.join(os.tmpdir(),'pixix-sftp-')),file=path.join(folder,'new.bin'),bytes=Buffer.from('real SFTP incremental upload');await writeFile(file,bytes);let progress=0;
    await connection.upload([{file,name:'new.bin',size:bytes.length}],'/private-stage',(name,transferred)=>progress=transferred);
    assert.deepEqual(uploaded,bytes);assert.equal(uploadPath,'/private-stage/new.bin');assert.equal(progress,bytes.length);
  }finally{connection.close();}
});

test('管理接口执行真实文件差异流程，部署凭据不落盘，失败上传不变更站点',async t=>{
  const f=await fixture();let failUpload=false,dropReply=false;const sent=[];
  const app=await createApplication({dataDir:path.join(f.base,'user'),remoteOptions:{probe:async()=>({fingerprint:profile.fingerprint}),connect:async()=>({async rpc(request){const result=await f.rpc(request);if(request.action==='apply'&&dropReply){dropReply=false;throw new Error('reply lost');}return result;},async upload(files,directory,progress){if(failUpload)throw new Error('upload interrupted');for(const file of files){sent.push(file.name);await copyFile(file.file,path.join(directory,...file.name.split('/')));progress(file.name,file.size);}},close(){}})}});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(()=>app.close());const base=`http://127.0.0.1:${app.server.address().port}`;
  async function api(url,method='GET',data){const response=await fetch(base+url,{method,headers:data?{'Content-Type':'application/json'}:{},body:data?JSON.stringify(data):undefined});const value=await response.json();assert.ok(response.ok,JSON.stringify(value));return value;}
  const releaseId=app.store.get('currentRelease'),input={profile,credentials:{password:'test-secret-do-not-store'},releaseId};
  const plan=await api('/api/remote/plan','POST',input);const job=await api('/api/remote/deploy','POST',{planId:plan.id,credentials:input.credentials});await until(()=>app.remoteSync.jobs.get(job.id).status!=='running');assert.equal(app.remoteSync.jobs.get(job.id).status,'done',app.remoteSync.jobs.get(job.id).message);assert.equal(sent.length,plan.changed.length);
  assert.equal(JSON.stringify(app.store.get('remoteDeployment')).includes('test-secret'),false);assert.equal(JSON.stringify(await api('/api/remote')).includes('test-secret'),false);
  const again=await api('/api/remote/plan','POST',input);assert.equal(again.changed.length,0);assert.equal(again.uploadBytes,0);
  dropReply=true;const confirmed=await api('/api/remote/deploy','POST',{planId:again.id,credentials:input.credentials});await until(()=>app.remoteSync.jobs.get(confirmed.id).status!=='running');assert.equal(app.remoteSync.jobs.get(confirmed.id).status,'done');
  const oldProject=app.store.projects()[0],publishing=await api('/api/projects/'+oldProject.id+'/unpublish','POST',{});await until(()=>app.publisher.jobs.get(publishing.id).status!=='running');assert.equal(app.publisher.jobs.get(publishing.id).status,'done');
  const changedInput={...input,releaseId:app.store.get('currentRelease')},changed=await api('/api/remote/plan','POST',changedInput);assert.ok(changed.changed.length>0);assert.ok(changed.deleted.some(name=>name.includes(oldProject.draft.folder)));
  const before=await readFile(path.join(f.root,'index.html'));failUpload=true;const failure=await api('/api/remote/deploy','POST',{planId:changed.id,credentials:input.credentials});await until(()=>app.remoteSync.jobs.get(failure.id).status!=='running');assert.equal(app.remoteSync.jobs.get(failure.id).status,'failed');assert.deepEqual(await readFile(path.join(f.root,'index.html')),before);
  failUpload=false;const retry=await api('/api/remote/plan','POST',changedInput),updated=await api('/api/remote/deploy','POST',{planId:retry.id,credentials:input.credentials});await until(()=>app.remoteSync.jobs.get(updated.id).status!=='running');assert.equal(app.remoteSync.jobs.get(updated.id).status,'done');assert.ok(app.remoteSync.jobs.get(updated.id).result.deleted>0);
});

test('部署面板显示差异与清理列表，凭据在禁用控件后仍可提交，成功后清空凭据',async t=>{
  const w=new Window({url:'http://127.0.0.1:4180/'});t.after(()=>w.happyDOM.abort());w.eval(await readFile(path.join(projectRoot,'public/remote-sync.js'),'utf8'));const calls=[];
  const esc=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const api=async(url,method,data)=>{calls.push({url,data});if(url==='/api/remote')return{profile,job:null};if(url.endsWith('fingerprint'))return{fingerprint:profile.fingerprint};if(url.endsWith('plan')){assert.equal(data.credentials.password,'secret');return{id:'plan',changed:['index.html'],deleted:['old.png'],preserved:[],unchanged:2,uploadBytes:12,firstSync:false};}if(url.endsWith('deploy')){assert.equal(data.credentials.password,'secret');return{id:'job',status:'done',message:'部署成功',result:{uploaded:1,deleted:1,unchanged:2,uploadBytes:12}};}throw new Error(url);};
  await w.PortfolioRemoteSync.open({api,esc,openDialog:html=>w.document.body.innerHTML=html,modalHead:()=>'',btn:label=>`<button type="button">${label}</button>`,sizeLabel:bytes=>bytes+'B',releaseId:'release'});
  const form=w.document.querySelector('form');form.elements.namedItem('password').value='secret';form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await until(()=>!form.querySelector('[data-remote=deploy]').disabled);
  assert.ok(form.querySelector('.remote-plan').textContent.includes('old.png'));form.querySelector('[data-remote=deploy]').click();await until(()=>form.querySelector('.remote-job').textContent.includes('清理1个'));assert.equal(form.elements.namedItem('password').value,'');assert.ok(calls.some(call=>call.url==='/api/remote/deploy'));
});

test('发布与导出入口能打开真实部署面板，连接信息与密码输入不串入作品发布',async t=>{
  const f=await fixture(),app=await createApplication({dataDir:path.join(f.base,'user')});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(()=>app.close());
  const base=`http://127.0.0.1:${app.server.address().port}`,w=new Window({url:base,settings:{disableCSSFileLoading:true,disableJavaScriptFileLoading:true,disableIframePageLoading:true}});t.after(()=>w.happyDOM.abort());
  const errors=[];w.addEventListener('error',event=>errors.push(event.message));w.fetch=(url,options)=>fetch(new URL(url,base),options);w.document.write(await readFile(path.join(projectRoot,'public/index.html'),'utf8'));
  w.eval((await Promise.all(['media-browser.js','editor.js','document-selection.js','document.js','remote-sync.js','spaces.js','app.js'].map(file=>readFile(path.join(projectRoot,'public',file),'utf8')))).join('\n'));
  await until(()=>w.document.querySelector('[data-action=publish-dialog]'));w.document.querySelector('[data-action=publish-dialog]').click();await until(()=>w.document.querySelector('#publish-form'));
  w.document.querySelector('[data-action=remote-sync]').click();await until(()=>w.document.querySelector('#remote-sync-form'));
  assert.equal(w.document.querySelector('[name=directory]').value,'/www/wwwroot/pixixai.com');assert.ok(w.document.querySelector('[name=password]'));assert.deepEqual(errors,[]);
});
