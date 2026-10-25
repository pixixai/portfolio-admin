// Shared library and editor picker. Folder organization never changes asset URLs.
const newMediaBrowser = () => ({ folderId: null, mode: 'grid', thumbnailSize: 180, compact: false, filter: 'all', sort: 'manual', descending: false, query: '', creating: false, folderName: '', error: '', selection: new Set(), selectionAnchor: null });
const libraryBrowser = newMediaBrowser();
const mediaBrowserState = picking => picking ? picker?.browser : libraryBrowser;
const mediaButton = (label, action, picking, symbol = '', extra = '') => `<button class="btn small" data-media-action="${action}" data-media-scope="${picking ? 'picker' : 'library'}" ${extra}>${symbol ? icon(symbol) : ''}${label}</button>`;
const matchesMediaKind = (type, kind) => kind === 'all' || kind === type || kind === 'background' && ['image', 'video'].includes(type);
function mediaBrowserEntries(picking) {
  const state = mediaBrowserState(picking), query = state.query.trim().toLowerCase();
  const folderRows = (db.folders || []).filter(row => row.parentId === state.folderId && (!query || row.name.toLowerCase().includes(query))).map(row => ({ ...row, kind: 'folder', size: 0 }));
  const assets = db.media.filter(asset => (asset.folderId || null) === state.folderId && (picking ? availableAsset(asset) && matchesMediaKind(mediaKind(asset), picker.kind) : asset.library && (!unusedOnly || !asset.references.projects.length && !asset.references.inHistory && !asset.references.inSettings)) && (!query || asset.name.toLowerCase().includes(query))).map(row => ({ ...row, kind: 'asset' }));
  const compare = (a, b) => {
    const key = state.sort;
    const av = key === 'type' ? (a.kind === 'folder' ? '文件夹' : a.mime) : key === 'manual' ? a.sortOrder || 0 : a[key];
    const bv = key === 'type' ? (b.kind === 'folder' ? '文件夹' : b.mime) : key === 'manual' ? b.sortOrder || 0 : b[key];
    const result = typeof av === 'number' ? av - bv : String(av).localeCompare(String(bv), 'zh-CN', { numeric: true });
    return (state.descending ? -result : result) || a.id.localeCompare(b.id);
  };
  return [...(state.filter === 'assets' ? [] : folderRows.sort(compare)), ...(state.filter === 'folders' ? [] : assets.sort(compare))];
}
function mediaBreadcrumbs(picking) {
  const state = mediaBrowserState(picking), chain = []; let current = state.folderId;
  while (current) { const folder = (db.folders || []).find(row => row.id === current); if (!folder) { state.folderId = null; break; } chain.unshift(folder); current = folder.parentId; }
  return `<nav class="media-breadcrumbs" aria-label="文件夹路径"><button data-media-action="open" data-folder="" data-folder-drop="">${icon('folder')}全部素材</button>${chain.map(folder => `<span>/</span><button data-media-action="open" data-folder="${folder.id}" data-folder-drop="${folder.id}">${esc(folder.name)}</button>`).join('')}</nav>`;
}
function mediaSelectionControl(key, name, picking, grid = false) {
  const state = mediaBrowserState(picking), [kind,id] = key.split(':');
  return `<label class="${grid ? 'media-card-select' : 'media-row-select'}"><input type="checkbox" data-media-select="${key}" ${picking && kind==='asset' ? `data-pick="${id}"` : ''} ${state.selection.has(key) ? 'checked' : ''} aria-label="选择 ${esc(name)}"></label>`;
}
function toggleMediaSelection(key,picking,checked) {
  const state=mediaBrowserState(picking);checked ? state.selection.add(key) : state.selection.delete(key);
  if(picking && key.startsWith('asset:')) {
    const id=key.slice(6);if(checked){if(!picker.multiple)picker.selected.clear();picker.selected.add(id);}else {
      picker.selected.delete(id);
      if(!picker.multiple&&!picker.selected.size){const fallback=[...state.selection].filter(key=>key.startsWith('asset:')).at(-1);if(fallback)picker.selected.add(fallback.slice(6));}
    }
  }
}
function selectMediaItem(key, picking, checked, shiftKey = false) {
  const state = mediaBrowserState(picking), keys = mediaBrowserEntries(picking).map(row => `${row.kind}:${row.id}`);
  const start = keys.indexOf(state.selectionAnchor), end = keys.indexOf(key);
  if (shiftKey && state.selection.size && start >= 0 && end >= 0) {
    keys.slice(Math.min(start,end), Math.max(start,end)+1).forEach(item => toggleMediaSelection(item,picking,true));
    // A cover picker still uses the clicked endpoint as its single cover.
    if (picking && !picker.multiple && key.startsWith('asset:')) toggleMediaSelection(key,picking,true);
  } else {
    toggleMediaSelection(key,picking,shiftKey ? true : checked);
    state.selectionAnchor = state.selection.size ? key : null;
  }
}
function mediaAssetCard(asset,picking) {
  const state=mediaBrowserState(picking),kind=mediaKind(asset),key=`asset:${asset.id}`,selected=state.selection.has(key);
  const reference=!asset.library?'当前作品暂存':asset.references?.projects.length?`${asset.references.projects.length} 个作品引用`:asset.references?.inSettings?'首页背景引用':asset.references?.inHistory?'历史版本保留':'未使用';
  const visual=kind==='image'?`<img draggable="false" src="${asset.url}" alt="${esc(asset.name)}" loading="lazy">`:kind==='video'?`<video src="${asset.url}" muted playsinline preload="metadata"></video>`:`<div class="media-cover-symbol">${icon('audio')}</div>`;
  return `<article class="media-item media-cover-card ${selected?'is-manager-selected':''}" draggable="true" data-media-key="${key}" data-media-asset="${asset.id}" tabindex="0" role="button" aria-label="预览 ${esc(asset.name)}"><div class="media-cover-visual">${visual}</div><div class="media-card-shade" aria-hidden="true"></div>${mediaSelectionControl(key,asset.name,picking,true)}<span class="media-card-reference">${esc(reference)}</span>${!picking?`<button class="media-delete" data-action="delete-media" data-id="${asset.id}" title="删除素材" ${asset.references?.projects.length||asset.references?.inSettings||asset.references?.inHistory?'disabled':''}>${icon('trash')}</button>`:''}<div class="media-card-caption"><small>${kind==='image'?`${asset.width} × ${asset.height}`:kind==='video'?'视频':'音频'}</small><p class="media-name" title="${esc(asset.name)}">${esc(asset.name)}</p></div><span class="media-card-size">${sizeLabel(asset.size)}</span></article>`;
}
function mediaFolderCard(folder,picking) {
  const count = (db.folders || []).filter(row => row.parentId === folder.id).length + db.media.filter(asset => asset.folderId === folder.id && availableAsset(asset)).length;
  return `<article class="media-item media-folder ${mediaBrowserState(picking).selection.has('folder:'+folder.id)?'is-manager-selected':''}" draggable="true" data-media-key="folder:${folder.id}" data-media-action="open" data-folder="${folder.id}" tabindex="0" role="button" aria-label="打开文件夹 ${esc(folder.name)}"><div class="media-folder-art">${icon('folder')}</div>${mediaSelectionControl('folder:'+folder.id,folder.name,picking,true)}<div class="media-info"><p class="media-name">${esc(folder.name)}</p><div class="media-detail"><span>文件夹</span><span>${count} 项</span></div></div></article>`;
}
function mediaBrowserList(entries, picking) {
  const state = mediaBrowserState(picking), columns = [['name', '文件名'], ['type', '类型'], ['size', '大小'], ['createdAt', '上传时间']];
  if (state.compact) return mediaBrowserCompactList(entries, picking);
  return `<div class="media-list-scroll"><table class="media-list"><thead><tr><th class="media-check-cell"><input type="checkbox" data-media-select-all aria-label="全选当前结果" ${entries.length&&entries.every(row=>state.selection.has(`${row.kind}:${row.id}`))?'checked':''}></th>${columns.map(([key, label]) => `<th aria-sort="${state.sort === key ? state.descending ? 'descending' : 'ascending' : 'none'}"><button data-media-action="sort" data-sort="${key}">${label}${state.sort === key ? state.descending ? ' ↓' : ' ↑' : ''}</button></th>`).join('')}<th>尺寸</th>${!picking ? '<th>操作</th>' : ''}</tr></thead><tbody>${entries.map(row => {
    const folder = row.kind === 'folder', selected = state.selection.has(`${row.kind}:${row.id}`);
    return `<tr draggable="true" data-media-key="${row.kind}:${row.id}" class="${folder ? 'media-folder' : ''} ${selected ? 'selected' : ''}" ${folder ? `data-media-action="open" data-folder="${row.id}" tabindex="0" role="button"` : `data-media-asset="${row.id}" tabindex="0"`}><td class="media-check-cell">${mediaSelectionControl(`${row.kind}:${row.id}`,row.name,picking)}</td><td><span class="media-list-name">${folder ? icon('folder') : mediaKind(row) === 'image' ? `<img draggable="false" src="${row.url}" alt="">` : icon(mediaKind(row))}<span>${esc(row.name)}</span></span></td><td>${folder ? '文件夹' : row.mime}</td><td>${folder ? '—' : sizeLabel(row.size)}</td><td>${shortDate(row.createdAt)}</td><td>${!folder && row.width ? `${row.width} × ${row.height}` : '—'}</td>${!picking ? `<td>${!folder ? `<button class="icon-btn" data-action="delete-media" data-id="${row.id}" aria-label="删除媒体" ${row.references.projects.length || row.references.inSettings || row.references.inHistory ? 'disabled' : ''}>${icon('trash')}</button>` : ''}</td>` : ''}</tr>`;
  }).join('')}</tbody></table></div>`;
}
function mediaBrowserCompactList(entries, picking) {
  const state = mediaBrowserState(picking);
  return `<div class="media-compact"><label class="media-compact-all"><input type="checkbox" data-media-select-all aria-label="全选当前结果" ${entries.length && entries.every(row => state.selection.has(`${row.kind}:${row.id}`)) ? 'checked' : ''}>全选当前结果</label><div class="media-compact-grid">${entries.map(row => {
    const folder = row.kind === 'folder', key = `${row.kind}:${row.id}`, selected = state.selection.has(key);
    const visual = folder ? icon('folder') : mediaKind(row) === 'image' ? `<img draggable="false" src="${row.url}" alt="" loading="lazy">` : icon(mediaKind(row));
    return `<div class="media-compact-item ${folder ? 'media-folder' : ''} ${selected ? 'is-selected' : ''}" draggable="true" data-media-key="${key}" ${folder ? `data-media-action="open" data-folder="${row.id}"` : `data-media-asset="${row.id}"`} tabindex="0" role="button" aria-label="${folder ? '打开文件夹' : '预览'} ${esc(row.name)}">${mediaSelectionControl(key, row.name, picking)}<span class="media-compact-visual">${visual}</span><span class="media-name" title="${esc(row.name)}">${esc(row.name)}</span></div>`;
  }).join('')}</div></div>`;
}
function mediaBrowserViewControls(state) {
  return `<div class="media-view-controls">${state.mode === 'grid' ? `<label class="media-size-control"><span>缩略图大小</span><input type="range" data-media-size min="120" max="300" step="20" value="${state.thumbnailSize}" aria-label="缩略图大小"><output>${state.thumbnailSize}</output></label>` : `<label class="media-compact-control" title="隐藏属性，以小图标和文件名从左到右排列"><span>列表预览</span><input type="checkbox" role="switch" data-media-compact aria-label="列表预览" ${state.compact ? 'checked' : ''}><span class="media-switch-track" aria-hidden="true"></span></label>`}<div class="segmented">${['grid','list'].map(mode => `<button data-media-action="view" data-mode="${mode}" class="${state.mode === mode ? 'active' : ''}" aria-label="${mode === 'grid' ? '缩略图视图' : '列表视图'}">${icon(mode)}</button>`).join('')}</div></div>`;
}
function renderMediaBrowser(picking = false) {
  const state = mediaBrowserState(picking), valid=new Set([...(db.folders||[]).map(row=>'folder:'+row.id),...db.media.map(row=>'asset:'+row.id)]);
  if(state.folderId&&!(db.folders||[]).some(row=>row.id===state.folderId))state.folderId=null;
  [...state.selection].forEach(key=>{if(!valid.has(key))state.selection.delete(key);});
  if(picking)[...picker.selected].forEach(id=>{if(!assetById(id))picker.selected.delete(id);});
  const entries = mediaBrowserEntries(picking), scope = picking ? 'picker' : 'library';
  return `<div class="media-browser ${state.selection.size ? 'is-selecting' : ''}" data-media-scope="${scope}" style="--media-thumbnail-size:${state.thumbnailSize}px">${mediaBreadcrumbs(picking)}<div class="media-browser-toolbar"><label class="search">${icon('search')}<input id="${picking ? 'picker' : 'media'}-search" value="${esc(state.query)}" placeholder="搜索文件名或文件夹" aria-label="搜索媒体"></label><select data-media-filter aria-label="显示项目类型">${[['all','显示全部'],['folders','仅显示文件夹'],['assets','仅显示媒体']].map(([key,label]) => `<option value="${key}" ${state.filter === key ? 'selected' : ''}>${label}</option>`).join('')}</select><select data-media-sort aria-label="素材排序">${[['manual','手动排序'],['name','按文件名'],['createdAt','按上传时间'],['size','按大小'],['type','按类型']].map(([key,label]) => `<option value="${key}" ${state.sort === key ? 'selected' : ''}>${label}</option>`).join('')}</select>${!picking ? `<label class="inline-note"><input type="checkbox" id="unused-only" ${unusedOnly ? 'checked' : ''}>只看未使用</label>` : ''}<span class="toolbar-spacer"></span>${mediaBrowserViewControls(state)}</div>${state.selection.size ? `<div class="media-batchbar">已选择 ${state.selection.size} 项 ${mediaButton('全选当前结果','select-all',picking,'check')}${mediaButton('取消选择','clear-selection',picking)}${mediaButton('删除所选','delete-selection',picking,'trash')}<span>拖动任意已选项目可整组移动</span>${picking&&!picker.multiple&&[...state.selection].filter(key=>key.startsWith('asset:')).length>1?'<small>封面仅使用最后勾选的媒体</small>':''}</div>` : ''}${state.creating ? `<form class="media-folder-form"><span>${icon('folder')}</span><input name="folderName" maxlength="100" value="${esc(state.folderName)}" placeholder="文件夹名称" required aria-label="文件夹名称"><button type="submit" class="icon-btn" aria-label="完成创建">${icon('check')}</button><button type="button" data-media-action="cancel-create" class="icon-btn" aria-label="取消创建">${icon('close')}</button>${state.error ? `<small role="alert">${esc(state.error)}</small>` : ''}</form>` : ''}${entries.length ? state.mode === 'list' ? mediaBrowserList(entries,picking) : `<div class="media-grid">${entries.map(row => row.kind === 'folder' ? mediaFolderCard(row,picking) : mediaCards([row],picking)).join('')}</div>` : `<div class="empty">${icon('folder')}<strong>这里暂时没有符合条件的项目</strong>上传媒体、创建文件夹，或调整筛选条件。</div>`}<div class="media-browser-note">${entries.filter(row => row.kind === 'folder').length} 个文件夹 · ${entries.filter(row => row.kind === 'asset').length} 项媒体 · 拖动排序，拖到文件夹中归类</div></div>`;
}
function refreshMediaBrowser(picking, focus = '') {
  const previousScroll = picking ? $('.modal-body')?.scrollTop : null;
  if (picking) { if (!picker) return; renderPicker(); if ($('.modal-body')) $('.modal-body').scrollTop = previousScroll || 0; }
  else if ($('#media-results')) $('#media-results').innerHTML = renderMediaBrowser(false);
  if (focus) { const input = document.getElementById(focus) || document.querySelector(focus); input?.focus({preventScroll:true}); if (input?.setSelectionRange && input.selectionStart !== null) input.setSelectionRange(input.value.length,input.value.length); }
}
async function uploadMediaBrowser(picking, directory = false) {
  const state = mediaBrowserState(picking), folderId = state.folderId, context = picker, kind = picking ? picker.kind : 'all';
  chooseFiles(async files => {
    const assets = await uploadFiles(files,{projectId:picking ? editor?.id || null : null, kind, folderId});
    if (picking && picker === context) { assets.forEach(asset => { if (!picker.multiple) picker.selected.clear(); picker.selected.add(asset.id); context.browser.selection.add('asset:'+asset.id); }); refreshMediaBrowser(true); }
    else if (!picking) refreshMediaBrowser(false);
  },kind,{directory});
}
let mediaOperation=null;
function showMediaOperation(context){
  mediaOperation=context;let dialog=$('#media-operation-dialog');
  if(!dialog){dialog=document.createElement('dialog');dialog.id='media-operation-dialog';dialog.className='modal media-operation-dialog';document.body.append(dialog);dialog.addEventListener('cancel',event=>{event.preventDefault();event.stopPropagation();closeMediaOperation();});}
  renderMediaOperation();document.body.classList.add('media-operation-open');if(!dialog.open)dialog.showModal();
}
function closeMediaOperation(force=false){if(mediaOperation?.busy&&!force)return;mediaOperation=null;$('#media-operation-dialog')?.close();if($('#media-operation-dialog'))$('#media-operation-dialog').innerHTML='';document.body.classList.remove('media-operation-open');}
function renderMediaOperation(){
  const ctx=mediaOperation;if(!ctx)return;
  const head=title=>`<header class="modal-head"><h2>${title}</h2><button class="icon-btn" data-media-operation="close" aria-label="关闭" ${ctx.busy?'disabled':''}>${icon('close')}</button></header>`;
  const error=ctx.error?`<p class="form-error" role="alert">${esc(ctx.error)}</p>`:'';
  const plan=ctx.plan,blocked=plan.blocked.length;
  $('#media-operation-dialog').innerHTML=`${head('删除所选项目')}<div class="modal-body"><p>所选范围包含 ${plan.folderCount} 个文件夹、${plan.mediaCount} 项素材。</p>${blocked?`<p class="form-error">其中 ${blocked} 项素材被作品、首页设置或历史版本引用，无法删除。所有所选项目都会保留。</p><p>${plan.blocked.slice(0,3).map(row=>esc(row.name)).join('、')}${blocked>3?'等':''}</p>`:'<p>文件夹及其中的素材将永久删除。</p>'}${error}</div><footer class="modal-foot"><button class="btn" data-media-operation="close" ${ctx.busy?'disabled':''}>取消</button><button class="btn danger" data-media-operation="delete" ${blocked||ctx.busy?'disabled':''}>${ctx.busy?'正在删除…':'删除所选'}</button></footer>`;
}
async function deleteSelectedMedia(picking){
  const state=mediaBrowserState(picking),items=[...state.selection].map(key=>{const[kind,id]=key.split(':');return{kind,id};});if(!items.length)return;
  const plan=await api('/api/media/delete-plan','POST',{items});showMediaOperation({type:'delete',picking,items,plan,busy:false,error:''});
}
document.addEventListener('click',event=>{
  const button=event.target.closest?.('[data-media-operation]'),ctx=mediaOperation;if(!button||!ctx)return;
  event.preventDefault();event.stopImmediatePropagation();const action=button.dataset.mediaOperation;if(ctx.busy)return;
  if(action==='close')return closeMediaOperation();
  if(action==='delete'){
    ctx.busy=true;ctx.error='';renderMediaOperation();
    (async()=>{try{const result=await api('/api/media/delete','POST',{items:ctx.items});await loadState(false);closeMediaOperation(true);refreshMediaBrowser(ctx.picking);toast(`已删除 ${result.mediaCount} 项素材、${result.folderCount} 个文件夹`);}catch(error){ctx.busy=false;ctx.error=error.message;renderMediaOperation();}})();
  }
},true);
document.addEventListener('keydown',event=>{if(mediaOperation&&event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();closeMediaOperation();}},true);
document.addEventListener('click', event => {
  const button = event.target.closest?.('[data-media-action]'); if (!button) return;
  const scope = button.closest('[data-media-scope]')?.dataset.mediaScope, picking = scope === 'picker', state = mediaBrowserState(picking); if (!state) return;
  const action = button.dataset.mediaAction;
  event.preventDefault();
  if (action === 'open') { state.folderId = button.dataset.folder || null; state.creating = false; refreshMediaBrowser(picking); }
  if (action === 'view') { state.mode = button.dataset.mode; refreshMediaBrowser(picking); }
  if (action === 'sort') { state.descending = state.sort === button.dataset.sort ? !state.descending : false; state.sort = button.dataset.sort; refreshMediaBrowser(picking); }
  if (action === 'create' || action === 'cancel-create') { state.creating = action === 'create'; state.folderName = ''; state.error = ''; refreshMediaBrowser(picking, state.creating ? '.media-folder-form input' : ''); }
  if (action === 'upload-folder') uploadMediaBrowser(picking,true).catch(error=>toast(error.message,true));
  if (action === 'clear-selection') { state.selection.clear();state.selectionAnchor=null;if(picking)picker.selected.clear();refreshMediaBrowser(picking); }
  if (action === 'select-all') { mediaBrowserEntries(picking).forEach(row=>toggleMediaSelection(`${row.kind}:${row.id}`,picking,true));state.selectionAnchor=null;refreshMediaBrowser(picking); }
  if (action === 'delete-selection') deleteSelectedMedia(picking).catch(error=>toast(error.message,true));
});
document.addEventListener('click',event=>{
  if(event.target.closest?.('[data-media-select-all]')) { event.stopImmediatePropagation(); return; }
  const control=event.target.closest?.('[data-media-select], .media-card-select, .media-row-select');
  if(control) {
    event.preventDefault();event.stopImmediatePropagation();
    const input=control.matches('[data-media-select]')?control:control.querySelector('[data-media-select]');
    const picking=input.closest('[data-media-scope]').dataset.mediaScope==='picker',state=mediaBrowserState(picking);
    selectMediaItem(input.dataset.mediaSelect,picking,!state.selection.has(input.dataset.mediaSelect),event.shiftKey);
    refreshMediaBrowser(picking);return;
  }
  const assetNode=event.target.closest?.('.media-browser [data-media-key]');
  if(assetNode&&!event.target.closest('button,input,label,a,video,audio')) {
    const picking=assetNode.closest('[data-media-scope]').dataset.mediaScope==='picker',state=mediaBrowserState(picking),key=assetNode.dataset.mediaKey;
    if(!assetNode.hasAttribute('data-media-asset')&&!(event.shiftKey&&state.selection.size))return;
    event.preventDefault();event.stopImmediatePropagation();
    if(Date.now()<mediaDragClickUntil&&assetNode.closest('[data-media-scope]').dataset.mediaScope===mediaDragClickScope)return;
    if(state.selection.size){selectMediaItem(key,picking,!state.selection.has(key),event.shiftKey);refreshMediaBrowser(picking);}
    else openMediaPreview(assetNode.dataset.mediaAsset,picking);
  }
},true);
document.addEventListener('input', event => {
  const browser = event.target.closest?.('.media-browser'); if (!browser) return;
  const picking = browser.dataset.mediaScope === 'picker', state = mediaBrowserState(picking);
  if (event.target.matches('[data-media-size]')) {
    state.thumbnailSize = Math.max(120, Math.min(300, Number(event.target.value) || 180));
    browser.style.setProperty('--media-thumbnail-size', `${state.thumbnailSize}px`);
    event.target.nextElementSibling.value = state.thumbnailSize;
    return;
  }
  if (event.target.matches('[name=folderName]')) state.folderName = event.target.value;
  if (event.target.matches('#media-search,#picker-search')) {
    event.stopImmediatePropagation(); state.query = event.target.value; if (picking) picker.query = state.query; else mediaQuery = state.query;
    refreshMediaBrowser(picking,event.target.id);
  }
},true);
document.addEventListener('change', event => {
  const browser=event.target.closest?.('.media-browser'); if (!browser) return;
  const picking=browser.dataset.mediaScope==='picker',state=mediaBrowserState(picking);
  if (event.target.matches('[data-media-compact]')) {
    state.compact = event.target.checked;
    refreshMediaBrowser(picking, '[data-media-scope="'+(picking?'picker':'library')+'"] [data-media-compact]');
    return;
  }
  if (event.target.matches('[data-media-select],[data-media-select-all]')) {
    if(event.target.hasAttribute('data-media-select-all')){mediaBrowserEntries(picking).forEach(row=>toggleMediaSelection(`${row.kind}:${row.id}`,picking,event.target.checked));state.selectionAnchor=null;}
    else selectMediaItem(event.target.dataset.mediaSelect,picking,event.target.checked);
    refreshMediaBrowser(picking);return;
  }
  if (event.target.matches('[data-media-filter],[data-media-sort]')) { if (event.target.hasAttribute('data-media-filter')) state.filter=event.target.value; else {state.sort=event.target.value;state.descending=false;} refreshMediaBrowser(picking); }
});
document.addEventListener('submit',event=>{
  if (!event.target.matches?.('.media-folder-form')) return;
  event.preventDefault();event.stopImmediatePropagation();const picking=event.target.closest('[data-media-scope]').dataset.mediaScope==='picker',state=mediaBrowserState(picking),button=event.target.querySelector('[type=submit]');button.disabled=true;
  (async()=>{try {await api('/api/media/folders','POST',{name:state.folderName,parentId:state.folderId});await loadState(false);state.creating=false;state.error='';refreshMediaBrowser(picking);}catch(error){state.error=error.message;refreshMediaBrowser(picking,'.media-folder-form input');}})();
});
document.addEventListener('keydown',event=>{
  if (event.key==='Escape' && event.target.closest?.('.media-folder-form')) {event.preventDefault();event.stopImmediatePropagation();const picking=event.target.closest('[data-media-scope]').dataset.mediaScope==='picker';mediaBrowserState(picking).creating=false;refreshMediaBrowser(picking);}
  else if (['Enter',' '].includes(event.key) && event.target.matches?.('.media-folder[data-media-key]')) {event.preventDefault();event.target.click();}
  else if (['Enter',' '].includes(event.key) && event.target.matches?.('[data-media-asset]')) {event.preventDefault();event.target.click();}
},true);

