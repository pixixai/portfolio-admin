import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Window} from 'happy-dom';
import {createApplication,root} from '../server.mjs';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,label){const deadline=Date.now()+12000;while(Date.now()<deadline){if(check())return;await pause(20);}throw new Error('等待超时：'+label);}

test('素材三种布局Shift正反向连选、复选框和标签点击、筛选边界与插入和封面回调',async t=>{
  const app=await createApplication({dataDir:await mkdtemp(path.join(os.tmpdir(),'pixix-media-range-'))});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(()=>app.close());
  const seedImage=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HA4CAAAAC0lEQVR42mP8/x8AAusB9Wl6XFAAAAAASUVORK5CYII=','base64');
  for(let i=0;i<8;i++){const asset=await app.store.addAsset(Buffer.concat([seedImage,Buffer.from('fixture-'+i)]),'选择测试-'+i+'.png','image/png',{width:1,height:1},'png');app.store.db.prepare('UPDATE media SET createdAt=? WHERE id=?').run('2000-01-01T00:00:00.000Z',asset.id);}
  const base=`http://127.0.0.1:${app.server.address().port}`;let cookie='';
  async function api(url,method='GET',data){const r=await fetch(base+url,{method,headers:{Cookie:cookie,...(data===undefined?{}:{'Content-Type':'application/json'})},body:data===undefined?undefined:JSON.stringify(data)});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];assert.ok(r.ok);return r.json();}
  
  await api('/api/media/folders','POST',{name:'连选目录一'});await api('/api/media/folders','POST',{name:'连选目录二'});
  const project=await api('/api/projects','POST',{title:'Shift连选插入',labels:[],blocks:[]});
  const w=new Window({url:base,settings:{disableCSSFileLoading:true,disableJavaScriptFileLoading:true,disableIframePageLoading:true}}),errors=[];
  t.after(()=>w.happyDOM.abort());w.fetch=(url,options={})=>fetch(new URL(url,base),{...options,headers:{...options.headers,Cookie:cookie}});w.addEventListener('error',event=>errors.push(event.message));
  w.document.write(await readFile(path.join(root,'public/index.html'),'utf8'));
  w.eval((await Promise.all(['media-browser.js','editor.js','document-selection.js','document.js','app.js'].map(file=>readFile(path.join(root,'public',file),'utf8')))).join('\n'));
  const $=s=>w.document.querySelector(s),$$=s=>[...w.document.querySelectorAll(s)];
  const rows=()=>$$('.media-browser [data-media-key]').map(node=>node.dataset.mediaKey);
  const assets=()=>rows().filter(key=>key.startsWith('asset:'));
  const node=key=>$(`.media-browser [data-media-key="${key}"]`);
  const checked=()=>$$('.media-browser [data-media-select]:checked').map(input=>input.dataset.mediaSelect);
  const click=(el,shiftKey=false)=>el.dispatchEvent(new w.MouseEvent('click',{bubbles:true,cancelable:true,shiftKey}));
  const box=(key,shift=false,label=false)=>{const input=node(key).querySelector('[data-media-select]');click(label?input.parentElement:input,shift);};
  const selected=expected=>assert.deepEqual(new Set(checked()),new Set(expected));
  const clear=()=>{if($('[data-media-action=clear-selection]'))$('[data-media-action=clear-selection]').click();};
  const change=(el,value)=>{el.value=value;el.dispatchEvent(new w.Event('change',{bubbles:true}));};
  const layout=mode=>{
    $(`[data-media-action=view][data-mode=${mode==='grid'?'grid':'list'}]`).click();
    const toggle=$('[data-media-compact]');if(toggle&&toggle.checked!==(mode==='compact')){toggle.checked=mode==='compact';toggle.dispatchEvent(new w.Event('change',{bubbles:true}));}
  };
  async function checkLayouts(picking){
    for(const mode of ['grid','list','compact']){
      clear();layout(mode);const keys=assets();assert.ok(keys.length>=8);
      box(keys[7]);box(keys[2]);click(node(keys[4]),true);selected([keys[7],...keys.slice(2,5)]);
      click(node(keys[0]),true);selected([keys[7],...keys.slice(0,5)]);
      click(node(keys[5]));box(keys[6],true,true);selected(keys.slice(0,8));
      assert.equal($('#media-preview-dialog')?.open||false,false,'多选连选不打开预览');
      clear();box(keys[1]);box(keys[3],true);selected(keys.slice(1,4));
      // Switching layouts preserves both the selection and its range anchor.
      layout(mode==='grid'?'list':'grid');click(node(keys[4]),true);selected(keys.slice(1,5));layout(mode);
      if(picking)assert.ok($('[data-action=use-media]').textContent.includes('4'),'连选同步用于插入的媒体');
    }
  }
  await until(()=>$('.works-table'),'后台加载');$('[data-nav=media]').click();await until(()=>$('.media-browser'),'素材库');
  await checkLayouts(false);
  clear();layout('list');change($('[data-media-sort]'),'name');$('.media-list [data-sort=name]').click();assert.equal($('.media-list [data-sort=name]').closest('th').getAttribute('aria-sort'),'descending');
  const ordered=rows();box(ordered[1]);click(node(ordered[4]),true);selected(ordered.slice(1,5));assert.equal($('.media-breadcrumbs [data-folder=""]').textContent.includes('全部素材'),true,'Shift点击文件夹不会进入目录');
  clear();const before=assets()[0];box(before);change($('[data-media-filter]'),'folders');const folderKeys=rows();click(node(folderKeys[1]),true);selected([folderKeys[1]]);change($('[data-media-filter]'),'all');selected([before,folderKeys[1]]);
  clear();layout('grid');const firstFolder=rows()[0],end=assets()[1],all=rows();box(firstFolder);click(node(end),true);selected(all.slice(0,all.indexOf(end)+1));
  clear();box(assets()[0]);click(node(firstFolder),true);selected(rows().slice(0,rows().indexOf(assets()[0])+1));assert.equal(rows()[0],firstFolder,'Shift点击目录卡片连选，不切换目录');
  clear();box(assets()[0]);clear();box(assets()[4],true);selected([assets()[4]]);
  $('[data-nav=works]').click();await until(()=>$('.works-table'),'作品列表');$(`[data-action=edit][data-id="${project.id}"]`).click();await until(()=>$('.editor-overlay'),'编辑器');$('[data-action=add-images]').click();
  await checkLayouts(true);
  const imageIds=checked().map(key=>key.slice(6));$('[data-action=use-media]').click();assert.equal($$('.editor-shell [data-block].image').length,4);
  $('[data-action=choose-cover]').click();const coverKeys=assets();box(coverKeys[5]);click(node(coverKeys[2]),true);selected(coverKeys.slice(2,6));assert.ok($('[data-action=use-media]').textContent.includes('1'),'单封面仍只使用一个素材');
  $('[data-action=use-media]').click();assert.ok($('.crop-stage'));$('[data-action=apply-crop]').click();$('[data-action=close-editor]').click();await until(()=>!$('.editor-overlay'),'保存退出');
  const draft=app.store.project(project.id).draft;assert.deepEqual(new Set(draft.blocks.filter(row=>row.type==='image').map(row=>row.assetId)),new Set(imageIds));assert.equal(draft.coverAssetId,coverKeys[2].slice(6),'反向连选封面使用点击终点');assert.deepEqual(errors,[]);
});
