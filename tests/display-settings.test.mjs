import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Window} from 'happy-dom';
import {createApplication,root} from '../server.mjs';
import {defaultGallery,defaultGradient,normalizeGallery,normalizeGradient,shadeCSS,galleryLayout} from '../renderer/display-settings.js';
import {inspectProjectPackage} from '../lib/project-package.mjs';
import {readZip} from '../lib/zip.mjs';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){for(const end=Date.now()+15000;Date.now()<end;){if(await check())return;await pause(15);}throw new Error('等待设置或预览超时');}
async function fixture(t){
  const app=await createApplication({dataDir:await mkdtemp(path.join(os.tmpdir(),'pixix-display-'))});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(()=>app.close());
  const base=`http://127.0.0.1:${app.server.address().port}`;let cookie='';
  const request=async(url,options={})=>{const response=await fetch(new URL(url,base),{...options,headers:{Cookie:cookie,...options.headers}});if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];return response;};
  const api=async(url,method='GET',data,status=200)=>{const response=await request(url,{method,...(data===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(data)})}),value=await response.json();assert.equal(response.status,status,JSON.stringify(value));return value;};
  const finish=async job=>{await until(()=>app.publisher.jobs.get(job.id).status!=='running');const result=app.publisher.jobs.get(job.id);assert.equal(result.status,'done',result.message);return result;};
  return {app,base,request,api,finish};
}

test('瀑布流与渐变参数限制有效，旧设置使用默认值，输出不接受CSS注入',()=>{
  assert.deepEqual(normalizeGallery(),defaultGallery());assert.deepEqual(normalizeGradient(),defaultGradient());
  for(const settings of [{maxWidth:300},{columnsDesktop:9},{columnsMobile:3},{radius:-1},{gapMobile:49},{paddingDesktop:161},{infoMode:'html'},{shadeOpacity:'50'},{shadeColor:'#000;display:none'},{shadeGradient:{angle:361}},{shadeGradient:{startColor:'red'}},{shadeGradient:{enabled:1}},{shadeGradient:{endOpacity:-1}}])assert.throws(()=>normalizeGallery(settings,true));
  const custom={shadeColor:'#ffffff',shadeGradient:{enabled:true,angle:135,startColor:'#173d7a',endColor:'#4c1d5b',startOpacity:25,endOpacity:100}};
  assert.equal(shadeCSS(custom),'linear-gradient(135deg,rgba(23,61,122,0.25) 0%,rgba(76,29,91,1) 100%)');
  assert.equal(shadeCSS({shadeColor:'red;display:none'}),'#000000');
  assert.deepEqual(galleryLayout({},1532,1920),{columns:4,gap:5});assert.deepEqual(galleryLayout({},900,1000),{columns:3,gap:5});assert.deepEqual(galleryLayout({},350,390),{columns:2,gap:3});
  assert.deepEqual(galleryLayout({...defaultGallery(),columnsDesktop:2,gapDesktop:0},1532,1920),{columns:2,gap:0});assert.deepEqual(galleryLayout({...defaultGallery(),columnsMobile:1,gapMobile:0},350,390),{columns:1,gap:0});
});

