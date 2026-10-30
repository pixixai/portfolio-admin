import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, cp, access } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { resolveRuntimeData, legacyDataDirectory } from '../lib/runtime-data.mjs';
import { openDefaultBrowser } from '../lib/launch.mjs';
import { createApplication, startApplication } from '../server.mjs';

test('本地 user 优先，显式数据目录不迁移，旧路径仍能正确定位',async()=>{
  const project=await mkdtemp(path.join(os.tmpdir(),'pixix-data-path-')),legacy=path.join(project,'old'),target=path.join(project,'user');
  const key=createHash('sha256').update(project).digest('hex').slice(0,10);
  assert.equal(legacyDataDirectory(project,{LOCALAPPDATA:project}),path.join(project,'PixixPortfolioAdmin',key));
  assert.equal(await resolveRuntimeData(project,{env:{},legacyDirectory:legacy}),target);
  await mkdir(target);await writeFile(path.join(target,'portfolio.sqlite'),'existing');
  assert.equal(await resolveRuntimeData(project,{env:{},legacyDirectory:legacy}),target);
  const override=path.join(project,'custom');assert.equal(await resolveRuntimeData(project,{env:{PORTFOLIO_DATA_DIR:override},legacyDirectory:legacy}),override);
  assert.equal(await resolveRuntimeData(project,{dataDir:legacy,env:{PORTFOLIO_DATA_DIR:override}}),legacy);
});

test('旧数据库的 WAL 已提交内容可迁入 user，源数据不删，迁移失败不激活残缺数据',async()=>{
  const project=await mkdtemp(path.join(os.tmpdir(),'pixix-data-wal-')),legacy=path.join(project,'old');await mkdir(legacy);
  const db=new DatabaseSync(path.join(legacy,'portfolio.sqlite'));
  try {
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE saved(value TEXT); INSERT INTO saved VALUES (\'保留 WAL 中的作品\');');
    const target=await resolveRuntimeData(project,{env:{},legacyDirectory:legacy});
    const copied=new DatabaseSync(path.join(target,'portfolio.sqlite'));try{assert.equal(copied.prepare('SELECT value FROM saved').get().value,'保留 WAL 中的作品');}finally{copied.close();}
    assert.equal(db.prepare('SELECT value FROM saved').get().value,'保留 WAL 中的作品');
    await access(path.join(legacy,'portfolio.sqlite'));assert.equal((await readdir(project)).some(name=>name.startsWith('.user-migration-')),false);
  } finally {db.close();}
  const broken=await mkdtemp(path.join(os.tmpdir(),'pixix-data-broken-')),old=path.join(broken,'old');await mkdir(old);await writeFile(path.join(old,'portfolio.sqlite'),'broken database');
  await assert.rejects(resolveRuntimeData(broken,{env:{},legacyDirectory:old}));assert.equal((await readdir(broken)).includes('user'),false);assert.equal((await readdir(broken)).some(name=>name.startsWith('.user-migration-')),false);
  await mkdir(path.join(broken,'user'));await writeFile(path.join(broken,'user','keep.txt'),'保留');
  await assert.rejects(resolveRuntimeData(broken,{env:{},legacyDirectory:old}),/已有内容/);assert.equal(await readFile(path.join(broken,'user','keep.txt'),'utf8'),'保留');
});

test('完整运行数据迁移与跨项目复制保留草稿、设置、原件和已发布站点',async t=>{
  const project=await mkdtemp(path.join(os.tmpdir(),'pixix-data-move-')),legacy=path.join(project,'old');
  const original=await createApplication({dataDir:legacy});
  const settings={...original.store.get('settingsDraft'),owner:'迁移前的姓名'};original.store.set('settingsDraft',settings);
  original.store.createProject({id:'portable-draft',folder:'portable-draft',title:'未发布的草稿',order:0,blocks:[{id:'body',type:'text',text:'完整迁移正文'}]});
  const asset=original.store.media()[0],bytes=await readFile(path.join(legacy,'uploads',asset.file)),release=original.store.get('currentRelease');
  await original.close();
  const target=await resolveRuntimeData(project,{env:{},legacyDirectory:legacy});
  const other=await mkdtemp(path.join(os.tmpdir(),'pixix-data-other-'));await cp(target,path.join(other,'user'),{recursive:true});
  const restored=await createApplication({dataDir:await resolveRuntimeData(other,{env:{},legacyDirectory:path.join(other,'missing')})});
  await new Promise(resolve=>restored.server.listen(0,'127.0.0.1',resolve));t.after(()=>restored.close());
  assert.deepEqual(restored.store.get('settingsDraft'),settings);assert.equal(restored.store.project('portable-draft').draft.blocks[0].text,'完整迁移正文');
  assert.equal(restored.store.get('currentRelease'),release);assert.deepEqual(await readFile(path.join(other,'user','uploads',asset.file)),bytes);
  const url=`http://127.0.0.1:${restored.server.address().port}`;assert.equal((await fetch(url+'/site/')).status,200);assert.equal((await fetch(url+'/user/portfolio.sqlite')).status,404);
});

test('启动完成且接口可访问后才打开浏览器，端口占用时不创建运行数据',async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'pixix-startup-'));let request;
  const app=await startApplication({port:0,dataDir:path.join(directory,'ready'),openBrowser:true,browserOpener:url=>{request=fetch(url+'api/state');}});t.after(()=>app.close());
  assert.equal((await request).status,200);
  const blocker=net.createServer();await new Promise(resolve=>blocker.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>blocker.close(resolve)));
  const unopened=path.join(directory,'unopened');await assert.rejects(startApplication({port:blocker.address().port,dataDir:unopened,openBrowser:true,browserOpener:()=>assert.fail('不应打开浏览器')}),{code:'EADDRINUSE'});
  await assert.rejects(access(unopened),{code:'ENOENT'});
});

test('默认浏览器通过系统协议打开，启动失败保留手动地址',()=>{
  const calls=[],warnings=[];let child;
  openDefaultBrowser('http://127.0.0.1:4180/',{platform:'win32',launch:(...args)=>{calls.push(args);child=new EventEmitter();child.unref=()=>{};return child;},warn:message=>warnings.push(message)});
  assert.equal(calls[0][0],'rundll32.exe');assert.deepEqual(calls[0][1],['url.dll,FileProtocolHandler','http://127.0.0.1:4180/']);assert.equal(calls[0][2].windowsHide,true);
  child.emit('error',new Error('no handler'));assert.ok(warnings[0].includes('http://127.0.0.1:4180/'));
});
