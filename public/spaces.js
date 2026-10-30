let activeSpaceId='main',spaceSearch='',spaceNameEdit=null,spaceNameSaving=false,spaceNameWork=null;
let spaceCodeEdit=null,spaceCodeWork=null;
let spaceSaveTimer=null,spaceSaveWork=null,spaceSaveError='',spaceSequence=0;
const spaceEdits=new Map();
const allDisplaySpaces=()=>[db.spaces?.main,...(db.spaces?.items||[])].filter(Boolean);
function spaceSelectionFor(space){return {...space,...spaceEdits.get(space.id)};}
function spaceGroupsFor(space){return spaceSelectionFor(space).groups||[];}
function spaceDocumentLabels(document){const labels=projectLabels(document);return labels.length?labels:['未分类'];}
function spaceGroupIncludes(group,document){return !(group.excludedProjectIds||[]).includes(document.id)&&(group.mode==='all'?(spaceDocumentLabels(document).includes(group.label)||group.projectIds.includes(document.id)):group.projectIds.includes(document.id));}
function spaceProjectLabelsFor(space,document){const selected=spaceSelectionFor(space);return (selected.excludedProjectIds||[]).includes(document.id)?[]:selected.groups.filter(group=>spaceGroupIncludes(group,document)).map(group=>group.label);}
function spaceContains(space,document){return spaceProjectLabelsFor(space,document).length>0;}
function projectSpaces(document){return allDisplaySpaces().filter(space=>spaceContains(space,document));}
function privacyBadge(document){const spaces=projectSpaces(document);return `<span class="privacy-badge" title="${esc(spaces.map(space=>space.name).join('、'))}">${spaces.length?spaces.length+'个空间':'未展示'}</span>`;}
function spaceHasPending(){return !!(spaceEdits.size||spaceSaveWork||spaceNameEdit||spaceCodeEdit||spaceCodeWork);}
function renderDocumentPrivacy(){
 if(!db.capabilities?.shareSpaces)return '<section class="document-privacy"><p class="inline-note">重新启动后台并刷新页面，加载分享空间功能。</p></section>';
 const spaces=projectSpaces(editor);
 return `<section class="document-privacy"><div class="field-label"><strong>所属分享空间</strong><span class="privacy-status">${spaces.length}个空间</span></div>${spaces.map(space=>`<div class="editor-space-row" data-editor-space-row="${space.id}"><div class="editor-space-title"><span>${esc(space.main?'主站':space.name)}</span><small>${space.accessMode==='public'?'公开分享':'访问码访问'}${space.enabled?'':' · 已关闭'}</small></div><div class="editor-space-tags">${spaceProjectLabelsFor(space,editor).map(label=>`<span>${esc(label)}</span>`).join('')}</div></div>`).join('')||'<p class="inline-note">暂未加入任何分享空间</p>'}<button type="button" class="space-manage-link space-text-link" data-action="space-manage" data-id="${editor.id}">管理分享空间</button></section>`;
}
function updateDocumentSpaces(){const node=$('.document-privacy');if(node&&editor){const markup=renderDocumentPrivacy();if(node.outerHTML!==markup)node.outerHTML=markup;}window.PortfolioSitePreview?.syncContext();}
function renderSpaceCode(space){
 if(!db.capabilities?.spacePin)return '<span class="inline-note">重启后台后设置四位访问码</span>';
 const pending=spaceCodeEdit?.id===space.id&&spaceCodeEdit.accessMode==='private',editable=space.accessMode==='private'||pending;let value;
 if(editable&&spaceCodeEdit?.id===space.id){const state=spaceCodeEdit;value=`<form class="category-inline-form space-code-inline" data-space-code-editor><input class="category-inline-input" aria-label="修改空间访问码" type="text" autocomplete="off" inputmode="numeric" pattern="[0-9]{4}" minlength="4" maxlength="4" value="${esc(state.value)}" placeholder="4位数字" ${spaceCodeWork?'disabled':''}><button type="submit" class="category-inline-done" aria-label="完成访问码修改" ${spaceCodeWork?'disabled':''}>${icon('check')}</button>${state.error?`<span class="category-inline-error" role="alert">${esc(state.error)}</span>`:''}</form>`;}
 else value=`<button type="button" class="space-code-value" data-action="space-code" data-id="${space.id}" ${editable?'':'disabled'} aria-label="${editable?'双击修改':'当前不可修改'}空间访问码" title="${editable?'双击修改访问码':'访问码已关闭，开启后可编辑'}">${esc(space.code||'未设置')}</button>`;
 return `<div class="space-access-code">${value}${pending?'<small class="space-code-pending">设置后开启</small>':''}</div>`;
}
function spaceNameInput(){return `<form class="category-inline-form" data-space-name-editor><input class="category-inline-input" aria-label="${spaceNameEdit.id?'修改空间名称':'新空间名称'}" maxlength="40" placeholder="输入空间名称" value="${esc(spaceNameEdit.value)}" ${spaceNameSaving?'disabled':''}><button class="category-inline-done" type="submit" aria-label="完成空间名称" ${spaceNameSaving?'disabled':''}>${icon('check')}</button>${spaceNameEdit.error?`<span class="category-inline-error" role="alert">${esc(spaceNameEdit.error)}</span>`:''}</form>`;}