let mediaPreview = null;
function openMediaPreview(id,picking) {
  const asset=assetById(id);if(!asset)return;
  const ids=mediaBrowserEntries(picking).filter(row=>row.kind==='asset'&&(mediaKind(asset)!=='image'||mediaKind(row)==='image')).map(row=>row.id);
  mediaPreview={ids,index:ids.indexOf(id),picking,focusKey:'asset:'+id,zoom:1,x:0,y:0};
  if(mediaPreview.index<0){mediaPreview.ids=[id];mediaPreview.index=0;}
  let dialog=$('#media-preview-dialog');
  if(!dialog){dialog=document.createElement('dialog');dialog.id='media-preview-dialog';dialog.className='media-preview-dialog';dialog.setAttribute('aria-label','媒体预览');document.body.append(dialog);
    dialog.addEventListener('cancel',event=>{event.preventDefault();event.stopPropagation();closeMediaPreview();});
    dialog.addEventListener('click',event=>{if(Date.now()<(mediaPreview?.suppressClickUntil||0))return;if(event.target===dialog||event.target.classList.contains('media-preview-stage'))closeMediaPreview();});
  }
  renderMediaPreview();document.body.classList.add('media-preview-open');if(!dialog.open)dialog.showModal();
}
function renderMediaPreview(){
  mediaPreview.zoom=1;mediaPreview.lastZoom=1;mediaPreview.x=0;mediaPreview.y=0;mediaPreview.pan=null;
  const asset=assetById(mediaPreview.ids[mediaPreview.index]),kind=mediaKind(asset);
  $('#media-preview-dialog').innerHTML=`<section class="media-preview-content"><button class="media-preview-close" data-media-preview-action="close" aria-label="关闭预览">${icon('close')}</button><div class="media-preview-stage">${kind==='image'?`<img draggable="false" src="${asset.url}" alt="${esc(asset.name)}" style="--media-preview-ratio:${asset.width / asset.height || 1}">`:kind==='video'?`<video src="${asset.url}" controls playsinline preload="metadata"></video>`:`<audio src="${asset.url}" controls preload="metadata"></audio>`}</div><footer><div><strong>${esc(asset.name)}</strong><span>${asset.width?`${asset.width} × ${asset.height} · `:''}${sizeLabel(asset.size)} · ${mediaPreview.index+1} / ${mediaPreview.ids.length}</span></div><span class="media-preview-hint">Esc 关闭 · ← → 切换${kind==='image'?'<br>滚轮缩放 · 左键拖动 <span class="media-preview-zoom">100%</span>':''}</span>${mediaPreview.picking?`<button class="btn" data-media-preview-action="choose">选择此媒体</button>`:''}</footer></section>`;
}
function closeMediaPreview(){
  const previous=mediaPreview;mediaPreview=null;$('#media-preview-dialog')?.close();if($('#media-preview-dialog'))$('#media-preview-dialog').innerHTML='';document.body.classList.remove('media-preview-open');
  if(previous)document.querySelector(`.media-browser[data-media-scope="${previous.picking?'picker':'library'}"] [data-media-key="${previous.focusKey}"]`)?.focus({preventScroll:true});
}
document.addEventListener('click',event=>{
  const button=event.target.closest?.('[data-media-preview-action]');if(!button||!mediaPreview)return;
  event.preventDefault();event.stopImmediatePropagation();
  if(button.dataset.mediaPreviewAction==='choose') {const id=mediaPreview.ids[mediaPreview.index];if(picker&&mediaPreview.picking){selectMediaItem('asset:'+id,true,true);refreshMediaBrowser(true);}}
  closeMediaPreview();
},true);
document.addEventListener('keydown',event=>{
  if(!mediaPreview)return;
  if([' ','Spacebar'].includes(event.key)||event.code==='Space'){event.preventDefault();event.stopImmediatePropagation();return;}
  if(['Escape','ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();event.stopImmediatePropagation();if(event.key==='Escape')closeMediaPreview();else{const count=mediaPreview.ids.length;mediaPreview.index=(mediaPreview.index+(event.key==='ArrowRight'?1:-1)+count)%count;renderMediaPreview();}}
},true);
function updateMediaPreviewTransform(){
  const image=$('#media-preview-dialog img'),stage=$('.media-preview-stage');if(!image||!mediaPreview||!stage)return;
  const viewport=stage.getBoundingClientRect(),rect=image.getBoundingClientRect(),baseWidth=image.offsetWidth||rect.width/(mediaPreview.lastZoom||1),baseHeight=image.offsetHeight||rect.height/(mediaPreview.lastZoom||1);
  const limitX=Math.max(0,(baseWidth*mediaPreview.zoom+viewport.width)/2-35),limitY=Math.max(0,(baseHeight*mediaPreview.zoom+viewport.height)/2-35);
  mediaPreview.x=Math.max(-limitX,Math.min(limitX,mediaPreview.x));mediaPreview.y=Math.max(-limitY,Math.min(limitY,mediaPreview.y));
  image.style.transform=`translate(${mediaPreview.x}px, ${mediaPreview.y}px) scale(${mediaPreview.zoom})`;mediaPreview.lastZoom=mediaPreview.zoom;
  if($('.media-preview-zoom'))$('.media-preview-zoom').textContent=Math.round(mediaPreview.zoom*100)+'%';
}
document.addEventListener('wheel',event=>{
  if(!mediaPreview||!event.target.closest?.('.media-preview-stage')||!$('#media-preview-dialog img'))return;
  event.preventDefault();event.stopImmediatePropagation();const rect=$('.media-preview-stage').getBoundingClientRect(),old=mediaPreview.zoom,delta=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?rect.height||600:1),next=Math.min(6,Math.max(.25,old*Math.exp(-delta*.0015))),ratio=next/old,px=(Number.isFinite(event.clientX)?event.clientX:rect.left+rect.width/2)-rect.left-rect.width/2,py=(Number.isFinite(event.clientY)?event.clientY:rect.top+rect.height/2)-rect.top-rect.height/2;
  mediaPreview.zoom=next;mediaPreview.x=px-(px-mediaPreview.x)*ratio;mediaPreview.y=py-(py-mediaPreview.y)*ratio;updateMediaPreviewTransform();
},{capture:true,passive:false});
document.addEventListener('pointerdown',event=>{
  if(!mediaPreview||event.button!==0||!event.target.matches?.('#media-preview-dialog img'))return;
  event.preventDefault();mediaPreview.pan={pointer:event.pointerId,startX:event.clientX,startY:event.clientY,x:mediaPreview.x,y:mediaPreview.y,moved:false};event.target.setPointerCapture?.(event.pointerId);$('#media-preview-dialog').classList.add('is-panning');
},true);
document.addEventListener('pointermove',event=>{const pan=mediaPreview?.pan;if(!pan||pan.pointer!==event.pointerId)return;event.preventDefault();const dx=event.clientX-pan.startX,dy=event.clientY-pan.startY;pan.moved ||= Math.hypot(dx,dy)>3;mediaPreview.x=pan.x+dx;mediaPreview.y=pan.y+dy;updateMediaPreviewTransform();},{capture:true,passive:false});
function finishMediaPreviewPan(){if(mediaPreview?.pan?.moved)mediaPreview.suppressClickUntil=Date.now()+300;if(mediaPreview)mediaPreview.pan=null;$('#media-preview-dialog')?.classList.remove('is-panning');}
document.addEventListener('pointerup',finishMediaPreviewPan,true);document.addEventListener('pointercancel',finishMediaPreviewPan,true);

let mediaDrag = null, mediaDragClickUntil = 0, mediaDragClickScope = '', mediaDragFrame = 0, mediaMoveSaving = false;
function mediaDragCleanup() {
  cancelAnimationFrame(mediaDragFrame);mediaDragFrame=0;document.querySelectorAll('.media-drop-folder,.media-drag-source').forEach(node=>node.classList.remove('media-drop-folder','media-drag-source'));$('#media-drop-marker')?.remove();$('#media-drag-preview')?.remove();document.body.classList.remove('media-dragging');
}
function mediaDragHit(x,y) {
  if(!mediaDrag?.started)return;
  const d=mediaDrag,browser=document.querySelector(`.media-browser[data-media-scope="${d.scope}"]`);if(!browser)return;
  const items=[...browser.querySelectorAll('[data-media-key]')],keys=new Set(d.members.map(item=>`${item.kind}:${item.id}`));
  const contains=node=>{const r=node.getBoundingClientRect();return x>=r.left&&x<=r.right&&y>=r.top&&y<=r.bottom;};
  let folder=[...browser.querySelectorAll('[data-folder-drop]')].find(contains),target=items.find(node=>!keys.has(node.dataset.mediaKey)&&contains(node)),drop=null;
  if(folder)drop={folderId:folder.dataset.folderDrop||null,target:folder,into:true};
  else if(target){const [kind,id]=target.dataset.mediaKey.split(':'),r=target.getBoundingClientRect(),middle=x>r.left+r.width*.24&&x<r.right-r.width*.24;
    if(kind==='folder'&&(d.kind==='asset'||middle))drop={folderId:id,target,into:true};
    else if(kind===d.kind)drop={folderId:mediaBrowserState(d.scope==='picker').folderId,target,targetId:id,targetKind:kind,after:target.tagName==='TR'?y>r.top+r.height/2:x>r.left+r.width/2};
  }
  d.drop=drop;document.querySelectorAll('.media-drop-folder').forEach(node=>node.classList.remove('media-drop-folder'));
  const marker=$('#media-drop-marker');marker.hidden=!drop||drop.into;
  if(drop?.into)drop.target.classList.add('media-drop-folder');
  else if(drop){const r=drop.target.getBoundingClientRect(),vertical=drop.target.tagName!=='TR';Object.assign(marker.style,{left:`${vertical?(drop.after?r.right+7:r.left-9):r.left}px`,top:`${vertical?r.top:drop.after?r.bottom:r.top}px`,width:`${vertical?2:r.width}px`,height:`${vertical?r.height:2}px`});}
  const preview=$('#media-drag-preview');if(preview){preview.style.left=`${x+14}px`;preview.style.top=`${y+12}px`;preview.textContent=drop?.into?`移入文件夹（${d.members.length} 项）`:d.members.length>1?`移动 ${d.members.length} 项`:'移动 '+d.name;}
}
function startMediaDrag(d){
  const state=mediaBrowserState(d.scope==='picker'),visible=mediaBrowserEntries(d.scope==='picker'),ordered=visible.map(row=>`${row.kind}:${row.id}`),keys=state.selection.has(d.key)?[...ordered.filter(key=>state.selection.has(key)),...[...state.selection].filter(key=>!ordered.includes(key))]:[d.key];
  d.members=keys.map(key=>{const[kind,id]=key.split(':');return{kind,id};});d.started=true;
  document.querySelectorAll(`.media-browser[data-media-scope="${d.scope}"] [data-media-key]`).forEach(node=>{if(keys.includes(node.dataset.mediaKey))node.classList.add('media-drag-source');});
  document.body.classList.add('media-dragging');const marker=document.createElement('div');marker.id='media-drop-marker';marker.hidden=true;document.body.append(marker);const preview=document.createElement('div');preview.id='media-drag-preview';document.body.append(preview);
}
async function finishMediaDrag(cancel=false){const d=mediaDrag;mediaDrag=null;mediaDragCleanup();if(!d?.started)return;mediaDragClickUntil=Date.now()+350;mediaDragClickScope=d.scope;if(cancel||!d.drop)return;
  mediaMoveSaving=true;
  try{await api('/api/media/arrange','POST',{items:d.members,kind:d.kind,folderId:d.drop.folderId,targetId:d.drop.targetId,targetKind:d.drop.targetKind,after:d.drop.after});await loadState(false);const state=mediaBrowserState(d.scope==='picker');if(state){state.sort='manual';state.descending=false;refreshMediaBrowser(d.scope==='picker');}toast(d.drop.into?`已移动 ${d.members.length} 项到文件夹`:'素材顺序已保存');}catch(error){toast(error.message,true);}finally{mediaMoveSaving=false;}
}
function mediaPointerScroll(){if(!mediaDrag?.started)return;const d=mediaDrag,scroller=d.scope==='picker'?$('.modal-body'):document.scrollingElement,rect=d.scope==='picker'?scroller.getBoundingClientRect():{top:0,bottom:innerHeight},dy=d.y<rect.top+45?-12:d.y>rect.bottom-45?12:0;if(dy){scroller.scrollTop+=dy;mediaDragHit(d.x,d.y);}mediaDragFrame=requestAnimationFrame(mediaPointerScroll);}
document.addEventListener('pointerdown',event=>{const node=event.target.closest?.('.media-browser [data-media-key]');if(!node||mediaMoveSaving||event.button>0||event.target.closest('button,input,label,select,form,video,audio,a'))return;const [kind,id]=node.dataset.mediaKey.split(':'),scope=node.closest('[data-media-scope]').dataset.mediaScope;mediaDrag={key:node.dataset.mediaKey,kind,id,scope,node,name:node.querySelector('.media-name,.media-list-name')?.textContent||'素材',x:event.clientX,y:event.clientY,startX:event.clientX,startY:event.clientY,pointer:event.pointerId};if(event.pointerType!=='touch')event.preventDefault();node.setPointerCapture?.(event.pointerId);},true);
document.addEventListener('pointermove',event=>{const d=mediaDrag;if(!d||d.pointer!==event.pointerId)return;d.x=event.clientX;d.y=event.clientY;if(!d.started&&Math.hypot(d.x-d.startX,d.y-d.startY)>=6){startMediaDrag(d);mediaDragFrame=requestAnimationFrame(mediaPointerScroll);}if(d.started){event.preventDefault();mediaDragHit(d.x,d.y);}}, {capture:true,passive:false});
document.addEventListener('pointerup',event=>{if(mediaDrag?.pointer===event.pointerId)finishMediaDrag();},true);
document.addEventListener('pointercancel',()=>{if(mediaDrag)finishMediaDrag(true);});
document.addEventListener('keydown',event=>{if(mediaDrag&&event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();finishMediaDrag(true);}},true);
document.addEventListener('click',event=>{if(Date.now()<mediaDragClickUntil&&event.target.closest?.('.media-browser [data-media-key]')?.closest('[data-media-scope]').dataset.mediaScope===mediaDragClickScope){event.preventDefault();event.stopImmediatePropagation();}},true);
document.addEventListener('dragstart',event=>{const node=event.target.closest?.('.media-browser [data-media-key]');if(!node)return;event.stopImmediatePropagation();if(mediaDrag||mediaMoveSaving||event.target.closest('input,label')){event.preventDefault();return;}const[kind,id]=node.dataset.mediaKey.split(':');mediaDrag={node,key:node.dataset.mediaKey,kind,id,scope:node.closest('[data-media-scope]').dataset.mediaScope,name:node.textContent.trim(),native:true};startMediaDrag(mediaDrag);event.dataTransfer.setData('text/plain',node.dataset.mediaKey);event.dataTransfer.effectAllowed='move';},true);
document.addEventListener('dragover',event=>{if(mediaDrag?.native){event.preventDefault();event.stopImmediatePropagation();mediaDragHit(event.clientX,event.clientY);}},true);
document.addEventListener('drop',event=>{if(mediaDrag?.native){event.preventDefault();event.stopImmediatePropagation();finishMediaDrag();}},true);
document.addEventListener('dragend',()=>{if(mediaDrag?.native)finishMediaDrag(true);});