test('设置保存、主站与分享空间预览和发布、部署包均保留布局、渐变与两种备案信息',async t=>{
  const f=await fixture(t),initial=await f.api('/api/state'),gallery={...defaultGallery(),maxWidth:1440,paddingDesktop:32,paddingMobile:16,gapDesktop:24,gapMobile:8,columnsDesktop:5,columnsMobile:1,radius:12,infoMode:'always',shadeColor:'#214d3d',shadeOpacity:37,shadeGradient:{...defaultGradient(),enabled:true,angle:90,startColor:'#173d7a',endColor:'#4c1d5b',startOpacity:0,endOpacity:85}};
  const home={...initial.settings.homeBackground,shadeOpacity:62,shadeGradient:{...gallery.shadeGradient,angle:135,startOpacity:100}};
  const footer={...initial.settings.footer,endnote:'新的探索 <文字> & {{owner}}',icpNumber:'陕ICP备00000000号-1（示例）',policeNumber:'陕公网安备00000000000000号（示例）'};
  await f.api('/api/settings','PUT',{...initial.settings,gallery,homeBackground:home,footer,revision:initial.settingsRevision});
  const saved=await f.api('/api/state');assert.deepEqual(saved.settings.gallery,gallery);assert.deepEqual(saved.settings.homeBackground.shadeGradient,home.shadeGradient);assert.deepEqual(saved.settingsLive,initial.settingsLive);
  const spaceResponse=await f.api('/api/spaces','POST',{name:'布局共享测试',enabled:true,accessMode:'public',groups:[{label:saved.projects[0].draft.labels?.[0]||saved.projects[0].draft.category,mode:'all',projectIds:[],excludedProjectIds:[]}],revision:saved.spaces.revision},201),space=spaceResponse.items.find(item=>item.name==='布局共享测试');
  const preview=await f.finish(await f.api('/api/preview','POST',{},202));
  const inspect=async url=>{
    const html=await(await f.request(url)).text(),w=new Window();t.after(()=>w.happyDOM.abort());w.document.write(html);
    assert.deepEqual(JSON.parse(w.document.querySelector('#grid').dataset.gallery),gallery);assert.equal(w.document.body.dataset.cardInfo,'always');assert.equal(w.document.querySelector('.endnote').textContent,footer.endnote);assert.equal(w.document.querySelector('.endnote').children.length,0);
    assert.equal(w.document.querySelector('.footer-filing>a').getAttribute('href'),'https://beian.miit.gov.cn/');assert.match(w.document.querySelector('.police-filing').getAttribute('href'),/code=00000000000000$/);assert.match(w.document.querySelector('.police-filing').textContent,/示例/);
    const image=new URL(w.document.querySelector('.police-filing img').getAttribute('src'),new URL(url,f.base));assert.equal((await f.request(image)).headers.get('Content-Type'),'image/png');
    const css=await(await f.request(new URL('display.css',new URL(url,f.base)))).text();assert.ok(css.includes('--works-max-width:1440px'));assert.ok(css.includes('--works-radius:12px'));assert.ok(css.includes('--card-shade-opacity:0.37'));assert.ok(css.includes('linear-gradient(90deg'));
    assert.deepEqual((await f.api(url+'data/home-background.json')).shadeGradient,home.shadeGradient);assert.equal((await f.request(new URL('display-settings.js',new URL(url,f.base)))).status,200);
  };
  await inspect(preview.url);
  const state=await f.api('/api/state');const published=await f.finish(await f.api('/api/publish','POST',{projectIds:state.projects.map(row=>row.id),includeSettings:true},202));await inspect('/site/');
  const snapshot=f.app.store.releases().find(release=>release.id===published.id).snapshot;assert.deepEqual(snapshot.settings.gallery,gallery);
  const release=path.join(f.app.store.directory,'releases',published.id),catalog=JSON.parse(await readFile(path.join(release,'private/catalog.json'),'utf8'));
  const publicSpace=catalog.spaces.find(item=>item.id===space.id);assert.ok(publicSpace);
  // Public space URLs use the same settings and portable assets.
  await inspect('/site/space/'+space.id+'/');
  const response=await f.request('/api/export/'+published.id+'?kind=dist');assert.equal(response.status,200);
  const bytes=Buffer.from(await response.arrayBuffer()),files=readZip(bytes);assert.ok(files.has('display.css'));assert.ok(files.has('display-settings.js'));const restored=inspectProjectPackage(bytes,f.app.store);assert.deepEqual(restored.settings.gallery,gallery);assert.equal(restored.settings.footer.endnote,footer.endnote);assert.deepEqual(restored.settings.homeBackground.shadeGradient,home.shadeGradient);
});

test('备案与底部文案留空时不输出占位，不改变其他页脚信息',async t=>{
  const f=await fixture(t),initial=await f.api('/api/state');
  const settings={...initial.settings,footer:{...initial.settings.footer,endnote:'',icpNumber:'',policeNumber:'',registrationText:'',registrationUrl:''}};
  const preview=await f.finish(await f.api('/api/preview','POST',{settings},202)),html=await(await f.request(preview.url)).text();
  assert.equal(html.includes('class="endnote"'),false);assert.equal(html.includes('class="footer-filing"'),false);assert.ok(html.includes(initial.settings.footer.text));assert.deepEqual(f.app.store.get('settingsDraft'),initial.settings);
});