function renderSpaceChips(){return `<div class="share-space-tabs space-chips" role="tablist" aria-label="分享空间">${allDisplaySpaces().map(space=>spaceNameEdit?.id===space.id?spaceNameInput():`<span class="share-space-tab-wrap"><button class="share-space-tab ${activeSpaceId===space.id?'active':''}" role="tab" tabindex="${activeSpaceId===space.id?0:-1}" data-action="space-select" data-id="${space.id}" aria-controls="share-space-panel" aria-selected="${activeSpaceId===space.id}" aria-pressed="${activeSpaceId===space.id}"><span class="share-space-tab-name">${esc(space.main?'主站':space.name)}</span><small>${activeProjects().filter(row=>spaceContains(space,row.draft)).length}</small></button>${space.main?'':`<button class="category-delete" data-action="space-delete" data-id="${space.id}" aria-label="删除空间 ${esc(space.name)}">${icon('close')}</button>`}</span>`).join('')}${spaceNameEdit?.id===null?spaceNameInput():`<button class="share-space-add" data-action="space-new" aria-label="创建分享空间" title="创建分享空间">${icon('plus')}</button>`}</div>`;}
function renderSpaceWork(row,label,space){
 const asset=coverFor(row.draft),chosen=spaceProjectLabelsFor(space,row.draft).includes(label);
 return `<div class="space-work ${chosen?'is-checked':'is-excluded'}" data-space-work="${row.id}" data-label="${esc(label)}" role="checkbox" tabindex="0" aria-checked="${chosen}" aria-label="${esc(label+'：'+row.draft.title)}" title="${chosen?'点击从当前空间排除此作品':'点击恢复此作品在当前空间的展示'}" data-action="space-toggle-work" data-id="${row.id}"><input type="checkbox" tabindex="-1" aria-hidden="true" ${chosen?'checked':''}><span class="space-work-thumb">${asset?`<img src="${esc(asset.url)}" alt="" draggable="false" loading="lazy">`:icon('image')}</span><span class="space-work-text"><strong>${esc(row.draft.title)}</strong><small>${chosen?(row.live?'已发布':'草稿'):'已从此空间排除'}</small></span><button type="button" class="icon-btn space-work-edit" data-action="edit" data-id="${row.id}" aria-label="编辑 ${esc(row.draft.title)}" title="编辑作品">${icon('edit')}</button></div>`;
}
function renderSpaceLabelChoices(space,rows){
 const groups=spaceGroupsFor(space),labels=[...new Set([...allLabelOptions(),...rows.flatMap(row=>spaceDocumentLabels(row.draft)),...groups.map(group=>group.label)])];
 return `<div class="share-label-selection"><div class="share-label-caption"><span>包含标签</span><button class="share-label-help" type="button" aria-label="标签自动包含规则" title="自动包含标签下的新作品，可单独排除作品。排除只影响当前空间。">ⓘ</button></div><div class="share-label-choices" role="group" aria-label="选择当前空间包含的标签">${labels.map(label=>{const chosen=groups.some(group=>group.label===label);return `<button type="button" class="share-label-choice ${chosen?'is-selected':''}" role="checkbox" aria-checked="${chosen}" data-action="space-toggle-label" data-label="${esc(label)}"><span class="share-label-check" aria-hidden="true">${chosen?icon('check'):''}</span><span>${esc(label)}</span></button>`;}).join('')||'<span class="inline-note">先在作品管理中创建标签</span>'}</div></div>`;
}
function renderSpaces(){
 if(!db.capabilities?.shareSpaces)return heading('分享空间','')+'<p class="inline-note">关闭原启动窗口，重新运行“启动后台.cmd”并刷新页面，加载分享空间功能。</p>';
 const space=allDisplaySpaces().find(space=>space.id===activeSpaceId)||db.spaces.main;activeSpaceId=space.id;
 const groups=spaceGroupsFor(space),rows=activeProjects(),count=rows.filter(row=>spaceContains(space,row.draft)).length;
 const columns=groups.map(group=>{const all=rows.filter(row=>spaceDocumentLabels(row.draft).includes(group.label)||group.projectIds.includes(row.id)),selected=all.filter(row=>spaceProjectLabelsFor(space,row.draft).includes(group.label)),filtered=all.filter(row=>!spaceSearch||`${row.draft.title} ${spaceDocumentLabels(row.draft).join(' ')} ${group.label}`.toLowerCase().includes(spaceSearch.toLowerCase()));return `<section class="space-column" data-space-column="${esc(group.label)}"><div class="space-column-head"><strong>${esc(group.label)}</strong><small>${selected.length}/${all.length}</small></div><div class="space-column-body" data-space-column-scroll="${esc(group.label)}">${filtered.map(row=>renderSpaceWork(row,group.label,space)).join('')||'<p class="space-column-empty">'+(spaceSearch?'没有匹配作品':'此标签的新作品会自动加入')+'</p>'}</div></section>`;}).join('');
 const search=`<label class="search space-page-search">${icon('search')}<input id="space-search" value="${esc(spaceSearch)}" aria-label="搜索空间作品" placeholder="搜索作品名称、标签"></label>`;
 const link=(db.spaces.siteUrl||location.origin+'/site')+(space.main?'/':'/space/'+space.id+'/');
 const controls=`<div class="space-inline-controls">${space.main?'<span class="inline-note">主站 · 公开分享</span>':`<button type="button" class="space-text-link" data-action="space-main-choice" title="使用主站当前的标签选择，作品排除状态保持不变">复制主站标签</button><button type="button" role="switch" class="first-image-switch" data-action="space-enabled" data-id="${space.id}" aria-checked="${space.enabled}"><span class="switch-track" aria-hidden="true"></span><span>启用此空间</span></button><button type="button" role="switch" class="first-image-switch" data-action="space-access" data-id="${space.id}" aria-label="访问码" aria-checked="${space.accessMode==='private'}" title="开启后需访问码，关闭后公开访问"><span class="switch-track" aria-hidden="true"></span><span>访问码</span></button>${renderSpaceCode(space)}`}${btn('复制链接','space-copy','small','copy',`data-id="${space.id}" title="分享链接：${esc(link)}"`)}</div>`;
 return heading('分享空间','',search)+renderSpaceChips()+`<div class="share-space-content" id="share-space-panel" role="tabpanel">${renderSpaceLabelChoices(space,rows)}<div class="content-card space-workspace"><div class="list-toolbar"><strong>${count} 件作品</strong><span class="toolbar-spacer"></span>${controls}${spaceSaveError?btn('重试保存','space-retry','small')+btn('放弃更改','space-discard','small text'):''}</div>${spaceSaveError?`<p class="form-error space-board-error">${esc(spaceSaveError)}</p>`:''}<div class="space-board" aria-label="已选标签下的作品">${columns||'<p class="share-space-empty">请选择标签，添加此空间的作品</p>'}</div></div></div>`;
}
function syncSpaceBoard(){}
function refreshSpaceView(keepChips=false){
 if(view!=='spaces'||editor)return;
 const left=$('.space-board')?.scrollLeft||0,positions=new Map([...document.querySelectorAll('[data-space-column-scroll]')].map(node=>[node.dataset.spaceColumnScroll,node.scrollTop])),focus=document.activeElement,searching=focus?.id==='space-search',caret=searching?focus.selectionStart:null,focusedWork=focus?.dataset.spaceWork,focusedLabel=focus?.dataset.label;
 if(keepChips&&$('.space-chips')){const page=document.createElement('div');page.innerHTML=renderSpaces();for(const selector of ['.page-heading','.share-space-content'])$('#page').querySelector(selector)?.replaceWith(page.querySelector(selector));document.querySelectorAll('.space-chips [data-action=space-select]').forEach(button=>{const active=button.dataset.id===activeSpaceId;button.classList.toggle('active',active);button.setAttribute('aria-selected',String(active));button.setAttribute('aria-pressed',String(active));button.tabIndex=active?0:-1;});}else $('#page').innerHTML=renderSpaces();
 if($('.space-board'))$('.space-board').scrollLeft=left;document.querySelectorAll('[data-space-column-scroll]').forEach(node=>node.scrollTop=positions.get(node.dataset.spaceColumnScroll)||0);
 if(searching){$('#space-search')?.focus({preventScroll:true});$('#space-search')?.setSelectionRange(caret,caret);}else if(focusedWork)[...document.querySelectorAll('[data-space-work]')].find(node=>node.dataset.spaceWork===focusedWork&&node.dataset.label===focusedLabel)?.focus({preventScroll:true});else if(focusedLabel)[...document.querySelectorAll('.share-label-choice')].find(node=>node.dataset.label===focusedLabel)?.focus({preventScroll:true});
 window.PortfolioSitePreview?.syncContext();
}
function queueSpaceSelection(id,selection){spaceEdits.set(id,{...copy(selection),selectionMode:'tags',sequence:++spaceSequence});spaceSaveError='';refreshSpaceView();clearTimeout(spaceSaveTimer);spaceSaveTimer=setTimeout(()=>flushSpaceChanges().catch(()=>{}),250);}
async function flushSpaceChanges(){if(spaceNameWork)await spaceNameWork;if(spaceCodeWork)await spaceCodeWork;return flushSpaceGroups();}
function flushSpaceGroups(){
 clearTimeout(spaceSaveTimer);spaceSaveTimer=null;if(spaceSaveWork)return spaceSaveWork;if(!spaceEdits.size)return;
 spaceSaveWork=(async()=>{while(spaceEdits.size){const [id,edit]=spaceEdits.entries().next().value;await api('/api/spaces/'+id,'PUT',{groups:edit.groups,excludedProjectIds:edit.excludedProjectIds||[],selectionMode:'tags',revision:db.spaces.revision});await loadState(false);if(spaceEdits.get(id)?.sequence===edit.sequence)spaceEdits.delete(id);spaceSaveError='';refreshSpaceView();}})().catch(async error=>{spaceSaveError=error.message;if(error.status===409)await loadState(false).catch(()=>{});throw error;}).finally(()=>{spaceSaveWork=null;refreshSpaceView();});refreshSpaceView();return spaceSaveWork;
}
async function beginSpaceCode(id,enable=false){await flushSpaceChanges();const space=db.spaces.items.find(item=>item.id===id);if(!space||space.accessMode!=='private'&&!enable)return;spaceCodeEdit={id,value:space.code||'',error:'',...(enable?{accessMode:'private'}:{})};refreshSpaceView();const input=$('[data-space-code-editor] input');input?.focus({preventScroll:true});input?.select();}
function saveSpaceCode(){
  if(spaceCodeWork)return spaceCodeWork;const state=spaceCodeEdit;if(!state)return Promise.resolve();const space=db.spaces.items.find(item=>item.id===state.id);if(!space)return Promise.resolve();
  if(!state.value.trim()||state.value===space.code){spaceCodeEdit=null;refreshSpaceView();return Promise.resolve();}
  if(!/^[0-9]{4}$/.test(state.value)){state.error='访问码需为4位数字';refreshSpaceView();return Promise.resolve();}
  spaceCodeWork=(async()=>{try{await flushSpaceGroups();await api('/api/spaces/'+state.id,'PUT',{code:state.value,...(state.accessMode?{accessMode:state.accessMode}:{}),revision:db.spaces.revision});await loadState(false);spaceCodeEdit=null;}catch(error){state.error=error.message;throw error;}finally{spaceCodeWork=null;refreshSpaceView();}})();return spaceCodeWork;
}

