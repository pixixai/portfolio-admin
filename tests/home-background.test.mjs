import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Window} from 'happy-dom';
import {createApplication,root} from '../server.mjs';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,label){const end=Date.now()+15000;while(Date.now()<end){if(check())return;await pause(20);}throw new Error('等待超时：'+label);}

test('首页背景上传、排序倍速、定格帧校验、设置草稿发布与历史素材保护',async t=>{
  const app=await createApplication({dataDir:await mkdtemp(path.join(os.tmpdir(),'pixix-home-background-'))});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(()=>app.close());
  const base=`http://127.0.0.1:${app.server.address().port}`;let cookie='';
  async function api(url,method='GET',data,status=200){const r=await fetch(base+url,{method,headers:{Cookie:cookie,...(data===undefined?{}:{'Content-Type':'application/json'})},body:data===undefined?undefined:JSON.stringify(data)});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];const value=await r.json();assert.equal(r.status,status,JSON.stringify(value));return value;}
  
  const video=await readFile(path.join(root,'renderer/assets/home/home-background.mp4'));
  const video2=Buffer.concat([video,Buffer.from([0,0,0,8,102,114,101,101])]);
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HA4CAAAAC0lEQVR42mP8/x8AAusB9Wl6XFAAAAAASUVORK5CYII=','base64');
  async function upload(bytes,name,mime){const r=await fetch(base+'/api/media?name='+encodeURIComponent(name),{method:'POST',headers:{Cookie:cookie,'Content-Type':mime},body:bytes});assert.equal(r.status,201);return r.json();}
  const one=await upload(video,'一.mp4','video/mp4'),two=await upload(video2,'二.mp4','video/mp4');
  // Reuse a real image from the imported collection for a valid final still.
  const before=await api('/api/state'),frame=before.media.find(asset=>asset.mime.startsWith('image/'));
  const background={videos:[{assetId:one.id,playbackRate:.5},{assetId:two.id,playbackRate:1.5}],finalFrameAssetId:frame.id,shadeOpacity:80,shadeColor:'#000000',loop:false};
  for(const value of [0,5,null])await api('/api/settings','PUT',{...before.settings,revision:before.settingsRevision,homeBackground:{...background,videos:[{assetId:one.id,playbackRate:value}]}},400);
  await api('/api/settings','PUT',{...before.settings,revision:before.settingsRevision,homeBackground:{...background,videos:[{assetId:frame.id,type:'video',playbackRate:1}]}},400);
  for(const duration of [0,121,'5'])await api('/api/settings','PUT',{...before.settings,revision:before.settingsRevision,homeBackground:{...background,videos:[{assetId:frame.id,type:'image',duration}]}},400);
  await api('/api/settings','PUT',{...before.settings,revision:before.settingsRevision,homeBackground:{...background,finalFrameAssetId:one.id}},400);
  await api('/api/settings','PUT',{...before.settings,revision:before.settingsRevision,footer:{registrationText:'测试',registrationUrl:'javascript:alert(1)'}},400);
  for(const value of ['x'.repeat(1001),42])await api('/api/settings','PUT',{...before.settings,revision:before.settingsRevision,footer:{text:value}},400);
  for(const value of [-1,101,80.5,'50'])await api('/api/settings','PUT',{...before.settings,revision:before.settingsRevision,homeBackground:{...background,shadeOpacity:value}},400);
  for(const value of ['#fff','red','#000000;display:none',80,{}])await api('/api/settings','PUT',{...before.settings,revision:before.settingsRevision,homeBackground:{...background,shadeColor:value}},400);
  const {shadeOpacity,shadeColor,...legacyBackground}=background;
  await api('/api/settings','PUT',{...before.settings,revision:before.settingsRevision,homeBackground:legacyBackground});
  let data=await api('/api/state');assert.deepEqual(data.settings.homeBackground,background);assert.notDeepEqual(data.settingsLive.homeBackground,background,'保存不修改发布设置');
  assert.equal(app.store.references(one.id).inSettings,true);
  await api(`/api/media/${one.id}`,'DELETE',undefined,409);
  const plan=await api('/api/media/delete-plan','POST',{items:[{kind:'asset',id:one.id},{kind:'asset',id:two.id}]});assert.equal(plan.allowed,false);assert.equal(plan.blocked.length,2);
  const w=new Window({url:base,settings:{disableCSSFileLoading:true,disableJavaScriptFileLoading:true,disableIframePageLoading:true}}),errors=[];t.after(()=>w.happyDOM.abort());
  w.fetch=(url,options={})=>fetch(new URL(url,base),{...options,headers:{...options.headers,Cookie:cookie}});w.addEventListener('error',event=>errors.push(event.message));
  w.XMLHttpRequest=class{upload={};open(method,url){this.method=method;this.url=url;}setRequestHeader(){}send(file){(async()=>{const r=await fetch(new URL(this.url,base),{method:this.method,headers:{Cookie:cookie,'Content-Type':file.type},body:Buffer.from(await file.arrayBuffer())});this.status=r.status;this.responseText=await r.text();this.onload();})().catch(()=>this.onerror());}};
  w.document.write(await readFile(path.join(root,'public/index.html'),'utf8'));
  const style=w.document.createElement('style');style.textContent=await readFile(path.join(root,'public/style.css'),'utf8');w.document.head.append(style);
  w.eval((await Promise.all(['media-browser.js','editor.js','document-selection.js','document.js','spaces.js','app.js'].map(file=>readFile(path.join(root,'public',file),'utf8')))).join('\n'));
  const $=s=>w.document.querySelector(s),$$=s=>[...w.document.querySelectorAll(s)];
  await until(()=>$('.works-table'),'后台加载');$('[data-nav=settings]').click();await until(()=>$('.settings-sections'),'展示设置');assert.equal($$('[data-home-video]').length,2);assert.ok($('.home-final-preview'));
  assert.equal($('.settings-nav'),null);assert.equal($('[data-settings-tab]'),null);
  assert.deepEqual($$('.settings-sections>section').map(section=>w.document.getElementById(section.getAttribute('aria-labelledby')).textContent),['首页背景','个人信息','网站信息与页脚']);
  for(const key of ['owner','role','tagline','contact.wechat','contact.bilibiliName','contact.emails.0'])assert.ok($(`[data-setting="${key}"]`).closest('[aria-labelledby="settings-personal-title"]'),'身份与联系方式放在同一区域');
  for(const key of ['title','description','footer.text'])assert.ok($(`[data-setting="${key}"]`).closest('label').querySelector('small'),'网站信息解释显示位置');
  assert.equal($('[data-setting="year"]'),null,'移除作品集年份控件');
  assert.equal($('[data-setting="footer.text"]').value,`© ${before.settings.year} ${before.settings.owner} · 作品集`,'旧设置的页脚内容自动填入文字框');
  assert.equal($('[aria-labelledby="settings-personal-title"] [data-setting]').dataset.setting,'tagline','首页介绍排在姓名上方');
  assert.equal($('[aria-labelledby="settings-site-title"] h3').textContent,'页脚信息');
  const firstPreview=$('[data-home-first-frame]'),poster='data:image/jpeg;base64,cHJldmlldw==',drawn=[];
  assert.equal(firstPreview.preload,'auto');assert.equal(firstPreview.hasAttribute('controls'),false);assert.equal(firstPreview.hidden,true);assert.equal(firstPreview.autoplay,false);
  Object.defineProperties(firstPreview,{videoWidth:{value:1920},videoHeight:{value:1080}});
  const nativeContext=w.HTMLCanvasElement.prototype.getContext,nativeDataURL=w.HTMLCanvasElement.prototype.toDataURL;
  w.HTMLCanvasElement.prototype.getContext=function(){return{drawImage:(...args)=>drawn.push(args)};};w.HTMLCanvasElement.prototype.toDataURL=function(){assert.equal(this.width,320);assert.equal(this.height,180);return poster;};
  firstPreview.dispatchEvent(new w.Event('loadeddata'));assert.equal($('[data-home-poster]').getAttribute('src'),poster);assert.equal(firstPreview.isConnected,false,'生成静态首帧后移除解码视频');assert.deepEqual(drawn[0],[firstPreview,0,0,320,180]);
  w.HTMLCanvasElement.prototype.getContext=nativeContext;w.HTMLCanvasElement.prototype.toDataURL=nativeDataURL;
  assert.equal(w.getComputedStyle($('.settings-heading')).position,'sticky');assert.equal(w.getComputedStyle($('.settings-heading')).top,'0px');
  for(const action of ['save-settings','preview-settings']){assert.equal($$(`[data-action="${action}"]`).length,1);assert.ok($(`.settings-heading [data-action="${action}"]`));}
  const textChanges={owner:'设置页作者',role:'品牌设计师',tagline:'同页编辑网站介绍',title:'设置页测试作品集',description:'同页编辑的网站描述','contact.wechat':'unified-wechat','contact.bilibiliName':'设置页昵称','contact.emails.0':'unified@example.com','footer.text':'© 2026 噼哩画啦 · 作品集\n设计 <实验> & {{owner}}','footer.registrationText':'同页登记','footer.registrationUrl':'https://example.com/unified'};
  for(const [key,value] of Object.entries(textChanges)){const input=$(`[data-setting="${key}"]`);assert.ok(input,`${key}与背景控件同时显示`);input.value=value;input.dispatchEvent(new w.Event('input',{bubbles:true}));}
  $('[data-action=home-bg-shade-color][data-color="#173d7a"]').click();assert.equal($('[data-home-shade-color]').value,'#173d7a');assert.equal($('[data-action=home-bg-shade-color][data-color="#173d7a"]').getAttribute('aria-pressed'),'true');
  const color=$('[data-home-shade-color]');color.value='#abcdef';color.dispatchEvent(new w.Event('input',{bubbles:true}));assert.equal($('[data-home-shade-color]'),color,'自定义颜色不重建控件');assert.equal($('[data-home-color-value]').textContent,'#ABCDEF');
  const slider=$('[data-home-shade][type=range]'),number=$('[data-home-shade][type=number]');assert.equal(slider.value,'80');slider.value='37';slider.dispatchEvent(new w.Event('input',{bubbles:true}));assert.equal(number.value,'37');assert.equal($('[data-home-shade][type=range]'),slider,'滑动不重建控件');number.value='0';number.dispatchEvent(new w.Event('input',{bubbles:true}));assert.equal(slider.value,'0');
  assert.equal($('[data-action=home-bg-up]'),null);assert.equal($('[data-action=home-bg-down]'),null);
  assert.ok($('.home-background-note').previousElementSibling.classList.contains('home-background-list'),'说明放在媒体列表正下方');
  function dragFirst(cancel=false){$$('[data-home-video]').forEach((row,index)=>{row.getBoundingClientRect=()=>({top:100+index*90,height:80});});const pointer=(node,type,y)=>node.dispatchEvent(new w.PointerEvent(type,{bubbles:true,cancelable:true,button:0,pointerId:9,clientY:y}));pointer($('[data-home-drag="0"]'),'pointerdown',120);pointer(w.document,'pointermove',260);assert.ok($('.home-insert-after'));assert.equal($('.home-drag-order').textContent,'01 → 02');assert.equal($('[data-home-video="1"] .home-media-position').textContent,'01');assert.ok($('[data-home-video="1"]').style.transform,'相邻条目让出位置');if(cancel)w.document.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));pointer(w.document,'pointerup',260);assert.equal($('#home-media-drag-ghost'),null);}
  dragFirst(true);assert.equal($('[data-setting="homeBackground.videos.0.playbackRate"]').value,'0.5','Esc取消排序');dragFirst();
  let speed=$('[data-setting="homeBackground.videos.0.playbackRate"]');assert.equal(speed.value,'1.5');speed.value='2';speed.dispatchEvent(new w.Event('input',{bubbles:true}));
  assert.equal($('[data-home-video="1"] [data-home-poster]').getAttribute('src'),poster,'排序后仍按视频来源显示首帧，不串图');
  const nativeClick=w.HTMLInputElement.prototype.click;let chosen=0;
  w.HTMLInputElement.prototype.click=function(){if(this.type==='file'){chosen++;assert.ok(this.accept.includes('image/png')&&this.accept.includes('video/mp4')&&!this.accept.includes('audio/'));Object.defineProperty(this,'files',{value:[new w.File([video],'重复一.mp4',{type:'video/mp4'}),new w.File([video2],'重复二.mp4',{type:'video/mp4'}),new w.File([png],'背景.png',{type:'image/png'})]});this.dispatchEvent(new w.Event('change',{bubbles:true}));}else nativeClick.call(this);};
  $('[data-action=home-bg-upload]').click();await until(()=>$$('[data-home-video]').length===5,'视频和图片上传加入播放列表');assert.equal(chosen,1);w.HTMLInputElement.prototype.click=nativeClick;
  assert.ok($('[data-home-video="4"] .home-video-preview img'));assert.equal($('[data-home-video="4"] [data-setting]').value,'5');
  $('[data-action=home-bg-remove][data-index="3"]').click();$('[data-action=home-bg-remove][data-index="2"]').click();$('[data-action=home-bg-frame-clear]').click();assert.equal($('.home-final-preview'),null);
  const duration=$('[data-setting="homeBackground.videos.2.duration"]');duration.value='7';duration.dispatchEvent(new w.Event('input',{bubbles:true}));
  $('[data-action=home-bg-select]').click();assert.ok($$('#dialog [data-media-asset]').some(node=>node.dataset.mediaAsset===one.id));assert.ok($$('#dialog [data-media-asset]').some(node=>node.dataset.mediaAsset===frame.id),'同一素材选择窗口包含图片和视频');$('[data-action=close-dialog]').click();
  for(const [key,value] of Object.entries(textChanges))assert.equal($(`[data-setting="${key}"]`).value,value,'调整背景后保留其它分区未保存输入');
  $('[data-action=save-settings]').click();await until(()=>app.store.get('settingsRevision')===before.settingsRevision+2,'设置保存');
  data=await api('/api/state');assert.equal(data.settings.homeBackground.shadeColor,'#abcdef');assert.equal(data.settings.homeBackground.videos[0].assetId,two.id);assert.equal(data.settings.homeBackground.videos[0].playbackRate,2);assert.equal(data.settings.homeBackground.finalFrameAssetId,null);assert.equal(data.settings.homeBackground.shadeOpacity,0,'保存0%不会回退到默认80%');
  assert.equal(data.settings.homeBackground.videos[2].type,'image');assert.equal(data.settings.homeBackground.videos[2].duration,7);assert.ok(app.store.references(data.settings.homeBackground.videos[2].assetId).inSettings);
  const backgroundImageId=data.settings.homeBackground.videos[2].assetId;
  for(const [key,value] of Object.entries(textChanges))assert.equal(key.split('.').reduce((obj,part)=>obj[part],data.settings),value,'统一保存整页字段');
  for(const key of ['brand','titleLines','skills','appearance'])assert.deepEqual(data.settings[key],before.settings[key],'保留未显示的历史设置字段');
  for(const [key,value] of Object.entries({'tagline':'尚未保存的网站介绍','contact.wechat':'preview-wechat'})){const input=$(`[data-setting="${key}"]`);input.value=value;input.dispatchEvent(new w.Event('input',{bubbles:true}));}
  const previewShade=$('[data-home-shade][type=range]');previewShade.value='37';previewShade.dispatchEvent(new w.Event('input',{bubbles:true}));
  const previewColor=$('[data-home-shade-color]');previewColor.value='#214d3d';previewColor.dispatchEvent(new w.Event('input',{bubbles:true}));
  $('.settings-heading [data-action=preview-settings]').click();await until(()=>$('#dialog[open] .modal-body a'),'整页未保存设置预览');
  const previewUrl=$('#dialog .modal-body a').getAttribute('href');assert.equal((await api(previewUrl+'data/home-background.json')).shadeOpacity,37);assert.equal((await api(previewUrl+'data/home-background.json')).shadeColor,'#214d3d');assert.equal(app.store.get('settingsDraft').homeBackground.shadeColor,'#abcdef');
  const previewHTML=await(await fetch(base+previewUrl,{headers:{Cookie:cookie}})).text();assert.ok(previewHTML.includes('尚未保存的网站介绍'));assert.ok(previewHTML.includes('preview-wechat'));assert.equal(app.store.get('settingsDraft').homeBackground.shadeOpacity,0,'预览不覆盖已保存的蒙板设置');assert.equal(app.store.get('settingsDraft').tagline,textChanges.tagline,'预览不覆盖已保存文字');assert.equal(app.store.get('settingsDraft').contact.wechat,textChanges['contact.wechat'],'预览不覆盖已保存联系方式');
  const previewDocument=new Window();t.after(()=>previewDocument.happyDOM.abort());previewDocument.document.write(previewHTML);assert.equal(previewDocument.document.title,textChanges.title);assert.equal(previewDocument.document.querySelector('meta[name="description"]').content,textChanges.description);assert.equal(previewDocument.document.querySelector('.footer-copyright').textContent,textChanges['footer.text']);assert.equal(previewDocument.document.querySelector('.footer-copyright').children.length,0,'页脚纯文字不作为HTML或模板解析');
  $('[data-action=close-dialog]').click();
  // The exported source and deployment use public asset URLs, never private API URLs.
  await api('/api/settings','PUT',{...data.settings,revision:data.settingsRevision,homeBackground:{...data.settings.homeBackground,finalFrameAssetId:frame.id},footer:{...data.settings.footer,registrationText:'测试登记 <示例>',registrationUrl:'https://example.com/registry'}});
  const publishing=await api('/api/publish','POST',{projectIds:[],includeSettings:true},202);await until(()=>app.publisher.jobs.get(publishing.id).status!=='running','背景发布');assert.equal(app.publisher.jobs.get(publishing.id).status,'done',app.publisher.jobs.get(publishing.id).message);
  const config=await api('/site/data/home-background.json');assert.deepEqual(config.videos.slice(0,2).map(item=>item.playbackRate),[2,.5]);assert.equal(config.videos[2].type,'image');assert.equal(config.videos[2].duration,7);assert.ok(config.videos[2].src.startsWith('assets/home/uploads/'));assert.ok(config.finalFrame.startsWith('assets/home/uploads/'));assert.equal(config.shadeOpacity,0);assert.equal(config.shadeColor,'#abcdef');
  const first=await fetch(base+'/site/'+config.videos[0].src,{headers:{Cookie:cookie,Range:'bytes=0-31'}});assert.equal(first.status,206);assert.equal(first.headers.get('Content-Type'),'video/mp4');
  const publishedImage=await fetch(base+'/site/'+config.videos[2].src,{headers:{Cookie:cookie}});assert.equal(publishedImage.status,200);assert.equal(publishedImage.headers.get('Content-Type'),'image/png');
  const html=await (await fetch(base+'/site/',{headers:{Cookie:cookie}})).text();assert.ok(html.includes('hero-bottom'));assert.equal(html.includes('creative-title.svg'),false);assert.equal(html.includes('home-brand'),false);assert.equal(html.includes('hero-video-toggle'),false);assert.ok(!html.includes('/api/media/'));assert.ok(html.includes('https://example.com/registry'));assert.ok(html.includes('测试登记 &lt;示例&gt;'));assert.equal(html.includes('contact-card'),false);
  previewDocument.document.write(html);assert.equal(previewDocument.document.querySelector('.footer-copyright').textContent,textChanges['footer.text'],'发布沿用已保存的页脚文字');
  assert.equal(html.includes('mailto:'),false,'发布站点的邮箱同样使用复制操作');
  assert.ok(html.indexOf('class="home-wechat"')<html.indexOf('class="home-email"')&&html.indexOf('class="home-email"')<html.indexOf('class="home-bilibili"'),'发布后保持新的按钮顺序');
  const publishedCSS=await (await fetch(base+'/site/home-image.css',{headers:{Cookie:cookie}})).text();assert.ok(publishedCSS.includes('#works .project-card .card-image, #works .filters button { border-radius: 0; }'));assert.ok(publishedCSS.includes('#works .filters button[aria-pressed="true"] { background: #000; color: #fff; }'));
  data=await api('/api/state');await api('/api/settings','PUT',{...data.settings,revision:data.settingsRevision,footer:{...data.settings.footer,text:''},homeBackground:{videos:[],finalFrameAssetId:null,shadeOpacity:100}});
  const empty=await api('/api/publish','POST',{projectIds:[],includeSettings:true},202);await until(()=>app.publisher.jobs.get(empty.id).status!=='running','发布空列表');assert.equal(app.publisher.jobs.get(empty.id).status,'done');assert.equal(app.store.references(one.id).inHistory,true);await api(`/api/media/${one.id}`,'DELETE',undefined,409);
  assert.equal((await api('/site/data/home-background.json')).shadeOpacity,100,'100%蒙板随发布保存');
  assert.ok(app.store.references(backgroundImageId).inHistory,'图片背景同样受历史发布保护');await api(`/api/media/${backgroundImageId}`,'DELETE',undefined,409);
  const emptyHTML=await(await fetch(base+'/site/',{headers:{Cookie:cookie}})).text();assert.equal(emptyHTML.includes('class="footer-copyright"'),false,'页脚文字清空后隐藏，不自动恢复旧年份与姓名');
  assert.deepEqual(errors,[]);
});