test('设置控件可分别编辑两处渐变、使用预设、切换列数与恢复默认，保存后离开没有误提示',async t=>{
  const f=await fixture(t);await f.api('/api/state');const w=new Window({url:f.base,settings:{disableCSSFileLoading:true,disableJavaScriptFileLoading:true,disableIframePageLoading:true}}),errors=[];t.after(()=>w.happyDOM.abort());
  w.fetch=f.request;w.addEventListener('error',event=>errors.push(event.message));w.document.write(await readFile(path.join(root,'public/index.html'),'utf8'));
  w.eval((await Promise.all(['media-browser.js','editor.js','document-selection.js','document.js','spaces.js','app.js'].map(file=>readFile(path.join(root,'public',file),'utf8')))).join('\n'));
  const $=selector=>w.document.querySelector(selector),click=selector=>{assert.ok($(selector),selector);$(selector).click();},input=(selector,value)=>{const node=$(selector);assert.ok(node,selector);node.value=value;node.dispatchEvent(new w.Event('input',{bubbles:true}));return node;};
  await until(()=>$('.works-table'));click('[data-nav=settings]');await until(()=>$('#settings-gallery-title'));
  assert.equal($('[data-setting="footer.endnote"]').value,'每一个项目，都是一次新的探索。');assert.match($('[data-setting="footer.icpNumber"]').value,/示例/);
  input('[data-setting="gallery.maxWidth"]','1440');input('[data-setting="gallery.columnsMobile"]','1');input('[data-setting="footer.endnote"]','控件测试文案');
  click('[data-action=mask-mode][data-scope=homeBackground][data-mode=gradient]');click('[data-action=mask-preset][data-scope=homeBackground][data-preset="0"]');
  const angle=input('[data-mask-scope=homeBackground][data-mask-field="shadeGradient.angle"][type=number]','270'),dial=$('[data-mask-dial=homeBackground]');
  assert.equal(dial.getAttribute('aria-valuenow'),'270');assert.equal(dial.style.getPropertyValue('--mask-angle'),'270deg');assert.equal($('[data-mask-scope=homeBackground][data-mask-field="shadeGradient.angle"][type=range]'),null);
  assert.equal($('[data-mask-editor=homeBackground] .mask-stop-opacity.mask-stop-start input').dataset.maskField,'shadeGradient.startOpacity');assert.equal($('[data-mask-editor=homeBackground] .mask-stop-color.mask-stop-end input').dataset.maskField,'shadeGradient.endColor');
  dial.getBoundingClientRect=()=>({left:100,top:100,width:42,height:42});
  const pointer=(target,type,x,y,id=7)=>target.dispatchEvent(new w.PointerEvent(type,{bubbles:true,cancelable:true,button:0,isPrimary:true,pointerId:id,clientX:x,clientY:y}));
  pointer(dial,'pointerdown',121,100);assert.equal(angle.value,'0');pointer(w.document,'pointermove',142,121);assert.equal(angle.value,'90');pointer(w.document,'pointerup',142,121);assert.equal(dial.getAttribute('aria-valuenow'),'90');assert.equal($('[data-mask-scope=homeBackground][data-mask-field="shadeGradient.angle"][type=number]'),angle,'转动角度不重建控件');
  input('[data-mask-scope=homeBackground][data-mask-field="shadeGradient.angle"][type=number]','360');assert.equal(dial.style.getPropertyValue('--mask-angle'),'360deg');
  dial.dispatchEvent(new w.KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:'Home'}));assert.equal(angle.value,'0');dial.dispatchEvent(new w.KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:'ArrowDown'}));assert.equal(angle.value,'359');dial.dispatchEvent(new w.KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:'ArrowRight',shiftKey:true}));assert.equal(angle.value,'9');
  pointer(dial,'pointerdown',121,142);assert.equal(angle.value,'180');w.document.dispatchEvent(new w.KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:'Escape'}));assert.equal(angle.value,'9','取消旋转恢复原角度');assert.equal(dial.classList.contains('is-turning'),false);
  pointer(dial,'pointerdown',100,121);assert.equal(angle.value,'270');pointer(w.document,'pointercancel',100,121);assert.equal(angle.value,'9');input('[data-mask-scope=homeBackground][data-mask-field="shadeGradient.angle"][type=number]','270');
  click('[data-action=mask-preset][data-scope=gallery][data-preset="1"]');input('[data-mask-scope=gallery][data-mask-field=shadeOpacity][type=range]','25');
  const galleryDial=$('[data-mask-dial=gallery]');galleryDial.getBoundingClientRect=()=>({left:100,top:100,width:42,height:42});pointer(galleryDial,'pointerdown',142,121,9);pointer(w.document,'pointerup',142,121,9);assert.equal($('[data-mask-scope=gallery][data-mask-field="shadeGradient.angle"]').value,'90');assert.equal(angle.value,'270','两处角度互不影响');
  click('[data-action=save-settings]');await until(()=>f.app.store.get('settingsDraft').footer.endnote==='控件测试文案');await until(()=>!$('[data-action=save-settings]').disabled);
  let settings=f.app.store.get('settingsDraft');assert.equal(settings.gallery.columnsMobile,1);assert.equal(settings.gallery.maxWidth,1440);assert.equal(settings.gallery.shadeOpacity,25);assert.equal(settings.homeBackground.shadeGradient.angle,270);assert.equal(settings.gallery.shadeGradient.startColor,'#214d3d');assert.equal(settings.homeBackground.shadeGradient.startColor,'#173d7a');
  click('[data-nav=works]');await until(()=>$('.works-table'));assert.equal($('#dialog').open,false);click('[data-nav=settings]');await until(()=>$('#settings-gallery-title'));click('[data-action=gallery-reset]');assert.equal($('[data-setting="gallery.maxWidth"]').value,'1620');assert.equal($('[data-setting="footer.endnote"]').value,'控件测试文案');click('[data-action=save-settings]');await until(()=>f.app.store.get('settingsDraft').gallery.maxWidth===1620);settings=f.app.store.get('settingsDraft');assert.deepEqual(settings.gallery,defaultGallery());assert.equal(settings.homeBackground.shadeGradient.angle,270);assert.deepEqual(errors,[]);
});