function changeSpaceChoice(id,label,projectId=null,force=null){
 const space=allDisplaySpaces().find(item=>item.id===id);if(!space)return;const current=spaceSelectionFor(space),groups=copy(current.groups),excluded=new Set(current.excludedProjectIds||[]);
 if(!projectId){const index=groups.findIndex(group=>group.label===label);if(index>=0)groups.splice(index,1);else groups.push({label,mode:'all',projectIds:[]});}
 else{const document=activeProjects().find(row=>row.id===projectId)?.draft;if(!document)return;const wanted=force??!spaceProjectLabelsFor(space,document).includes(label);if(wanted){excluded.delete(projectId);for(const group of groups)group.excludedProjectIds=(group.excludedProjectIds||[]).filter(id=>id!==projectId);}else excluded.add(projectId);}
 queueSpaceSelection(id,{groups,excludedProjectIds:[...excluded]});
}
async function beginSpaceName(id=null){await flushSpaceChanges();const space=db.spaces.items.find(item=>item.id===id);spaceNameEdit={id,value:space?.name||'',error:''};refreshSpaceView();const input=$('[data-space-name-editor] input');input?.focus();input?.select();}
async function saveSpaceName(){
  if(!spaceNameEdit||spaceNameSaving)return;const state=spaceNameEdit,name=state.value.trim();if(!name){spaceNameEdit=null;refreshSpaceView();return;}
  if(db.spaces.items.some(item=>item.name===name&&item.id!==state.id)){state.error='已存在同名空间';refreshSpaceView();return;}
  if(!state.id){spaceNameEdit=null;refreshSpaceView();return openSpaceEditor(null,name);}
  spaceNameSaving=true;spaceNameWork=(async()=>{try{await api('/api/spaces/'+state.id,'PUT',{name,revision:db.spaces.revision});await loadState(false);spaceNameEdit=null;refreshSpaceView();}catch(error){state.error=error.message;throw error;}finally{spaceNameSaving=false;spaceNameWork=null;refreshSpaceView();}})();return spaceNameWork;
}
function openSpaceEditor(id=null,name=''){
  openDialog(`${modalHead('创建分享空间','选择公开或访问码访问，再选择需要包含的作品标签。')}<form id="space-form"><div class="modal-body"><label class="field"><span>空间名称</span><input name="spaceName" maxlength="40" required value="${esc(name)}"></label><label class="backup-option"><input type="checkbox" name="enabled" checked><span>启用此空间</span></label><label class="field"><span>访问方式</span><select name="accessMode"><option value="private">访问码访问</option><option value="public">公开分享</option></select></label><label class="backup-option"><input type="checkbox" name="includeMain" checked><span>复制主站标签</span></label><label class="field" data-create-space-code><span>访问码</span><div class="space-code-field"><input name="code" type="password" autocomplete="new-password" inputmode="numeric" pattern="[0-9]{4}" minlength="4" maxlength="4" required><button type="button" class="btn small" data-action="space-show-code">显示</button></div><small>4位数字，可包含开头的0。访问码不随分享链接发送。</small></label><p class="form-error" hidden></p></div><footer class="modal-foot">${btn('取消','close-dialog')}<button class="btn primary" type="submit">创建空间</button></footer></form>`);
}
function openSpaceServerSettings(){openDialog(`${modalHead('服务器设置','全站共用，所有私密空间只需配置一次。')}<form id="space-server-form"><div class="modal-body"><label class="field"><span>网站地址</span><input name="url" type="url" value="${esc(db.spaces?.siteUrl||'')}" placeholder="https://example.com"></label><p class="inline-note">填写后，各空间自动生成对应分享链接。留空时使用本机预览地址。</p><h3>私密访问服务</h3><p>首次在线使用时，下载并按说明配置服务器访问服务。此操作下载文件，不会自动修改服务器。</p><a class="btn" href="/api/spaces/server-config">${icon('download')}下载服务器配置与说明</a><p class="form-error" hidden></p></div><footer class="modal-foot">${btn('取消','close-dialog')}<button class="btn primary" type="submit">保存设置</button></footer></form>`);}
async function spaceAction(name,element){
  if(!db.capabilities?.shareSpaces)throw new Error('请重新启动后台并刷新页面，加载分享空间功能。');
  const id=element.dataset.id,label=element.dataset.label;
  if(name==='space-access'){await flushSpaceChanges();if(spaceCodeEdit?.id===id){const pendingMode=spaceCodeEdit.accessMode;await saveSpaceCode();if(spaceCodeEdit||pendingMode)return;}const space=db.spaces.items.find(space=>space.id===id);if(space.accessMode==='public'&&!space.code)return beginSpaceCode(id,true);await api('/api/spaces/'+id,'PUT',{accessMode:space.accessMode==='public'?'private':'public',revision:db.spaces.revision});await loadState(false);return refreshSpaceView();}
  if(name==='space-main-choice'){const space=allDisplaySpaces().find(space=>space.id===activeSpaceId);return queueSpaceSelection(space.id,{groups:spaceGroupsFor(db.spaces.main).map(group=>({label:group.label,mode:'all',projectIds:[]})),excludedProjectIds:spaceSelectionFor(space).excludedProjectIds||[]});}
  if(name==='space-toggle-work')return changeSpaceChoice(activeSpaceId,label,id);
  if(name==='space-toggle-label')return changeSpaceChoice(activeSpaceId,label);
  if(name==='space-retry')return flushSpaceChanges();
  if(name==='space-discard'){clearTimeout(spaceSaveTimer);spaceEdits.clear();spaceSaveError='';await loadState(false);return refreshSpaceView();}
  if(name==='space-new')return beginSpaceName();
  if(name==='space-select'){await flushSpaceChanges();if(activeSpaceId===id&&!spaceNameEdit)return;activeSpaceId=id;spaceSearch='';const keep=!spaceNameEdit;spaceNameEdit=null;return refreshSpaceView(keep);}
  if(name==='space-enabled'){element.disabled=true;try{await flushSpaceChanges();const space=db.spaces.items.find(item=>item.id===id);await api('/api/spaces/'+id,'PUT',{enabled:!space.enabled,revision:db.spaces.revision});await loadState(false);refreshSpaceView();return toast('空间状态已保存，发布后生效');}finally{element.disabled=false;}}
  if(name==='space-code')return;
  if(name==='space-manage'){if(editor&&dirty)await saveProject(true);const row=db.projects.find(item=>item.id===id),target=element.dataset.spaceId||(row?projectSpaces(row.draft)[0]?.id:'main');if(!await navigate('spaces'))return;activeSpaceId=target||'main';spaceSearch=row?.draft.title||'';return refreshSpaceView();}
  if(name==='space-server-settings'){await flushSpaceChanges();return openSpaceServerSettings();}
  if(name==='space-show-code'){const input=element.parentElement.querySelector('input');input.type=input.type==='password'?'text':'password';element.textContent=input.type==='password'?'显示':'隐藏';return;}
  if(name==='space-copy'){const url=(db.spaces.siteUrl||location.origin+'/site')+(id==='main'?'/':'/space/'+id+'/');await navigator.clipboard.writeText(url);return toast(db.spaces.siteUrl?(allDisplaySpaces().find(space=>space.id===id)?.accessMode==='private'?'空间链接已复制，请另行发送访问码':'空间链接已复制'):'本机预览链接已复制，仅当前电脑可用');}
  if(name==='space-delete'){await flushSpaceChanges();if(!await confirmAction('删除这个空间？','空间将在发布后移除，不改变其他空间的作品选择。','删除空间',true))return;await api('/api/spaces/'+id,'DELETE',{revision:db.spaces.revision});await loadState();return toast('空间已删除，其他空间保持原样，发布后生效');}

}
document.addEventListener('submit',event=>{
  const form=event.target;
  if(form.matches?.('[data-space-code-editor]')){event.preventDefault();event.stopImmediatePropagation();saveSpaceCode().catch(error=>toast(error.message,true));return;}
  if(form.matches?.('[data-space-name-editor]')){event.preventDefault();event.stopImmediatePropagation();saveSpaceName().catch(error=>toast(error.message,true));return;}
  if(!['space-form','space-server-form'].includes(form.id))return;
  event.preventDefault();event.stopImmediatePropagation();const data=new FormData(form),submit=form.querySelector('[type=submit]');submit.disabled=true;
  (async()=>{
    await flushSpaceChanges();
    if(form.id==='space-server-form')await api('/api/spaces/site-url','PUT',{url:String(data.get('url')||'').trim()});
    else if(form.id==='space-form'){const result=await api('/api/spaces'+(form.dataset.id?'/'+form.dataset.id:''),form.dataset.id?'PUT':'POST',{name:data.get('spaceName'),code:data.get('code'),enabled:data.has('enabled'),accessMode:data.get('accessMode')||'private',includeMain:data.has('includeMain'),selectionMode:'tags',revision:db.spaces.revision});if(!form.dataset.id)activeSpaceId=result.items.find(space=>space.name===String(data.get('spaceName')).trim()).id;}

    await loadState(false);if(editor){const row=db.projects.find(row=>row.id===editor.id);if(row){editor={...copy(row.draft),revision:row.revision};dirty=false;}}
    closeDialog();render();toast('设置已保存，发布后生效');
  })().catch(error=>{const node=form.querySelector('.form-error');node.hidden=false;node.textContent=error.message;}).finally(()=>submit.disabled=false);
},true);
document.addEventListener('input',event=>{if(event.target.id==='space-search'){spaceSearch=event.target.value;refreshSpaceView();}if(event.target.matches?.('[data-space-code-editor] input')&&spaceCodeEdit){spaceCodeEdit.value=event.target.value;spaceCodeEdit.error='';event.target.closest('form').querySelector('.category-inline-error')?.remove();}if(event.target.matches?.('[data-space-name-editor] input')&&spaceNameEdit)spaceNameEdit.value=event.target.value;});
document.addEventListener('dblclick',event=>{const chip=event.target.closest?.('.space-chips [data-action=space-select]');if(chip?.dataset.id&&chip.dataset.id!=='main'){event.preventDefault();beginSpaceName(chip.dataset.id).catch(error=>toast(error.message,true));}});
document.addEventListener('focusout',event=>{const codeForm=event.target.closest?.('[data-space-code-editor]');if(codeForm&&!codeForm.contains(event.relatedTarget))saveSpaceCode().catch(error=>toast(error.message,true));const form=event.target.closest?.('[data-space-name-editor]');if(form&&!form.contains(event.relatedTarget))saveSpaceName().catch(error=>toast(error.message,true));});
document.addEventListener('keydown',event=>{if(event.target.closest?.('[data-space-code-editor]')){if(event.key==='Escape'&&!spaceCodeWork){event.preventDefault();spaceCodeEdit=null;refreshSpaceView();}return;}if(event.target.closest?.('[data-space-name-editor]')){if(event.key==='Escape'){event.preventDefault();spaceNameEdit=null;refreshSpaceView();}return;}if(event.target.matches?.('[data-space-work]')&&['Enter',' '].includes(event.key)){event.preventDefault();event.target.click();}});

document.addEventListener('change',event=>{if(event.target.matches?.('#space-form [name=accessMode]')){const row=$('[data-create-space-code]'),input=row.querySelector('[name=code]'),privateMode=event.target.value==='private';row.hidden=!privateMode;input.required=privateMode;input.disabled=!privateMode;}});

document.addEventListener('keydown',event=>{const tab=event.target.closest?.('.share-space-tab');if(!tab||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const tabs=[...document.querySelectorAll('.share-space-tab')],index=tabs.indexOf(tab),next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;tabs[next]?.focus({preventScroll:true});tabs[next]?.click();});

document.addEventListener('dblclick',event=>{const value=event.target.closest?.('[data-action=space-code]');if(!value||value.disabled)return;event.preventDefault();beginSpaceCode(value.dataset.id).catch(error=>toast(error.message,true));});
document.addEventListener('keydown',event=>{const value=event.target.closest?.('[data-action=space-code]');if(!value||value.disabled||!['Enter','F2'].includes(event.key))return;event.preventDefault();beginSpaceCode(value.dataset.id).catch(error=>toast(error.message,true));});
