// The panel lives outside #app so normal editor renders do not reload its iframe.
window.PortfolioSitePreview=(()=>{
  let open=false,mode='mobile',timer=null,work=null,manualRequests=0,lastKey='',failedKey='',url='',message='展开后自动生成草稿预览',error=false,force=false,restore=null;
  let scope='public',contextKey='',shownPreviewId=null,shownScope='public';
  const storageKey='portfolio-admin:preview-open',clientKey='portfolio-admin:preview-client';
  let clientId=crypto.randomUUID();
  try{open=localStorage.getItem(storageKey)==='true';const stored=sessionStorage.getItem(clientKey);if(stored&&/^[a-f0-9-]{36}$/.test(stored))clientId=stored;else sessionStorage.setItem(clientKey,clientId);}catch{}
  const get=selector=>document.querySelector(selector);
  const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  function snapshot(){
    if(!db)return null;
    const settings=prepareSettings(settingsLocal||db.settings),projects=db.projects.filter(row=>!row.deletedAt).map(row=>row.draft);
    const current=editor?copy(editor):null;if(current)delete current.revision;
    const documents=projects.map(item=>current?.id===item.id?current:item),selected=db.spaces?.items.find(space=>space.id===scope);
    const allowed=documents.filter(document=>{const target=scope==='public'?db.spaces.main:selected;return target?.enabled&&spaceContains(target,document);}).map(document=>document.id);
    return {key:canonical({settings,projects:documents,spaces:db.spaces?.revision,scope,target:current?.id||null}),settings,project:current,scope,allowed};
  }
  function syncContext(){
    if(!db)return;const next=view==='spaces'?'space:'+(activeSpaceId==='main'?'public':activeSpaceId||'public'):'public';
    if(next!==contextKey){contextKey=next;scope=view==='spaces'&&activeSpaceId&&activeSpaceId!=='main'?activeSpaceId:'public';}
    if(scope!=='public'&&!db.spaces?.items.some(space=>space.id===scope))scope='public';
    const name=scope==='public'?'主站':db.spaces.items.find(space=>space.id===scope)?.name||'主站',select=get('[data-site-preview-scope]');
    if(select){const options=[{id:'public',name:'主站'},...(db.spaces?.items||[]).map(space=>({id:space.id,name:space.name+(space.enabled?'':'（已关闭）')}))],markup=options.map(item=>`<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('');if(select.innerHTML!==markup)select.innerHTML=markup;select.value=scope;}
    const title=get('[data-site-preview-title]');if(title)title.textContent='实时预览 · '+name;changed();
  }
  function status(text,bad=false){message=text;error=bad;const node=get('#site-preview-status');if(node){node.textContent=text;node.classList.toggle('is-error',bad);node.setAttribute('role',bad?'alert':'status');}}
  function mount(){
    if(get('#site-preview-panel'))return;
    const node=document.createElement('aside');node.id='site-preview-panel';node.className='site-preview-panel';node.setAttribute('aria-label','实时草稿预览');node.hidden=true;
    node.innerHTML=`<header class="site-preview-heading"><div><strong data-site-preview-title>实时预览</strong><small>草稿效果 · 不会自动发布</small></div><button type="button" class="icon-btn" data-site-preview="close" aria-label="收起实时预览">${icon('close')}</button></header><label class="site-preview-scope"><span>预览范围</span><select data-site-preview-scope aria-label="预览范围"></select></label><div class="site-preview-tools"><div role="group" aria-label="预览设备"><button type="button" data-site-preview="mobile">手机</button><button type="button" data-site-preview="desktop">电脑</button></div><button type="button" class="btn small" data-site-preview="refresh">${icon('refresh')}刷新</button><a class="btn small" data-site-preview-link href="${esc(publishedSiteUrl())}" target="_blank" rel="noopener">${icon('external')}新标签</a></div><p id="site-preview-status" class="site-preview-status" role="status"></p><div class="site-preview-canvas"><div class="site-preview-screen"><iframe class="site-preview-frame" title="作品站草稿实时预览" referrerpolicy="same-origin"></iframe></div></div><footer class="site-preview-foot">修改后自动刷新。<a href="/site/" target="_blank" rel="noopener">查看已发布站点</a></footer>`;
    document.body.append(node);node.querySelector('iframe').addEventListener('load',()=>{
      if(!open||!url)return;try{node.querySelector('iframe').contentWindow.scrollTo(0,restore?.y||0);}catch{}restore=null;
    });
    if(typeof ResizeObserver!=='undefined')new ResizeObserver(resize).observe(node.querySelector('.site-preview-canvas'));
  }
  function resize(){
    const canvas=get('.site-preview-canvas'),frame=get('.site-preview-frame'),screen=get('.site-preview-screen');if(!canvas||!frame)return;
    const width=Math.max(200,canvas.clientWidth||390);
    if(mode==='desktop'){const scale=Math.min(1,width/1280);Object.assign(screen.style,{width:1280*scale+'px',height:800*scale+'px'});Object.assign(frame.style,{width:'1280px',height:'800px',transform:`scale(${scale})`});}
    else{Object.assign(screen.style,{width:Math.min(390,width)+'px',height:'100%'});Object.assign(frame.style,{width:'100%',height:'100%',transform:'none'});}
    document.querySelectorAll('[data-site-preview="mobile"],[data-site-preview="desktop"]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.sitePreview===mode)));
  }
  function ui(){
    mount();const panel=get('#site-preview-panel');panel.hidden=!open;document.body.classList.toggle('has-site-preview',open);
    document.querySelectorAll('[data-action="toggle-site-preview"]').forEach(button=>{button.setAttribute('aria-expanded',String(open));button.setAttribute('aria-controls','site-preview-panel');});
    get('.editor-shell')?.setAttribute('aria-modal',String(!open));
    if(open){status(message,error);resize();}
  }
  function sync(){
    if(db&&(!db.capabilities?.unifiedPreview||!db.capabilities?.shareSpaces)){
      const existing=get('#service-restart-note');if(!existing){const note=document.createElement('p');note.id='service-restart-note';note.className='service-restart-note';note.textContent='后台代码已更新，请关闭原启动窗口，再双击“启动后台.cmd”并刷新页面，加载分享空间和预览功能。';get('.topbar')?.after(note);}
      document.querySelectorAll('[data-action="toggle-site-preview"],[data-action="home-bg-loop"]').forEach(button=>button.disabled=true);return;
    }
    get('#service-restart-note')?.remove();ui();syncContext();
  }
  function changed(){
    if(!open||!db||!db.capabilities?.sidebarPreview)return;const state=snapshot();if(!state||!force&&(state.key===lastKey||state.key===failedKey))return;
    clearTimeout(timer);timer=setTimeout(()=>{timer=null;run();},900);
    if(!work)status('有修改，稍后刷新预览…');
  }
  function currentPosition(){try{const frame=get('.site-preview-frame'),location=new URL(frame.contentWindow.location.href);return{y:frame.contentWindow.scrollY||0,work:location.searchParams.get('work'),scope:shownScope};}catch{return null;}}
  async function run(){
    if(!open||!db)return;
    if(work||busy||manualRequests||typeof spaceHasPending==='function'&&spaceHasPending()){timer=setTimeout(()=>{timer=null;run();},450);return;}
    const state=snapshot();if(!state||!force&&(state.key===lastKey||state.key===failedKey))return;force=false;status('正在生成草稿预览…');
    const previousId=shownPreviewId;
    work=(async()=>{
      try{
        let job=await api('/api/preview','POST',{settings:state.settings,...(state.project?{project:state.project}:{}),sidebarClientId:clientId,sidebarScope:state.scope,keepPreviewId:previousId},{backgroundPreview:true});
        const deadline=Date.now()+120000;
        while(job.status==='running'&&Date.now()<deadline){await pause(300);job=await api('/api/jobs/'+job.id);}
        if(job.status!=='done')throw new Error(job.status==='failed'?job.message:'预览生成超时，请点击刷新重试。');
        if(!open)return;
        // Avoid replacing the visible frame with a build overtaken by new typing.
        if(snapshot()?.key!==state.key){changed();return;}
        const activated=await api('/api/preview/sidebar','POST',{clientId,previewId:job.id},{backgroundPreview:true});if(!open||snapshot()?.key!==state.key){changed();return;}
        restore=currentPosition();if(restore?.scope!==state.scope)restore=null;const candidate=state.project?.id||restore?.work,target=state.allowed.includes(candidate)?candidate:null;
        url=activated.url+(state.scope==='public'?'':'space/'+state.scope+'/')+(target?'?work='+encodeURIComponent(target):'');lastKey=state.key;failedKey='';shownPreviewId=job.id;shownScope=state.scope;
        get('.site-preview-frame').src=url;get('[data-site-preview-link]').href=url;
        status(state.scope!=='public'&&!db.spaces?.items.find(space=>space.id===state.scope)?.enabled?'该空间已关闭，预览将显示关闭状态':job.cleanupPending?'预览已更新，部分旧缓存稍后清理':'草稿预览已更新');
      }catch(failure){if(!open)return;if(failure.status===409){timer=setTimeout(()=>{timer=null;run();},1000);status('等待当前任务完成后刷新…');}else{failedKey=state.key;status('预览未更新：'+failure.message,true);}}
      finally{work=null;}
    })();await work;
  }
  const blocksRequest=(path,method)=>method==='POST'&&['/api/preview','/api/publish','/api/rollback','/api/import/commit','/api/arrange'].includes(path)||method==='PUT'&&path==='/api/release-retention'||['POST','PUT','DELETE'].includes(method)&&(/^\/api\/spaces(?:\/|$)/.test(path)||/^\/api\/projects\/[^/]+\/spaces$/.test(path));
  async function beforeRequest(path,method){
    if(!blocksRequest(path,method))return null;
    manualRequests++;clearTimeout(timer);timer=null;
    try{if(work)await work;}catch{}
    return ()=>{manualRequests--;if(open)changed();};
  }
  function toggle(value=!open){
    if(value&&(!db?.capabilities?.unifiedPreview||!db?.capabilities?.displaySpaces))return;
    open=value;try{localStorage.setItem(storageKey,String(open));}catch{}
    ui();syncContext();if(open){if(url)get('.site-preview-frame').src=url;changed();}
    else{clearTimeout(timer);timer=null;get('.site-preview-frame').removeAttribute('src');(get('.editor-close')||get('[data-action="toggle-site-preview"]'))?.focus({preventScroll:true});}
  }
  document.addEventListener('click',event=>{const control=event.target.closest?.('[data-site-preview]');if(!control)return;const action=control.dataset.sitePreview;if(action==='close')toggle(false);else if(action==='refresh'){force=true;failedKey='';changed();}else{mode=action;resize();}});
  document.addEventListener('change',event=>{if(!event.target.matches?.('[data-site-preview-scope]'))return;scope=event.target.value;syncContext();});
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&event.target.closest?.('#site-preview-panel')){event.preventDefault();event.stopImmediatePropagation();toggle(false);}},true);
  window.addEventListener('resize',resize);
  function invalidate(){clearTimeout(timer);timer=null;lastKey='';failedKey='';url='';shownPreviewId=null;force=true;restore=null;get('.site-preview-frame')?.removeAttribute('src');get('[data-site-preview-link]')?.setAttribute('href','/site/');}
  return {sync,syncContext,changed,toggle,beforeRequest,blocksRequest,invalidate,isOpen:()=>open};
})();
