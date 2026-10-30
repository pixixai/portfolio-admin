const $ = selector => document.querySelector(selector);
const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"></use></svg>`;
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const canonical = value => JSON.stringify(value, (_, item) => item && !Array.isArray(item) && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const equal = (a, b) => canonical(a) === canonical(b);
const copy = value => JSON.parse(JSON.stringify(value));
const shortDate = value => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
const sizeLabel = size => size >= 1048576 ? `${(size / 1048576).toFixed(1)} MB` : `${Math.round(size / 1024)} KB`;
let db, view = 'works', query = '', category = '', status = 'all', cardView = false, selected = new Set();
let editor = null, dirty = false, editVersion = 0, saveTimer, savePromise, editorTab = 'properties', previewUrl = '', previewVersion = -1, previewDevice = 'desktop';
let draftSaveFeedback = null, draftSaveFeedbackTimer = null, manualDraftSave = null;
let settingsLocal, settingsDirty = false, mediaQuery = '', unusedOnly = false, picker = null, confirmResolve = null, busy = false;
let settingsBaseline = null, settingsSavePromise = null, settingsNavigating = false;
let projectImport = null;
let brandEditing=null,brandSaving=null;
const homeVideoPosters = new Map();
const labels = { works: '作品管理', spaces: '分享空间', media: '素材库', settings: '展示设置', releases: '发布记录', trash: '回收站' };
const navIcons = { works: 'grid', spaces: 'lock', media: 'image', settings: 'settings', releases: 'history', trash: 'trash' };
const activeProjects = () => db.projects.filter(row => !row.deletedAt);
const modified = row => !equal(row.draft, row.live);
const assetById = id => db.media.find(asset => asset.id === id);
const usesFirstImage = document => document.useFirstImage ?? !document.coverAssetId;
function coverFor(document) { return assetById(usesFirstImage(document) ? document.blocks.find(block => block.type === 'image')?.assetId : document.coverAssetId); }
function ratioFor(document) {
  const asset = coverFor(document);
  if (document.coverRatio && document.coverRatio !== 'auto') return document.coverRatio;
  const ratios = ['16:9', '3:2', '4:3', '1:1', '3:4', '2:3', '9:16'];
  return asset ? ratios.reduce((best, ratio) => { const value = r => r.split(':').reduce((a, b) => Number(a) / Number(b)); return Math.abs(Math.log(asset.width / asset.height / value(ratio))) < Math.abs(Math.log(asset.width / asset.height / value(best))) ? ratio : best; }, '1:1') : '1:1';
}
function badge(row) { return row.live ? modified(row) ? '<span class="status changed"><i class="dot"></i>有未发布修改</span>' : '<span class="status"><i class="dot"></i>已发布</span>' : '<span class="status draft"><i class="dot"></i>草稿</span>'; }
function cardBadge(row) { return badge(row).replace('有未发布修改', '待更新'); }
function toggleWorkSelection(id) {
  selected.has(id) ? selected.delete(id) : selected.add(id);
  $('#works-results').innerHTML = renderWorksResults();
}
function toast(message, error = false) { const node = document.createElement('div'); node.className = 'toast' + (error ? ' error' : ''); node.innerHTML = icon(error ? 'close' : 'check') + `<span>${esc(message)}</span>`; $('#toasts').append(node); setTimeout(() => node.remove(), error ? 8000 : 3600); }
const cloudMode=()=>db?.runtime?.mode==='cloud';
const publishedSiteUrl=()=>db?.runtime?.siteUrl||'/site/';
function cloudSessionNotice(){if($('#cloud-session-notice'))return;const notice=document.createElement('div');notice.id='cloud-session-notice';notice.className='cloud-session-notice';notice.innerHTML='登录已过期。<a href="/login" target="_blank" rel="noopener">在新标签页重新登录</a>后，可继续保存当前内容。';document.body.append(notice);}
async function api(url, method = 'GET', data, options = {}) {
  let release=null;
  if(!options.backgroundPreview&&window.PortfolioSitePreview?.blocksRequest(url,method))release=await window.PortfolioSitePreview.beforeRequest(url,method);
  try {
    const response=await fetch(url,{method,headers:data===undefined?{}:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});
    const result=await response.json();
    if(response.status===401&&result.loginRequired)cloudSessionNotice();else if(response.ok)$('#cloud-session-notice')?.remove();
    if(!response.ok)throw Object.assign(new Error(result.error||'操作未完成，请重试。'),{status:response.status});
    return result;
  } finally {release?.();}
}
async function loadState(renderPage = true) { db = await api('/api/state'); selected = new Set([...selected].filter(id => db.projects.some(row => row.id === id && !row.deletedAt))); if (renderPage) render(); else window.PortfolioSitePreview?.changed(); }
function btn(label, action, style = '', name = '', extra = '') { return `<button type="button" class="btn ${style}" data-action="${action}" ${extra}>${name ? icon(name) : ''}${label}</button>`; }
function field(label, name, value, { textarea = false, type = 'text', hint = '', placeholder = '', attributes = '' } = {}) {
  return `<label class="field"><span>${label}</span>${textarea ? `<textarea data-field="${name}" ${attributes} placeholder="${esc(placeholder)}">${esc(value)}</textarea>` : `<input type="${type}" data-field="${name}" value="${esc(value)}" ${attributes} placeholder="${esc(placeholder)}">`}${hint ? `<small>${hint}</small>` : ''}</label>`;
}
function renderBrandName(){
  if(!brandEditing)return `<button type="button" class="brand-name brand-display" data-brand-name title="双击编辑名称">${esc(db.settings.brand)}</button>`;
  const state=brandEditing;
  return `<form class="brand-edit-form" data-brand-editor><div class="brand-edit-controls"><input aria-label="编辑左上角名称" maxlength="50" value="${esc(state.value)}" autocomplete="off" ${state.saving?'disabled':''}><button type="submit" aria-label="完成名称编辑" title="完成输入" ${state.saving?'disabled':''}>${icon('check')}</button></div>${state.error?`<span class="brand-edit-error" role="alert">${esc(state.error)}</span>`:''}</form>`;
}
function refreshBrandName(focus=false){const node=$('[data-brand-container]');if(!node)return;node.innerHTML=renderBrandName();if(focus){const input=node.querySelector('input');input?.focus({preventScroll:true});input?.select();}}
async function beginBrandEdit(){if(brandSaving)await brandSaving;brandEditing={value:db.settings.brand,error:'',saving:false};refreshBrandName(true);}
function saveBrandEdit(){
  if(brandSaving)return brandSaving;
  const state=brandEditing;if(!state||state.saving)return Promise.resolve();const name=state.value.trim();
  if(!name||name===db.settings.brand){brandEditing=null;refreshBrandName();return Promise.resolve();}
  state.saving=true;refreshBrandName();
  brandSaving=(async()=>{
    try{
      if(settingsSavePromise)await settingsSavePromise;
      const result=await api('/api/brand','PUT',{name,revision:db.settingsRevision});db.settings=result.settings;db.settingsRevision=result.revision;
      if(settingsLocal){settingsLocal.brand=result.settings.brand;settingsBaseline.brand=result.settings.brand;refreshSettingsDirty();}
      brandEditing=null;refreshBrandName();
    }catch(error){state.saving=false;state.error=error.message;refreshBrandName(true);}
    finally{brandSaving=null;}
  })();return brandSaving;
}
function render() {
  if (!db) return;
  if (homeMediaDrag) clearHomeMediaDrag();
  const editorScroll = $('.editor-scroll')?.scrollTop || 0; closeBlockMenu();
  window.PortfolioRichText?.destroyAll();
  const active = activeProjects(), published = active.filter(row => row.live).length;
  $('#app').innerHTML = `<div class="layout"><aside class="sidebar"><div class="brand"><span class="brand-mark"></span><div><div data-brand-container>${renderBrandName()}</div><small>作品管理</small></div></div><p class="nav-heading">创作空间</p><nav class="nav" aria-label="管理导航">${Object.entries(labels).map(([key, label]) => `<button data-nav="${key}" class="${view === key ? 'active' : ''}" ${view === key ? 'aria-current="page"' : ''}>${icon(navIcons[key])}<span class="nav-label">${label}</span>${key === 'works' || key === 'trash' ? `<span class="badge">${key === 'works' ? active.length : db.projects.filter(row => row.deletedAt).length}</span>` : ''}</button>`).join('')}</nav><div class="sidebar-bottom"><div class="workspace-note"><strong>每一次创意，都值得被看见</strong>编辑、预览，再从容发布。<br>让作品持续生长。</div></div></aside><main class="main"><header class="topbar"><div class="crumb">创作空间 <span>/</span><span>${labels[view]}</span></div><div class="top-actions"><span class="site-status"><i class="dot"></i>${published} 个作品已发布</span>${btn('实时预览','toggle-site-preview','','eye')}<a class="icon-btn" href="${esc(publishedSiteUrl())}" target="_blank" rel="noopener" aria-label="新标签查看已发布站点" title="新标签查看已发布站点">${icon('external')}</a>${btn('备份数据','backup-data','','download','data-job-action')}${btn('恢复数据','restore-data','','folder','data-job-action')}${btn('发布', 'publish-dialog', 'primary', 'upload', 'data-job-action')}${cloudMode()?btn('退出登录','cloud-logout','text'):''}</div></header><section class="page" id="page">${renderMain()}</section></main></div>${editor ? renderEditorLayer() : ''}`;
  updateBusy(); syncEditorLayer(editorScroll); prepareHomeVideoPreviews(); syncSettingsSaveButton(); if(view==='spaces')syncSpaceBoard(); window.PortfolioSitePreview?.sync();
}
function renderMain() {
  if (view === 'works' || view === 'trash') return renderWorks();
  if (view === 'spaces') return renderSpaces();
  if (view === 'media') return renderMedia();
  if (view === 'settings') return renderSettings();
  return renderReleases();
}
function heading(title, subtitle, actions = '') { return `<div class="page-heading"><h1>${title}</h1><div class="heading-actions">${actions}</div></div>`; }
function filteredProjects() { return db.projects.filter(row => (view === 'trash' ? row.deletedAt : !row.deletedAt) && (!query || `${row.draft.title} ${row.draft.tags.join(' ')}`.toLowerCase().includes(query.toLowerCase())) && (!category || projectLabels(row.draft).includes(category)) && (status === 'all' || status === 'published' && row.live || status === 'draft' && !row.live || status === 'changed' && row.live && modified(row))); }
function workCounts() {
  const rows = activeProjects();
  return { all: rows.length, published: rows.filter(row => row.live).length, draft: rows.filter(row => !row.live).length, changed: rows.filter(row => row.live && modified(row)).length };
}
function renderWorkTabs() {
  const counts = workCounts(), tabs = view === 'trash' ? [['all', '已删除作品']] : [['all', '全部作品'], ['published', '已发布'], ['draft', '草稿'], ['changed', '待更新']];
  return tabs.map(([key, label]) => `<button data-status="${key}" class="${status === key ? 'active' : ''}" aria-pressed="${status === key}">${label}·${String(view === 'trash' ? db.projects.filter(row => row.deletedAt).length : counts[key]).padStart(2, '0')}</button>`).join('');
}
function renderWorks() {
  return heading(view === 'trash' ? '回收站' : '作品管理', view === 'trash' ? '暂时收起的作品，可以在这里重新找回。' : '把灵感整理成作品，让每一次表达都有迹可循。', view === 'works' ? `<label class="search works-page-search">${icon('search')}<input id="works-search" value="${esc(query)}" placeholder="搜索作品名称、标签" aria-label="搜索作品"></label>` : '') +
    (view === 'works' ? renderCategories() : '') + `<div class="content-card"><div class="list-toolbar"><div class="tabs">${renderWorkTabs()}</div><span class="toolbar-spacer"></span>${view === 'works' ? btn('新建作品','new','small','plus') : ''}<div class="segmented"><button data-view="list" class="${!cardView ? 'active' : ''}" aria-label="列表视图">${icon('list')}</button><button data-view="cards" class="${cardView ? 'active' : ''}" aria-label="封面视图">${icon('grid')}</button></div></div><div id="works-results">${renderWorksResults()}</div></div>`;
}
function renderWorkCard(row) {
  const asset = coverFor(row.draft);
  return `<article class="work-card ${selected.has(row.id) ? 'is-selected' : ''}" data-row="${row.id}" draggable="true" aria-label="${esc(row.draft.title)}，拖动封面排序"><div class="work-card-cover">${asset ? `<img draggable="false" src="${asset.url}" style="${cropStyle(row.draft.coverCrop)}" alt="${esc(row.draft.title)}" loading="lazy">` : `<div class="work-card-placeholder">${icon('image')}<span>暂无封面</span></div>`}</div><div class="work-card-shade" aria-hidden="true"></div><label class="work-card-select" title="选择作品"><input type="checkbox" data-select="${row.id}" ${selected.has(row.id) ? 'checked' : ''} aria-label="选择 ${esc(row.draft.title)}"></label><button class="work-card-edit icon-btn" data-action="edit" data-id="${row.id}" aria-label="编辑 ${esc(row.draft.title)}" title="编辑作品">${icon('edit')}</button><div class="work-card-caption"><span class="work-card-labels">${esc(projectLabels(row.draft).join(' · ') || '未标记')}</span><strong class="work-card-title">${esc(row.draft.title)}${privacyBadge(row.draft)}</strong></div><div class="work-card-state">${cardBadge(row)}</div></article>`;
}
function projectMenu(row) { return `<details class="menu"><summary class="icon-btn" aria-label="更多操作">${icon('more')}</summary><div class="menu-pop">${[['project-preview', 'eye', '预览'], ['duplicate', 'copy', '复制作品'], ['move-up', 'up', '上移'], ['move-down', 'down', '下移'], ...(row.live ? [['unpublish', 'history', '下架']] : []), ['trash', 'trash', '移入回收站']].map(([action, name, label]) => `<button data-action="${action}" data-id="${row.id}" class="${action === 'trash' ? 'danger' : ''}">${icon(name)}${label}</button>`).join('')}</div></details>`; }
function renderWorksResults() {
  const rows = filteredProjects();
  if (!rows.length) return `<div class="empty">${icon(view === 'trash' ? 'trash' : 'folder')}<strong>${view === 'trash' ? '回收站还是空的' : '这里暂时没有作品'}</strong>${query || category ? '试试调整搜索或筛选条件。' : '从右上角新建第一件作品吧。'}</div>`;
  const batch = view === 'works' && selected.size ? `<div class="batchbar">已选择 ${selected.size} 件作品 ${btn('发布所选', 'publish-selected', 'small soft', 'upload')}${btn('取消选择', 'clear-selection', 'small text')}</div>` : '';
  if (cardView && view !== 'trash') return batch + `<div class="work-cards ${selected.size ? 'is-selecting' : ''}">${rows.map(renderWorkCard).join('')}</div><div class="table-footer"><span>共 ${rows.length} 件作品</span><span>拖动封面可调整作品顺序</span></div>`;
  return batch + `<div class="table-scroll"><table class="works-table"><thead><tr><th class="check-cell">${view === 'works' ? '<input type="checkbox" id="select-all" aria-label="全选当前结果" '+ (rows.every(row => selected.has(row.id)) ? 'checked' : '') +'>' : ''}</th><th>作品名称</th><th class="hide-mobile">标签</th><th>状态</th><th class="hide-mobile">图片</th><th class="hide-mobile">最近编辑</th><th>操作</th></tr></thead><tbody>${rows.map(row => {
    const asset = coverFor(row.draft);
    return `<tr data-row="${row.id}" ${view === 'works' ? 'draggable="true"' : ''}><td class="check-cell">${view === 'works' ? `<input type="checkbox" data-select="${row.id}" ${selected.has(row.id) ? 'checked' : ''} aria-label="选择 ${esc(row.draft.title)}">` : ''}</td><td><div class="work-name">${view === 'works' ? `<span class="drag-handle" draggable="true" data-work-handle title="拖动排序">${icon('drag')}</span>` : ''}${asset ? `<img draggable="false" class="work-thumb" src="${asset.url}" alt="" loading="lazy">` : '<span class="work-thumb"></span>'}<div><div class="work-title">${esc(row.draft.title)}${privacyBadge(row.draft)}</div><div class="work-meta">${esc(row.draft.tags.join(' · ') || '还没有添加标签')}</div></div></div></td><td class="hide-mobile"><span class="category-pill">${esc(projectLabels(row.draft).join(' · ') || '未标记')}</span></td><td>${view === 'trash' ? '<span class="status draft">已移除</span>' : badge(row)}</td><td class="hide-mobile">${row.draft.blocks.filter(block => block.type === 'image').length} 张</td><td class="hide-mobile">${shortDate(row.updatedAt)}</td><td><div class="row-actions">${view === 'trash' ? `${btn('恢复', 'restore', 'small', '', `data-id="${row.id}"`)}<button class="icon-btn danger" data-action="delete-project" data-id="${row.id}" title="永久删除">${icon('trash')}</button>` : `<button class="icon-btn" data-action="edit" data-id="${row.id}" title="编辑作品">${icon('edit')}</button>${projectMenu(row)}`}</div></td></tr>`;
  }).join('')}</tbody></table></div><div class="table-footer"><span>共 ${rows.length} 件作品${category ? ` · ${esc(category)}` : ''}</span><span>${view === 'trash' ? '恢复后保留为草稿' : '拖动作品可调整顺序 · 排序发布后生效'}</span></div>`;
}

function renderPreview() {
  if(window.PortfolioSitePreview?.isOpen())return '<p class="inline-note">效果已在右侧实时预览中显示。</p>';
  return `<div class="preview-tools"><div class="segmented"><button data-device="desktop" class="${previewDevice === 'desktop' ? 'active' : ''}" aria-label="电脑预览">${icon('desktop')}</button><button data-device="mobile" class="${previewDevice === 'mobile' ? 'active' : ''}" aria-label="手机预览">${icon('phone')}</button></div>${btn(previewUrl ? '刷新预览' : '预览', 'preview-editor', 'small soft', 'eye', 'data-job-action')}</div>${previewUrl ? `<div class="preview-viewport ${previewDevice === 'mobile' ? 'mobile' : ''}"><iframe src="${esc(previewUrl)}" title="作品真实页面预览"></iframe></div><p class="inline-note" style="padding:10px 14px">${previewVersion === editVersion ? '预览与当前草稿一致' : '内容已修改，刷新预览查看最新效果'} · <a href="${esc(previewUrl)}" target="_blank" rel="noopener">新窗口打开</a></p>` : `<div class="preview-empty">${icon('eye')}点击“预览”，生成与展示站<br>一致的作品页面。</div>`}`;
}

function renderMedia() {
 return heading('素材库','让每一张图片，都有自己的位置。',mediaButton('创建文件夹','create',false,'folder')+mediaButton('上传文件夹','upload-folder',false,'upload')+btn('上传素材','upload-media','primary','upload'))+`<div class="content-card"><div id="media-results">${renderMediaResults()}</div></div>`;
}
function renderMediaResults() { return renderMediaBrowser(false); }
function prepareSettings(value) {
  const result=copy(value);
  result.footer ||= {registrationText:'',registrationUrl:''};
  result.footer.registrationText ??= '';result.footer.registrationUrl ??= '';
  result.footer.text ??= `© ${result.year} ${result.owner} · 作品集`;
  result.homeBackground ||= {videos:[{assetId:null,playbackRate:1}],finalFrameAssetId:null};
  result.homeBackground.shadeOpacity ??= 80;result.homeBackground.shadeColor ??= '#000000';result.homeBackground.loop ??= true;return result;
}
function comparableSettings(value) {
  const normalize=item=>typeof item==='string'?item.trim():Array.isArray(item)?item.map(normalize):item&&typeof item==='object'?Object.fromEntries(Object.entries(item).map(([key,entry])=>[key,normalize(entry)])):item;
  return normalize(value);
}
function refreshSettingsDirty() { window.PortfolioSitePreview?.changed();return settingsDirty=!!settingsLocal&&!equal(comparableSettings(settingsLocal),comparableSettings(settingsBaseline)); }
function renderSettings() {
  if(!settingsLocal){settingsLocal=prepareSettings(db.settings);settingsBaseline=copy(settingsLocal);}
  return `<div class="settings-page"><div class="settings-heading">${heading('展示设置', '保存为设置草稿，发布网站后生效。', `${btn('预览', 'preview-settings', '', 'eye', 'data-job-action')}${btn('保存设置', 'save-settings', 'primary', 'check')}`)}</div><div class="settings-sections"><section class="content-card settings-card" aria-labelledby="settings-background-title">${renderHomeBackgroundSettings()}</section><section class="content-card settings-card" aria-labelledby="settings-personal-title">${renderPersonalSettings()}</section><section class="content-card settings-card" aria-labelledby="settings-site-title">${renderSiteSettings()}</section></div></div>`;
}
function settingField(label, key, value, options = {}) { return field(label, key, value, options).replaceAll('data-field=', 'data-setting='); }
function renderPersonalSettings() {
  const s = settingsLocal;
  return `<h2 id="settings-personal-title">个人信息</h2><p>首页介绍、姓名、职业身份和联系方式在这里一起维护。</p>${settingField('首页介绍', 'tagline', s.tagline, { hint: '介绍、姓名与职业身份显示在首页按钮栏下方。' })}<div class="field-grid">${settingField('姓名', 'owner', s.owner)}${settingField('职业身份', 'role', s.role)}</div><hr class="settings-divider"><h3>联系方式</h3><p>微信、邮箱和 Bilibili 显示在首页按钮栏及页脚。</p><div class="field-grid">${settingField('微信', 'contact.wechat', s.contact.wechat)}${settingField('Bilibili 昵称', 'contact.bilibiliName', s.contact.bilibiliName)}</div>${settingField('首页及页脚邮箱', 'contact.emails.0', s.contact.emails[0], { type: 'email' })}${settingField('备用邮箱（不在首页显示）', 'contact.emails.1', s.contact.emails[1], { type: 'email' })}`;
}
function renderSiteSettings() {
  const s = settingsLocal;
  return `<h2 id="settings-site-title">网站信息与页脚</h2><p>设置浏览器标签文字、网站摘要及页脚信息。</p>${settingField('浏览器页面标题', 'title', s.title, { hint: '显示在浏览器顶部标签上，不是首页中的可见标题。' })}${settingField('网站描述', 'description', s.description, { textarea: true, hint: '写入网页描述信息，供搜索引擎读取；正文中不显示，搜索摘要由搜索引擎决定。' })}<hr class="settings-divider"><h3>页脚信息</h3>${settingField('页脚信息', 'footer.text', s.footer.text, { textarea: true, hint: '直接编辑网站底部的文字，支持换行；留空时隐藏这段文字。', attributes: 'maxlength="1000"' })}${settingField('备案或注册信息（可选）','footer.registrationText',s.footer.registrationText)}${settingField('对应链接（可选，HTTPS）','footer.registrationUrl',s.footer.registrationUrl,{type:'url'})}`;
}
function renderHomeVideoPreview(asset) {
  const src=asset?.url||'/site/assets/home/home-background.mp4',poster=homeVideoPosters.get(src),label=esc((asset?.name||'默认首页视频')+'首帧');
  return `<img data-home-poster alt="${label}" draggable="false" ${poster?`src="${esc(poster)}"`:'hidden'}>${poster?'':`<span class="home-poster-placeholder">首帧加载中</span><video data-home-first-frame src="${esc(src)}" muted playsinline hidden tabindex="-1" preload="auto"></video>`}`;
}
function prepareHomeVideoPreviews() {
  document.querySelectorAll('[data-home-first-frame]').forEach(video=>{
    const release=()=>{video.remove();video.removeAttribute('src');video.load();};
    const failed=()=>{if(!video.isConnected)return;video.parentElement.querySelector('.home-poster-placeholder')?.replaceChildren(document.createTextNode('首帧暂不可用'));release();};
    const capture=()=>{
      if(!video.isConnected||!video.videoWidth||!video.videoHeight)return;
      try {
        const canvas=document.createElement('canvas');canvas.width=Math.min(320,video.videoWidth);canvas.height=Math.max(1,Math.round(canvas.width*video.videoHeight/video.videoWidth));
        const context=canvas.getContext('2d');if(!context)throw new Error('Canvas unavailable');
        context.drawImage(video,0,0,canvas.width,canvas.height);const poster=canvas.toDataURL('image/jpeg',.85);if(!poster.startsWith('data:image/'))throw new Error('Frame unavailable');
        homeVideoPosters.set(video.getAttribute('src'),poster);if(homeVideoPosters.size>64)homeVideoPosters.delete(homeVideoPosters.keys().next().value);
        const preview=video.parentElement,image=preview.querySelector('[data-home-poster]');image.src=poster;image.hidden=false;preview.querySelector('.home-poster-placeholder')?.remove();release();
      }catch{failed();}
    };
    video.addEventListener('loadeddata',capture,{once:true});video.addEventListener('error',failed,{once:true});if(video.readyState>=2)capture();
  });
}
function renderHomeShadeSettings(background) {
  const colors=[['黑色','#000000'],['白色','#ffffff'],['灰色','#64748b'],['蓝色','#173d7a'],['紫色','#4c1d5b'],['绿色','#214d3d'],['棕色','#5a3526']];
  return `<div class="home-shade-control"><span class="home-shade-label">蒙板颜色</span><div class="home-shade-colors" role="group" aria-label="蒙板颜色">${colors.map(([label,color])=>`<button type="button" class="home-shade-swatch" data-action="home-bg-shade-color" data-color="${color}" style="--swatch:${color}" title="${label}" aria-label="${label}蒙板" aria-pressed="${background.shadeColor===color}"><span aria-hidden="true"></span></button>`).join('')}<label class="home-shade-custom">自定义<input type="color" data-home-shade-color value="${esc(background.shadeColor)}" aria-label="自定义蒙板颜色"></label><output data-home-color-value>${esc(background.shadeColor.toUpperCase())}</output></div><label for="home-shade-range">蒙板不透明度</label><div class="home-shade-inputs"><input id="home-shade-range" type="range" min="0" max="100" step="1" data-home-shade value="${background.shadeOpacity}" aria-label="蒙板不透明度滑块" aria-valuetext="${background.shadeOpacity}% 不透明"><label><input type="number" min="0" max="100" step="1" data-home-shade value="${background.shadeOpacity}" aria-label="蒙板不透明度数值"><span>%</span></label></div><p>0% 无蒙板，100% 完全覆盖背景。默认黑色、80%，不影响文字和按钮。</p></div>`;
}
function renderHomeBackgroundSettings() {
  const background=settingsLocal.homeBackground, frame=assetById(background.finalFrameAssetId);
  const rows=background.videos.map((item,index)=>{
    const asset=assetById(item.assetId), image=item.type==='image'||asset?.mime.startsWith('image/');
    const preview=image?`<img src="${esc(asset.url)}" alt="${esc(asset.name)}" draggable="false">`:renderHomeVideoPreview(asset);
    return `<article class="home-video-item" data-home-video="${index}"><button type="button" class="home-media-handle" data-home-drag="${index}" title="拖动排序，也可用上下方向键调整" aria-label="拖动第${index+1}项背景媒体排序">${icon('drag')}<span class="home-media-position" aria-hidden="true">${String(index+1).padStart(2,'0')}</span></button><div class="home-video-preview">${preview}${asset?`<button class="home-reveal-asset" type="button" data-action="home-reveal-asset" data-id="${asset.id}" title="在素材库显示">在素材库显示</button>`:''}</div><strong class="home-media-name" title="${esc(asset?.name||'默认首页背景.mp4')}">${esc(asset?.name||'默认首页背景.mp4')}</strong><label class="home-media-setting">${image?'停留时长':'播放速度'}<span><input type="number" min="${image?1:.25}" max="${image?120:4}" step="${image?1:.25}" data-setting="homeBackground.videos.${index}.${image?'duration':'playbackRate'}" value="${image?item.duration??5:item.playbackRate}" aria-label="${image?'图片'+(index+1)+'停留秒数':'视频'+(index+1)+'播放速度'}">${image?'秒':'倍'}</span></label>${btn('移除','home-bg-remove','small text','trash',`data-index="${index}"`)}</article>`;
  }).join('');
  return `<h2 id="settings-background-title">首页背景</h2><p>图片与视频按列表顺序播放；可开启循环。单击首页空白处可暂停或继续。</p>${renderHomeShadeSettings(background)}<div class="home-background-actions">${btn('上传媒体','home-bg-upload','','upload')}${btn('从素材库选择','home-bg-select','','image')}${btn('添加默认视频','home-bg-default','small text')}<button type="button" role="switch" class="first-image-switch home-loop-switch" data-action="home-bg-loop" aria-checked="${background.loop}" aria-controls="home-final-settings"><span class="switch-track" aria-hidden="true"></span><span>循环播放</span></button></div><div class="home-background-list">${rows||'<p class="inline-note">尚未添加媒体。发布后将仅显示静态背景或结束定格图。</p>'}</div><p class="inline-note blue home-background-note">拖动左侧手柄排序。视频速度0.25～4倍，图片默认停留5秒（可设1～120秒），最多30项媒体。保存设置后，发布网站时勾选「同时发布网站设置」。</p><section id="home-final-settings" ${background.loop?'hidden':''}><hr class="settings-divider"><h3>结束定格帧</h3><p>所有媒体展示结束后显示此图片。不设置时，自动保留最后一项画面。</p>${frame?`<img class="home-final-preview" src="${frame.url}" alt="结束定格帧">`:''}<div class="home-background-actions">${btn('上传定格图','home-bg-frame-upload','','upload')}${btn(frame?'更换定格图':'选择定格图','home-bg-frame-select','','image')}${frame?btn('移除定格图','home-bg-frame-clear','small text','trash'):''}</div></section>`;
}
async function homeBackgroundAction(name,element) {
  const background=settingsLocal.homeBackground;
  const update=()=>{refreshSettingsDirty();render();};
  const add=assets=>{if(background.videos.length+assets.length>30)throw new Error('首页背景最多支持30项媒体。');background.videos.push(...assets.map(asset=>asset.mime.startsWith('image/')?{assetId:asset.id,type:'image',duration:5}:{assetId:asset.id,playbackRate:1}));update();};
  if(name==='home-bg-shade-color'){background.shadeColor=element.dataset.color;return update();}
  if(name==='home-bg-loop'){background.loop=!background.loop;return update();}
  if(name==='home-bg-upload')return chooseFiles(async files=>add(await uploadFiles(files,{kind:'background'})),'background');
  if(name==='home-bg-select')return openMediaPicker(true,add,'background');
  if(name==='home-bg-default'){if(background.videos.length>=30)throw new Error('首页背景最多支持30项媒体。');background.videos.push({assetId:null,playbackRate:1});return update();}
  if(name==='home-bg-frame-upload')return chooseFiles(async files=>{const assets=await uploadFiles(files.slice(0,1),{kind:'image'});if(assets[0]){background.finalFrameAssetId=assets[0].id;update();}},'image');
  if(name==='home-bg-frame-select')return openMediaPicker(false,assets=>{if(assets[0]){background.finalFrameAssetId=assets[0].id;update();}},'image');
  if(name==='home-bg-frame-clear'){background.finalFrameAssetId=null;return update();}
  const index=Number(element.dataset.index);if(name==='home-bg-remove'&&Number.isInteger(index)&&background.videos[index]){background.videos.splice(index,1);update();}
}
function homeSortMotion() { return window.gsap&&!matchMedia('(prefers-reduced-motion: reduce)').matches; }
function moveHomeMedia(from,to,startTop) {
  const list=settingsLocal?.homeBackground.videos;if(!list||from===to||!list[from])return;
  list.splice(to,0,list.splice(from,1)[0]);refreshSettingsDirty();render();
  const row=document.querySelector(`[data-home-video="${to}"]`);row?.querySelector('[data-home-drag]')?.focus({preventScroll:true});
  if(row&&Number.isFinite(startTop)&&homeSortMotion())window.gsap.fromTo(row,{y:startTop-row.getBoundingClientRect().top,opacity:.7},{y:0,opacity:1,duration:.24,ease:'power2.out',clearProps:'transform,opacity'});
}
let homeMediaDrag=null;
function clearHomeMediaDrag() {
  const rows=[...document.querySelectorAll('.home-video-item')];if(window.gsap){window.gsap.killTweensOf(rows);window.gsap.set(rows,{clearProps:'transform,opacity'});}
  rows.forEach(row=>{row.classList.remove('is-dragging','home-insert-before','home-insert-after');row.style.removeProperty('transform');row.style.removeProperty('opacity');const number=row.querySelector('.home-media-position');if(number)number.textContent=String(Number(row.dataset.homeVideo)+1).padStart(2,'0');});
  document.body.classList.remove('home-media-sorting','home-media-sort-fallback');document.getElementById('home-media-drag-ghost')?.remove();
  if(homeMediaDrag?.frame)cancelAnimationFrame(homeMediaDrag.frame);homeMediaDrag=null;
}
function homeMediaDragTarget(y) {
  const drag=homeMediaDrag;if(!drag)return;
  const offset=drag.scrollY-window.scrollY,others=drag.rows.filter(row=>Number(row.dataset.homeVideo)!==drag.from);
  const next=others.find(row=>{const r=drag.rects.get(row);return y<r.top+offset+r.height/2;});
  const before=next?Number(next.dataset.homeVideo):drag.rows.length,to=before-(drag.from<before?1:0);
  const order=[...drag.rows];order.splice(to,0,order.splice(drag.from,1)[0]);
  let top=drag.rects.get(drag.rows[0]).top;
  const shifts=order.map((row,index)=>{const rect=drag.rects.get(row),shift={row,index,y:top-rect.top};top+=rect.height+drag.gap;return shift;});
  drag.rows.forEach(row=>row.classList.remove('home-insert-before','home-insert-after'));
  if(to!==drag.from){if(next)next.classList.add('home-insert-before');else others.at(-1)?.classList.add('home-insert-after');}
  if(to!==drag.to||!drag.animated){
    shifts.forEach(({row,index,y})=>{row.querySelector('.home-media-position').textContent=String(index+1).padStart(2,'0');if(Number(row.dataset.homeVideo)===drag.from)return;if(homeSortMotion())window.gsap.to(row,{y,duration:.22,ease:'power2.out',overwrite:'auto'});else row.style.transform=`translateY(${y}px)`;});
    drag.to=to;drag.animated=true;
  }
  const ghost=document.getElementById('home-media-drag-ghost');if(ghost){ghost.style.transform=`translateY(${y-drag.startY}px)`;ghost.querySelector('.home-drag-order').textContent=`${String(drag.from+1).padStart(2,'0')} → ${String(to+1).padStart(2,'0')}`;}
}
document.addEventListener('pointerdown',event=>{
  const handle=event.target.closest?.('[data-home-drag]');if(!handle||event.button!==0)return;
  event.preventDefault();clearHomeMediaDrag();handle.focus({preventScroll:true});
  const rows=[...document.querySelectorAll('.home-video-item')],rects=new Map(rows.map(row=>[row,row.getBoundingClientRect()]));
  homeMediaDrag={from:Number(handle.dataset.homeDrag),to:Number(handle.dataset.homeDrag),pointerId:event.pointerId,startY:event.clientY,y:event.clientY,started:false,rows,rects,scrollY:window.scrollY,gap:parseFloat(getComputedStyle(handle.closest('.home-background-list')).rowGap)||12};
});
document.addEventListener('pointermove',event=>{
  const drag=homeMediaDrag;if(!drag||drag.pointerId!==event.pointerId)return;
  drag.y=event.clientY;if(!drag.started&&Math.abs(drag.y-drag.startY)<5)return;
  if(!drag.started){
    drag.started=true;document.body.classList.add('home-media-sorting');if(!homeSortMotion())document.body.classList.add('home-media-sort-fallback');
    const source=drag.rows[drag.from],r=drag.rects.get(source),src=source.querySelector('.home-video-preview img')?.getAttribute('src'),ghost=document.createElement('div');
    source.classList.add('is-dragging');ghost.id='home-media-drag-ghost';ghost.setAttribute('aria-hidden','true');ghost.innerHTML=`<div class="home-drag-thumbnail">${src?`<img src="${esc(src)}" alt="">`:icon('image')}</div><strong>${esc(source.querySelector('.home-media-name').textContent)}</strong><span class="home-drag-order"></span>`;
    Object.assign(ghost.style,{left:(r.left||0)+'px',top:r.top+'px',width:(r.width||source.offsetWidth||320)+'px',minHeight:r.height+'px'});document.body.append(ghost);
    const scroll=()=>{if(homeMediaDrag!==drag)return;const dy=drag.y<70?-12:drag.y>window.innerHeight-70?12:0;if(dy){window.scrollBy(0,dy);homeMediaDragTarget(drag.y);}drag.frame=requestAnimationFrame(scroll);};drag.frame=requestAnimationFrame(scroll);
  }
  event.preventDefault();homeMediaDragTarget(drag.y);
},{passive:false});
document.addEventListener('pointerup',event=>{const drag=homeMediaDrag;if(!drag||drag.pointerId!==event.pointerId)return;const top=drag.rects.get(drag.rows[drag.from]).top+drag.y-drag.startY;clearHomeMediaDrag();if(drag.started)moveHomeMedia(drag.from,drag.to,top);});
document.addEventListener('pointercancel',clearHomeMediaDrag);
window.addEventListener('blur',clearHomeMediaDrag);
document.addEventListener('keydown',event=>{
  if(event.key==='Escape'&&homeMediaDrag){event.preventDefault();clearHomeMediaDrag();return;}
  const handle=event.target.closest?.('[data-home-drag]');if(!handle||!['ArrowUp','ArrowDown'].includes(event.key))return;
  event.preventDefault();const from=Number(handle.dataset.homeDrag),to=from+(event.key==='ArrowUp'?-1:1);if(to>=0&&to<settingsLocal.homeBackground.videos.length)moveHomeMedia(from,to);
});
function renderReleases() {
  return heading('发布记录', '保留近期版本，方便查看、导出与恢复。', `<label class="release-retention-control"><span>自动保留</span><select id="release-retention" aria-label="发布记录保留数量" data-job-action>${[5,10].map(keep=>`<option value="${keep}" ${(db.releaseRetention??10)===keep?'selected':''}>最近${keep}条</option>`).join('')}</select></label>${btn('发布', 'publish-dialog', 'primary', 'upload', 'data-job-action')}`) + `<div class="release-notice"><strong>${cloudMode()?'发布到当前作品网站':'发布到独立展示副本'}</strong><br>${cloudMode()?'发布完成后，作品网站直接使用新版本；草稿保持私有。':'这里的发布会更新本机“已发布站点”中的页面。正式托管站点可使用下方“部署包”上传更新；原作品集文件夹不会被修改。'}<p class="release-retention-note">保留数量包含当前版本；每次发布成功后自动清理，调整数量会立即清理。较早版本的记录、源文件及部署副本删除后无法查看、下载或恢复，作品草稿与素材库保留。此设置清理当前后台保存的发布历史，其他平台的部署历史需单独管理。</p></div>${db.jobs.filter(job => job.status === 'failed').slice(0, 3).map(job => `<details class="job-failed"><summary>${esc(job.title)}未完成 · ${shortDate(job.createdAt)}</summary><pre>${esc(job.message)}</pre></details>`).join('')}<div class="content-card release-list">${db.releases.map(release => `<article class="release-item"><span class="release-icon">${icon('history')}</span><div class="release-info"><div class="release-title">${esc(release.title)}${db.currentRelease === release.id ? '<span class="status">当前版本</span>' : ''}</div><p class="release-meta">${shortDate(release.createdAt)} · ${release.count} 个作品 · ${esc(release.id.split('-').slice(-1)[0])}</p></div><div class="release-actions"><a class="btn small" href="/history/${release.id}/" target="_blank" rel="noopener">${icon('eye')}查看</a>${btn('部署包','export-release','small','download',`data-id="${release.id}"`)}<a class="btn small" href="/api/export/${release.id}?kind=source">${icon('folder')}源文件</a>${db.currentRelease !== release.id ? btn('恢复此版本', 'rollback', 'small', 'history', `data-id="${release.id}" data-job-action`) : ''}</div></article>`).join('')}</div>`;
}
async function saveReleaseRetention(keep) {
  busy=true;updateBusy();
  try{const result=await api('/api/release-retention','PUT',{keep});await loadState(false);toast(result.pending?'保留数量已保存，部分旧文件将在后续重试清理':`已设为保留最近${keep}条，清理了${result.removed.length}条较早记录`);}
  catch(error){toast(error.message,true);}finally{busy=false;render();}
}
function openDialog(content, wide = false) { const dialog = $('#dialog'); dialog.classList.remove('space-settings-dialog'); dialog.classList.toggle('wide', wide); $('#dialog-content').innerHTML = content; if (!dialog.open) dialog.showModal(); }
function closeDialog() {
  if(projectImport?.committing)return;
  if(projectImport?.token)api('/api/import/'+projectImport.token,'DELETE').catch(()=>{});
  projectImport=null;
  $('#dialog').close(); picker = null; cropDraft = null; cropPan = null; if (confirmResolve) { confirmResolve(false); confirmResolve = null; }
}
function modalHead(title, subtitle = '') { return `<header class="modal-head"><div><h2>${title}</h2>${subtitle ? `<p>${subtitle}</p>` : ''}</div><button class="icon-btn" data-action="close-dialog" aria-label="关闭">${icon('close')}</button></header>`; }
function confirmAction(title, description, label = '确认', danger = false) { return new Promise(resolve => { confirmResolve = resolve; openDialog(`${modalHead(title)}<div class="modal-body"><p>${esc(description)}</p></div><footer class="modal-foot">${btn('取消', 'close-dialog')}${btn(label, 'confirm', danger ? 'danger' : 'primary')}</footer>`); }); }
function renderProjectImport() {
  const state=projectImport;if(!state)return;
  const summary=state.summary;
  openDialog(`${modalHead('导入部署包','恢复已发布的作品、所用素材和网站设置。')}<div class="modal-body project-import-body"><p>导入后保存为草稿，检查后可重新发布。其他作品会保留；相同编号作品的草稿和当前设置草稿将被替换。</p><p class="inline-note">仅支持新版后台导出的部署ZIP（最大512 MB）。不含未发布草稿、未使用素材与发布历史，不能代替完整备份。</p>${state.file?`<p class="import-file">${icon('folder')}${esc(state.file)}</p>`:''}${state.loading?'<p role="status">正在读取和校验部署包…</p>':''}${summary?`<dl class="import-summary"><div><dt>网站</dt><dd>${esc(summary.title)}</dd></div><div><dt>已发布作品</dt><dd>${summary.projects} 个</dd></div><div><dt>所用素材</dt><dd>${summary.assets} 个</dd></div><div><dt>同编号作品</dt><dd>${summary.conflicts.length} 个</dd></div></dl>${summary.conflicts.length?`<details class="import-conflicts"><summary>这些作品的现有草稿将被替换</summary><ul>${summary.conflicts.map(row=>`<li>${esc(row.title)}</li>`).join('')}</ul></details>`:'<p>作品将作为新草稿加入。</p>'}`:''}${state.error?`<p class="form-error" role="alert">${esc(state.error)}</p>`:''}</div><footer class="modal-foot">${btn('取消','close-dialog')}${btn(summary?'重新选择':'选择部署ZIP','import-choose','','folder',state.loading?'disabled':'')}${summary?btn(state.committing?'正在导入…':'确认导入到草稿','import-confirm','primary','check',state.committing?'disabled':''):''}</footer>`);
  if(state.committing)$('#dialog').querySelectorAll('button').forEach(button=>button.disabled=true);
}
function chooseProjectPackage() {
  if(projectImport?.loading||projectImport?.committing)return;
  const input=document.createElement('input');input.type='file';input.accept='.zip,application/zip';
  input.addEventListener('change',async()=>{
    const file=input.files[0];if(!file||!projectImport)return;
    const oldToken=projectImport.token;
    const state=projectImport={file:file.name,loading:true};renderProjectImport();
    try{
      if(oldToken)await api('/api/import/'+oldToken,'DELETE').catch(()=>{});
      if(projectImport!==state)return;
      if(file.size>512*1024*1024)throw new Error('部署包不能超过512 MB。');
      const response=await fetch('/api/import/inspect',{method:'POST',headers:{'Content-Type':'application/zip'},body:file});
      const result=await response.json();if(!response.ok)throw new Error(result.error||'部署包无法读取。');
      if(projectImport!==state){await api('/api/import/'+result.token,'DELETE').catch(()=>{});return;}
      state.token=result.token;state.summary=result;
    }catch(error){state.error=error.message;}finally{state.loading=false;if(projectImport===state)renderProjectImport();}
  },{once:true});input.click();
}
async function commitProjectImport() {
  const state=projectImport;if(!state?.token||state.committing)return;
  state.committing=true;state.error='';busy=true;updateBusy();renderProjectImport();
  try{
    const result=await api('/api/import/commit','POST',{token:state.token});
    state.token=null;state.committing=false;closeDialog();settingsLocal=null;settingsBaseline=null;settingsDirty=false;selected.clear();
    await loadState();toast(`已恢复${result.projectIds.length}个作品到草稿，请检查后发布`);
  }catch(error){state.error=error.message;state.committing=false;renderProjectImport();}
  finally{busy=false;updateBusy();}
}
function chooseFiles(callback, kind = 'all', { directory = false } = {}) {
  const input = document.createElement('input'); input.type = 'file'; input.accept = kind === 'image' ? 'image/png,image/jpeg,image/webp,image/gif' : kind === 'background' ? 'image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm' : kind === 'video' ? 'video/mp4,video/webm' : kind === 'audio' ? 'audio/mpeg,audio/wav,audio/ogg,audio/mp4,audio/webm,.m4a' : 'image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm,audio/mpeg,audio/wav,audio/ogg,audio/mp4,.m4a'; input.multiple = true; if (directory) { input.webkitdirectory = true; input.setAttribute('webkitdirectory', ''); }
  input.addEventListener('change', () => callback([...input.files]).catch(error => toast(error.message, true)), { once: true }); input.click();
}
async function uploadFiles(files, { projectId = null, kind = 'all', folderId = null } = {}) {
  const assets = [], folderCache = new Map(), progress = $('#upload-progress'); uploading++; progress.hidden = false;
  try {
    for (let i = 0; i < files.length; i++) {
      const file = files[i], image = file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp)$/i.test(file.name), limit = image ? 30 : 200;
      const inferredKind = image ? 'image' : /\.(mp4|webm)$/i.test(file.name) && !file.type.startsWith('audio/') ? 'video' : /\.(mp3|wav|ogg|m4a)$/i.test(file.name) ? 'audio' : file.type.split('/')[0];
      if (!matchesMediaKind(inferredKind, kind)) { toast('“' + file.name + '”的媒体类型不匹配，已跳过。', true); continue; }
      if (file.size > limit * 1024 * 1024) { toast('“' + file.name + '”超过' + limit + ' MB，已跳过。', true); continue; }
      progress.innerHTML = '<strong>上传媒体 ' + (i + 1) + ' / ' + files.length + '</strong><div class="progress-track"><span style="width:0%"></span></div><span>' + esc(file.name) + '</span>';
      try {
        let destination = folderId;
        const segments = (file.webkitRelativePath || '').split('/').filter(Boolean).slice(0,-1);
        if (segments.length) {
          const key = JSON.stringify(segments);
          if (!folderCache.has(key)) folderCache.set(key,(await api('/api/media/folders/ensure','POST',{parentId:folderId,path:segments})).folder.id);
          destination = folderCache.get(key);
        }
        const asset = await new Promise((resolve, reject) => {
          const request = new XMLHttpRequest(); request.open('POST', '/api/media?name=' + encodeURIComponent(file.name) + (projectId ? '&projectId=' + encodeURIComponent(projectId) : '') + (destination ? '&folderId=' + encodeURIComponent(destination) : '')); request.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
          request.upload.onprogress = event => { if (event.lengthComputable && progress.querySelector('.progress-track span')) progress.querySelector('.progress-track span').style.width = Math.round(event.loaded / event.total * 100) + '%'; };
          request.onload = () => { try { const result = JSON.parse(request.responseText); request.status >= 200 && request.status < 300 ? resolve(result) : reject(new Error(result.error || '上传失败')); } catch { reject(new Error('无法读取上传结果，请重试。')); } };
          request.onerror = () => reject(new Error('网络中断，请重新上传。')); request.timeout = 120000; request.ontimeout = () => reject(new Error('上传超时，请重试。')); request.send(file);
        });
        if (!matchesMediaKind(mediaKind(asset), kind)) { toast('“' + file.name + '”的媒体类型不匹配。', true); continue; }
        assets.push(asset);
      } catch (error) { toast(file.name + '：' + error.message, true); }
    }
    await loadState(false); if (assets.length) toast('已上传 ' + assets.length + ' 项媒体' + (projectId ? '，暂存于当前作品' : ''));
    return assets.map(asset => assetById(asset.id));
  } finally { uploading--; progress.hidden = true; }
}

function changed() { window.PortfolioSitePreview?.changed();dirty = true; editVersion++; clearTimeout(saveTimer); if (draftSaveFeedback && draftSaveFeedback.state !== 'saving') resetDraftSaveFeedback(); updateSaveState(); saveTimer = setTimeout(() => saveProject(true).catch(error => { updateSaveState('自动保存未完成，请点击保存重试'); toast(error.message, true); }), 1200); }
function updateSaveState(message) { const node = $('#save-state'); if (node) node.innerHTML = icon(dirty ? 'edit' : 'check') + esc(message || (dirty ? '有修改，正在等待自动保存…' : '草稿已保存')); }
function syncDraftSaveButton() {
  const button = $('.editor-heading [data-action=save]'); if (!button) return;
  const state = draftSaveFeedback?.id === editor?.id ? draftSaveFeedback.state : 'ready';
  const label = { ready: '保存草稿', saving: '保存中…', saved: '已保存', pending: '有新修改', error: '保存失败' }[state];
  button.dataset.saveFeedback = state; button.disabled = state === 'saving'; button.setAttribute('aria-busy', String(state === 'saving'));
  button.setAttribute('aria-live', 'polite'); button.setAttribute('aria-atomic', 'true');
  button.innerHTML = (state === 'saving' ? '<span class="spinner" aria-hidden="true"></span>' : icon(state === 'error' || state === 'pending' ? 'edit' : 'check')) + `<span>${label}</span>`;
  button.title = state === 'pending' ? '本次内容已保存，另有新修改待保存' : '保存草稿（Ctrl+S / ⌘S）';
}
function resetDraftSaveFeedback() { clearTimeout(draftSaveFeedbackTimer); draftSaveFeedbackTimer = null; draftSaveFeedback = null; syncDraftSaveButton(); }
function setDraftSaveFeedback(id, state) {
  if (editor?.id !== id) return;
  clearTimeout(draftSaveFeedbackTimer); const feedback = { id, state }; draftSaveFeedback = feedback; syncDraftSaveButton();
  if (state !== 'saving') draftSaveFeedbackTimer = setTimeout(() => { if (draftSaveFeedback === feedback) resetDraftSaveFeedback(); }, state === 'error' ? 2600 : 1800);
}
function saveDraftWithFeedback() {
  if (!editor) return Promise.resolve();
  const id = editor.id; if (manualDraftSave?.id === id) return manualDraftSave.promise;
  const request = { id, promise: null }; manualDraftSave = request; setDraftSaveFeedback(id, 'saving');
  request.promise = (async () => {
    try { await saveProject(true); setDraftSaveFeedback(id, dirty ? 'pending' : 'saved'); }
    catch (error) { if (editor?.id === id) { setDraftSaveFeedback(id, 'error'); updateSaveState('保存失败，请重试'); } throw error; }
    finally { if (manualDraftSave === request) manualDraftSave = null; }
  })();
  return request.promise;
}
async function saveProject(silent = false) {
  if (!silent) return saveDraftWithFeedback();
  clearTimeout(saveTimer);
  if (savePromise) await savePromise;
  if (!editor || !dirty) return;
  const version = editVersion, payload = copy(editor), id = editor.id;
  updateSaveState('正在保存…');
  savePromise = api(`/api/projects/${id}`, 'PUT', payload);
  try {
    const row = await savePromise;
    if (editor?.id === id) { editor.revision = row.revision; if (version === editVersion) {dirty = false;if(row.draft.visibility&&editor.visibility!==row.draft.visibility){editor.visibility=row.draft.visibility;const node=$('.document-privacy');if(node)node.outerHTML=renderDocumentPrivacy();}} }
    const index = db.projects.findIndex(project => project.id === id); if (index >= 0) db.projects[index] = row;
    updateDocumentSpaces();updateSaveState();
  } finally { savePromise = null; }
}
async function navigate(next) {
  if(typeof spaceHasPending==='function'&&spaceHasPending())await flushSpaceChanges();
  if(brandSaving)await brandSaving;
  if(settingsNavigating)return false;
  if(next===view&&!editor)return true;
  settingsNavigating=true;
  try {
    if (editor) { await closeEditor(); if (editor) return false; }
    if(settingsSavePromise)await settingsSavePromise;
    if(refreshSettingsDirty()) {
      const choice=await new Promise(resolve=>{confirmResolve=resolve;openDialog(`${modalHead('设置尚未保存')}<div class="modal-body"><p>离开会丢弃尚未保存的修改，也可以保存为设置草稿后离开。</p></div><footer class="modal-foot">${btn('取消','close-dialog')}${btn('离开','settings-leave')}${btn('保存设置并离开','settings-save-leave','primary','check')}</footer>`);});
      if(!choice)return false;
      if(choice==='save'){await saveSettings();if(refreshSettingsDirty())return false;}
    }
    clearTimeout(saveTimer);editor=null;dirty=false;settingsDirty=false;settingsLocal=null;settingsBaseline=null;previewUrl='';view=next;query='';category='';status='all';selected.clear();await loadState();window.scrollTo({top:0,behavior:'instant'});return true;
  } finally {settingsNavigating=false;}
}
async function revealHomeAsset(id) {
  if(!assetById(id))return;
  if(!await navigate('media'))return;
  const asset=assetById(id);if(!asset)return;
  Object.assign(libraryBrowser,{folderId:asset.folderId||null,query:'',filter:'all',creating:false,selectionAnchor:null});
  libraryBrowser.selection.clear();unusedOnly=false;render();
  const target=[...document.querySelectorAll('[data-media-scope="library"] [data-media-key]')].find(node=>node.dataset.mediaKey==='asset:'+id);
  if(target){target.classList.add('is-located');target.tabIndex=0;target.focus({preventScroll:true});target.scrollIntoView?.({block:'center',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});setTimeout(()=>target.classList.remove('is-located'),3500);}
}
async function openEditor(id) {
  if (editor && dirty) await saveProject(true);
  const row = db.projects.find(project => project.id === id);
  resetDraftSaveFeedback();
  editorReturn = { y: window.scrollY, id }; editor = { ...copy(row.draft), labels: projectLabels(row.draft), revision: row.revision };
  selectedBlockId = null; selectedDocumentBlocks.clear(); documentTextRange = null; documentSelectionAnchor = null; documentSelectAllStage = null;
  editor.blocks = editor.blocks.map(block => block.type === 'heading' ? { id: block.id, type: 'text', text: /^#{1,6}\s/.test(block.text) ? block.text : '## ' + block.text } : clearLegacyTableLabels(block));
  if (!editor.blocks.length) editor.blocks.push(newTextBlock()); activeTextCursor = { id: editor.blocks.at(-1).id, start: editor.blocks.at(-1).text?.length || 0, end: editor.blocks.at(-1).text?.length || 0 }; labelsMenuOpen = false; labelSearch = ''; closeBlockMenu();
  dirty = false; editVersion = 0; editorTab = 'properties'; previewUrl = ''; previewVersion = -1; render();
}
function addImages(assets, replaceId) { return insertDocumentMedia(assets, replaceId ? { replaceId } : documentMediaContext()); }

function updateBusy() { document.querySelectorAll('[data-job-action]').forEach(button => { button.disabled = busy; }); }
async function followJob(job, callback) {
  busy = true; updateBusy(); toast(job.kind === 'preview' ? '正在生成真实页面预览…' : '正在发布，请稍候…');
  try {
    const deadline = Date.now() + 120000;
    while (job.status === 'running' && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 450)); job = await api(`/api/jobs/${job.id}`); }
    if (job.status !== 'done') throw new Error(job.status === 'failed' ? job.message : '任务仍在处理中，请稍后查看发布记录。');
    await loadState(false); if (callback) callback(job); toast(job.message); return job;
  } finally { busy = false; render(); }
}
async function previewProject(id) {
  if (editor?.id === id) await saveProject(true);
  const version = editVersion;
  const document=id?db.projects.find(row=>row.id===id)?.draft:null;
  const job = await api('/api/preview', 'POST', document?{project:document}:{});
  await followJob(job, result => {
    const url = result.url + (id ? `?work=${encodeURIComponent(id)}` : '');
    if (editor) { previewUrl = url; previewVersion = version; }
    else openDialog(`${modalHead('草稿预览', '预览包含当前草稿，仅在本机后台提供。')}<div class="modal-body"><a class="btn primary" target="_blank" rel="noopener" href="${url}">${icon('external')}打开预览页面</a></div><footer class="modal-foot">${btn('完成', 'close-dialog')}</footer>`);
  });
}
function renderDeploymentFields(target=db.deploymentTarget||{platform:'generic',projectName:'portfolio-site'}) {
  const profiles=db.deploymentPlatforms||[{id:'generic',label:'通用静态网站',description:''},{id:'edgeone',label:'腾讯 EdgeOne Pages / Makers',description:''},{id:'esa',label:'阿里云 ESA Pages',description:''}],profile=profiles.find(item=>item.id===target.platform)||profiles[0];
  return `<section class="deployment-fields"><label class="field"><span>部署平台</span><select name="platform" data-deployment-platform ${db.capabilities?.platformExport?'':'disabled'}>${profiles.map(item=>`<option value="${esc(item.id)}" ${item.id===profile.id?'selected':''}>${esc(item.label)}</option>`).join('')}</select></label><p class="deployment-description">${esc(profile.description)}${profile.fileSizeLimit?' 单文件≤25 MB，静态文件最多'+profile.fileLimit+'个。':''}</p><label class="field esa-project-field" ${profile.id==='esa'?'':'hidden'}><span>ESA 项目名称</span><input name="projectName" value="${esc(target.projectName||'portfolio-site')}" minlength="2" maxlength="41" pattern="[a-z][a-z0-9]*(?:-[a-z0-9]+)*" ${profile.id==='esa'?'required':'disabled'}><small>填写你在ESA使用的项目名称；同名项目存在时会更新该项目。</small></label>${db.capabilities?.platformExport?'':'<p class="form-error">请关闭原启动窗口，重新运行“启动后台.cmd”并刷新页面，加载平台导出功能。</p>'}</section>`;
}
function deploymentFromForm(data){return{platform:data.get('platform')||'generic',projectName:data.get('projectName')||'portfolio-site'};}
function deploymentURL(id,target,check=false){const params=new URLSearchParams({kind:'dist',platform:target.platform,...(target.platform==='esa'?{projectName:target.projectName}:{}),...(check?{check:'1'}:{})});return '/api/export/'+encodeURIComponent(id)+'?'+params;}
function openExportDialog(id){
  const release=db.releases.find(item=>item.id===id);if(!release)return;
  openDialog(`${modalHead('导出部署包','按所选平台生成此发布版本的部署包，不修改作品或新增发布记录。')}<form id="export-form" data-id="${release.id}"><div class="modal-body">${renderDeploymentFields(release.deployment)}<div class="deployment-report" role="status"></div><div class="form-error" hidden></div></div><footer class="modal-foot">${btn('取消','close-dialog')}<button type="submit" class="btn primary" ${db.capabilities?.platformExport?'':'disabled'}>${icon('download')}导出部署包</button></footer></form>`);
}
function openPublishDialog(ids) {
  const candidates = activeProjects(), chosen = new Set(ids || candidates.filter(row => row.live && modified(row)).map(row => row.id));
  const settingsChanged = !equal(db.settings, db.settingsLive);
  openDialog(`${modalHead('发布', '只发布勾选的作品草稿，其他已发布内容保留原样。')}<form id="publish-form"><div class="modal-body"><p class="inline-note blue">${cloudMode()?'发布完成后直接更新作品网站，分享空间访问规则同步生效。':'发布到网站展示副本，完成后可部署到已配置的服务器。静态部署包包含主站和已启用的公开空间。私密空间通过服务器访问服务提供。'}</p>${db.spaces?.changed||candidates.some(row=>row.draft.visibility!==row.live?.visibility)?'<p class="inline-note">本次同时更新主站及各分享空间的作品选择、分组和访问设置。</p>':''}${candidates.map(row => { const asset = coverFor(row.draft); return `<label class="publish-row"><input type="checkbox" name="project" value="${row.id}" ${chosen.has(row.id) ? 'checked' : ''}>${asset ? `<img src="${asset.url}" alt="">` : ''}<span>${esc(row.draft.title)}</span>${badge(row)}</label>`; }).join('')}<label class="publish-setting"><input type="checkbox" name="settings" ${settingsChanged ? 'checked' : ''}>同时发布网站设置${settingsChanged ? '（有修改）' : ''}</label><div class="form-error" id="publish-error" hidden></div></div><footer class="modal-foot">${btn('取消', 'close-dialog')}${cloudMode()?'':btn('服务器设置','space-server-settings','','settings')+btn('部署已发布网站','remote-sync')}<button class="btn primary" type="submit" ${db.capabilities?.platformExport?'':'disabled'}>${icon('upload')}确认发布</button></footer></form>`);
}
async function reorder(id, targetId) { const rows = activeProjects(), ids = rows.map(row => row.id), old = ids.indexOf(id), target = ids.indexOf(targetId); if (old < 0 || target < 0 || old === target) return; ids.splice(old, 1); ids.splice(target, 0, id); await api('/api/reorder', 'POST', { ids }); await loadState(); toast('顺序已保存，发布后生效'); }
async function projectAction(action, id) {
  const row = db.projects.find(row => row.id === id);
  if (action === 'duplicate') { const duplicate = await api(`/api/projects/${id}/duplicate`, 'POST', {}); await loadState(false); await openEditor(duplicate.id); toast('副本已创建，当前为草稿'); return; }
  if (action === 'restore') { await api(`/api/projects/${id}/restore`, 'POST', {}); await loadState(); toast('作品已恢复为草稿'); return; }
  if (action === 'move-up' || action === 'move-down') { const rows = activeProjects(), index = rows.findIndex(row => row.id === id), target = rows[index + (action === 'move-up' ? -1 : 1)]; if (target) await reorder(id, target.id); return; }
  const messages = { trash: ['移入回收站？', row.live ? '这个作品会先从展示副本下架，再移入回收站。素材与历史版本会保留。' : '作品可以从回收站恢复。', '移入回收站'], unpublish: ['下架这个作品？', '访客将无法在展示副本中看到它，草稿和素材仍会保留。', '确认下架'], 'delete-project': ['永久删除作品？', '这会移除作品编辑记录。已发布历史和被引用的素材仍会保留。', '永久删除'] };
  const [title, description, label] = messages[action]; if (!(await confirmAction(title, description, label, true))) return;
  const result = action === 'delete-project' ? await api(`/api/projects/${id}`, 'DELETE') : await api(`/api/projects/${id}/${action}`, 'POST', {});
  if (result.status) await followJob(result); else { await loadState(); toast(action === 'delete-project' ? '作品已删除' : '作品已移入回收站'); }
}
function syncSettingsSaveButton() {
  const button=document.querySelector('[data-action="save-settings"]');if(!button)return;
  button.disabled=!!settingsSavePromise;button.setAttribute('aria-busy',String(!!settingsSavePromise));
  button.innerHTML=settingsSavePromise?'<span class="spinner"></span>保存中…':icon('check')+'保存设置';
}
async function saveSettings() {
  if(brandSaving)await brandSaving;
  if(settingsSavePromise)return settingsSavePromise;
  if(!settingsLocal)return;
  const snapshot=copy(settingsLocal),revision=db.settingsRevision;
  settingsSavePromise=(async()=>{
    const result=await api('/api/settings','PUT',{...snapshot,revision});
    db.settingsRevision=result.revision;db.settings=copy(result.settings||snapshot);settingsBaseline=prepareSettings(db.settings);
    if(equal(settingsLocal,snapshot))settingsLocal=copy(settingsBaseline);
    refreshSettingsDirty();toast('设置草稿已保存，发布后生效');
  })();
  syncSettingsSaveButton();
  try{return await settingsSavePromise;}finally{settingsSavePromise=null;syncSettingsSaveButton();}
}
async function action(name, element) {
  if(name==='cloud-logout'){if(!cloudMode()||!await navigate('works'))return;await api('/api/auth/logout','POST',{});window.location.assign('/login');return;}
  if(brandSaving)await brandSaving;
  const id = element.dataset.id;
  if (name.startsWith('space-')) return spaceAction(name,element);
  if(['publish-dialog','publish-selected','publish-editor','backup-data','restore-data','edit','new'].includes(name)&&typeof spaceHasPending==='function'&&spaceHasPending())await flushSpaceChanges();
  if (name.startsWith('home-bg-')) return homeBackgroundAction(name,element);
  if (documentActions.has(name)) return documentAction(name, element);
  if (name === 'toggle-site-preview') return window.PortfolioSitePreview?.toggle();
  if (name === 'reload') return location.reload();
  if (name === 'close-dialog') return closeDialog();
  if (name === 'settings-leave' || name === 'settings-save-leave') { const resolve=confirmResolve;confirmResolve=null;closeDialog();resolve?.(name==='settings-save-leave'?'save':'leave');return; }
  if (name === 'home-reveal-asset') return revealHomeAsset(id);
  if (name === 'confirm') { const resolve = confirmResolve; confirmResolve = null; closeDialog(); resolve(true); return; }
  if (name === 'new') { const row = await api('/api/projects', 'POST', { title: '未命名作品', category: '未分类', labels: [], description: '', tags: [], blocks: [newTextBlock()] }); await loadState(false); return openEditor(row.id); }
  if (name === 'edit') return openEditor(id);
  if (['duplicate', 'trash', 'restore', 'unpublish', 'delete-project', 'move-up', 'move-down'].includes(name)) return projectAction(name, id);
  if (name === 'back' || name === 'close-editor') return closeEditor();
  if (name === 'save') return saveProject();
  if (name === 'clear-selection') { selected.clear(); return render(); }
  if(name==='backup-data'||name==='restore-data'){
    if(!db.capabilities?.userBackup||!window.PortfolioUserBackup)throw new Error('请重启后台并刷新页面，加载数据备份功能。');
    if(brandSaving)await brandSaving;if(editor&&dirty)await saveProject(true);if(settingsDirty)await saveSettings();
    if(name==='restore-data'&&!await navigate('works'))return;
    return window.PortfolioUserBackup.open({mode:name==='restore-data'?'restore':'backup',api,esc,openDialog,modalHead,btn,
      beforeWork:async()=>{const release=await window.PortfolioSitePreview?.beforeRequest('/api/preview','POST');busy=true;updateBusy();return()=>{busy=false;release?.();render();};},
      onRestored:async()=>{window.PortfolioSitePreview?.invalidate();editor=null;dirty=false;view='works';query='';category='';status='all';selected.clear();settingsLocal=null;settingsBaseline=null;settingsDirty=false;previewUrl='';await loadState();closeDialog();toast('所选用户数据已恢复');}
    });
  }
  if (name === 'import-dialog') { if(window.PortfolioSitePreview){const release=await window.PortfolioSitePreview.beforeRequest('/api/import/commit','POST');release?.();}if(busy||!await navigate('works'))return;projectImport={};return renderProjectImport(); }
  if (name === 'import-choose') return chooseProjectPackage();
  if (name === 'import-confirm') return commitProjectImport();
  if(name==='remote-sync'){if(!db.capabilities?.remoteSync||!window.PortfolioRemoteSync)throw new Error('请重启后台并刷新页面，加载增量部署功能。');return window.PortfolioRemoteSync.open({api,esc,openDialog,modalHead,btn,sizeLabel,releaseId:id||db.currentRelease});}
  if (name === 'export-release') return openExportDialog(id);
  if (name === 'publish-dialog') { if (editor && dirty) await saveProject(true); if (settingsDirty) await saveSettings(); return openPublishDialog(); }
  if (name === 'publish-selected') return openPublishDialog([...selected]);
  if (name === 'publish-editor') { await saveProject(true); return openPublishDialog([editor.id]); }
  if (name === 'preview-editor') return previewProject(editor.id);
  if (name === 'project-preview') return previewProject(id);
  if (name === 'add-text' || name === 'add-heading') { editor.blocks.push({ id: crypto.randomUUID(), type: name === 'add-text' ? 'text' : 'heading', text: '' }); changed(); return render(); }
  if (['block-up', 'block-down', 'remove-block'].includes(name)) { const index = editor.blocks.findIndex(block => block.id === element.dataset.blockId); if (name === 'remove-block') editor.blocks.splice(index, 1); else { const target = index + (name === 'block-up' ? -1 : 1); [editor.blocks[index], editor.blocks[target]] = [editor.blocks[target], editor.blocks[index]]; } changed(); return render(); }
  if (['add-images', 'add-video', 'add-audio'].includes(name)) return openMediaPicker(true, assets => addImages(assets), name === 'add-images' ? 'image' : name === 'add-video' ? 'video' : 'audio');
  if (name === 'replace-image') return openMediaPicker(false, assets => addImages(assets, element.dataset.blockId), editor.blocks.find(block => block.id === element.dataset.blockId).type);
  if (name === 'choose-cover') return openMediaPicker(false, assets => openCrop(assets[0], false), 'image');
  if (name === 'edit-crop') return openCrop(coverFor(editor));
  if (name === 'crop-ratio') { cropDraft.ratio = element.dataset.ratio; return renderCrop(); }
  if (name === 'crop-reset') { cropDraft.x = .5; cropDraft.y = .5; cropDraft.zoom = 1; return renderCrop(); }
  if (name === 'apply-crop') { editor.useFirstImage = cropDraft.useFirstImage; if (!cropDraft.useFirstImage) editor.coverAssetId = cropDraft.asset.id; editor.coverRatio = cropDraft.ratio; editor.coverCrop = { x: cropDraft.x, y: cropDraft.y, zoom: cropDraft.zoom }; changed(); closeDialog(); return render(); }
  if (name === 'add-category') return beginCategoryEdit();
  if (name === 'delete-category') return deleteCategory(element.dataset.name);
  if (name === 'filter-category') return filterCategory(element.dataset.category);
  if (name === 'toggle-first-cover') {
    const first = usesFirstImage(editor), before = coverFor(editor), ratio = ratioFor(editor);
    if (first && !editor.coverAssetId) editor.coverAssetId = before?.id || null;
    editor.useFirstImage = !first;
    // Changing the image source must not resize the cover frame. Capture the
    // displayed ratio even when it was originally derived from an image.
    editor.coverRatio = ratio;
    if (before?.id !== coverFor(editor)?.id) editor.coverCrop = null;
    changed(); return render();
  }
  if (name === 'use-media') { const { callback, selected } = picker, assets = [...selected].map(id => assetById(id)); closeDialog(); return callback(assets); }
  if (name === 'upload-media' || name === 'upload-picker') return uploadMediaBrowser(name === 'upload-picker');
  if (['upload-blocks'].includes(name)) {
    const projectId = name === 'upload-media' ? null : editor?.id || null, kind = name === 'upload-picker' ? picker.kind : 'all';
    return chooseFiles(async files => { const assets = await uploadFiles(files, { projectId, kind }); if (name === 'upload-blocks' && assets.length) addImages(assets); else if (name === 'upload-picker' && picker) { assets.forEach(asset => { if (!picker.multiple) picker.selected.clear(); picker.selected.add(asset.id); }); renderPicker(); } else render(); }, kind);
  }
  if (name === 'delete-media') { const asset = assetById(id); if (!(await confirmAction('删除未使用素材？', `“${asset.name}”将从素材库永久移除。`, '删除素材', true))) return; await api(`/api/media/${id}`, 'DELETE'); await loadState(); return toast('素材已删除'); }
  if (name === 'save-settings') return saveSettings();
  if (name === 'preview-settings') { const job = await api('/api/preview', 'POST', { settings: settingsLocal }); return followJob(job, result => openDialog(`${modalHead('网站设置预览')}<div class="modal-body"><a class="btn primary" target="_blank" rel="noopener" href="${result.url}">${icon('external')}打开预览</a></div><footer class="modal-foot">${btn('完成', 'close-dialog')}</footer>`)); }
  if (name === 'rollback') { const release = db.releases.find(release => release.id === id); if (!(await confirmAction('恢复这个发布版本？', `展示副本将恢复到“${release.title}”。当前编辑草稿会保留，并生成新的发布记录。`, '恢复版本'))) return; return followJob(await api('/api/rollback', 'POST', { id })); }
}
document.addEventListener('click', event => {
  document.querySelectorAll('details.menu[open]').forEach(menu => { if (!menu.contains(event.target) || event.target.closest('button')) menu.open = false; });
  const element = event.target.closest('[data-action], [data-nav], [data-status], [data-view], [data-editor-tab], [data-device], [data-pick]');
  if (!element || element.disabled) return;
  const work = async () => {
    if (element.dataset.nav) return navigate(element.dataset.nav);
    if (element.dataset.status) { status = element.dataset.status; return render(); }
    if (element.dataset.view) { cardView = element.dataset.view === 'cards'; return render(); }
    if (element.dataset.editorTab) { editorTab = element.dataset.editorTab; return render(); }
    if (element.dataset.device) { previewDevice = element.dataset.device; return render(); }
    if (element.dataset.pick && picker) { const id = element.dataset.pick; if (picker.selected.has(id)) picker.selected.delete(id); else { if (!picker.multiple) picker.selected.clear(); picker.selected.add(id); } return renderPicker(); }
    if (element.dataset.action) return action(element.dataset.action, element);
  };
  work().catch(error => toast(error.message, true));
});
document.addEventListener('keydown', event => { if (event.target.matches?.('[data-pick]') && ['Enter', ' '].includes(event.key)) { event.preventDefault(); event.target.click(); } });
document.addEventListener('input', event => {
  const element = event.target;
  if (element.matches?.('[data-home-shade-color]') && settingsLocal) {
    const value=element.value.toLowerCase();if(!/^#[\da-f]{6}$/.test(value))return;
    settingsLocal.homeBackground.shadeColor=value;refreshSettingsDirty();
    document.querySelectorAll('[data-action="home-bg-shade-color"]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.color===value)));
    const label=document.querySelector('[data-home-color-value]');if(label)label.textContent=value.toUpperCase();
    return;
  }
  if (element.matches?.('[data-home-shade]') && settingsLocal) {
    if (element.value.trim()==='' || !Number.isFinite(Number(element.value))) return;
    const value=Math.max(0,Math.min(100,Math.round(Number(element.value))));
    settingsLocal.homeBackground.shadeOpacity=value;refreshSettingsDirty();
    document.querySelectorAll('[data-home-shade]').forEach(input=>{if(input.value!==String(value))input.value=value;if(input.type==='range')input.setAttribute('aria-valuetext',`${value}% 不透明`);});
    return;
  }
  if (element.id === 'works-search') { query = element.value; $('#works-results').innerHTML = renderWorksResults(); return; }
  if (element.id === 'media-search') { mediaQuery = element.value; $('#media-results').innerHTML = renderMediaResults(); return; }
  if (element.id === 'picker-search') { picker.query = element.value; const pos = element.selectionStart; renderPicker(); const input = $('#picker-search'); input.focus(); input.setSelectionRange(pos, pos); return; }
  if (element.dataset.field && editor) { const key = element.dataset.field; editor[key] = key === 'title' ? element.value.replace(/\r?\n/g, ' ') || '未命名作品' : key === 'tags' ? element.value.split(/[,，]/).map(tag => tag.trim()).filter(Boolean) : key === 'order' ? Number(element.value) : element.value; changed(); if (key === 'coverRatio') render(); }
  if (element.dataset.blockField && editor) { editor.blocks.find(block => block.id === element.dataset.blockId)[element.dataset.blockField] = element.value; changed(); }
  if (element.dataset.setting && settingsLocal) { const keys = element.dataset.setting.split('.'); let target = settingsLocal; keys.slice(0, -1).forEach(key => { target = target[key]; }); const key = keys.at(-1); target[key] = keys[0] === 'categories' ? element.value.split('\n').map(value => value.trim()).filter(Boolean) : element.type === 'number' ? Number(element.value) : element.value; refreshSettingsDirty(); if (element.type === 'color') $('#color-value').textContent = element.value; }
});
document.addEventListener('change', event => {
  const element = event.target;
  if(element.matches?.('[data-deployment-platform]')){const section=element.closest('.deployment-fields'),profile=db.deploymentPlatforms.find(item=>item.id===element.value);section.querySelector('.deployment-description').textContent=profile.description+(profile.fileSizeLimit?' 单文件≤25 MB，静态文件最多'+profile.fileLimit+'个。':'');const field=section.querySelector('.esa-project-field'),input=field.querySelector('input');field.hidden=profile.id!=='esa';input.disabled=field.hidden;input.required=!field.hidden;section.closest('form').querySelector('.deployment-report')?.replaceChildren();const error=section.closest('form').querySelector('.modal-body > .form-error');if(error)error.hidden=true;return;}
  if(element.id==='release-retention'){saveReleaseRetention(Number(element.value));return;}
  if (element.id === 'category-filter') { category = element.value; $('#works-results').innerHTML = renderWorksResults(); }
  if (element.id === 'unused-only') { unusedOnly = element.checked; $('#media-results').innerHTML = renderMediaResults(); }
  if (element.dataset.select) { element.checked ? selected.add(element.dataset.select) : selected.delete(element.dataset.select); $('#works-results').innerHTML = renderWorksResults(); }
  if (element.id === 'select-all') { filteredProjects().forEach(row => element.checked ? selected.add(row.id) : selected.delete(row.id)); $('#works-results').innerHTML = renderWorksResults(); }
});
document.addEventListener('submit', event => {
  if(event.target.matches?.('[data-brand-editor]')){event.preventDefault();saveBrandEdit();return;}
  event.preventDefault();
  const form = event.target, data = new FormData(form), submit = form.querySelector('[type=submit]');
  const run = async () => {
    if(form.id==='export-form'){
      const target=deploymentFromForm(data),report=await api(deploymentURL(form.dataset.id,target,true));if(!equal(target,deploymentFromForm(new FormData(form))))return;if(report.errors.length)throw new Error(report.errors.join('\n'));
      const node=form.querySelector('.deployment-report');node.innerHTML=`<p>检查通过：${report.fileCount}个静态文件，约${sizeLabel(report.totalBytes)}。${target.platform==='esa'?'阿里包请先解压，按包内DEPLOY.md通过Git或CLI部署。':target.platform==='edgeone'?'下载后可直接上传ZIP。':'下载后按静态网站方式部署，index.html位于最外层。'}</p><a class="btn primary" href="${esc(deploymentURL(form.dataset.id,target))}">${icon('download')}下载部署包</a>`;form.querySelector('.form-error').hidden=true;return;
    }
    if (form.id === 'publish-form') {
      const projectIds=data.getAll('project');if(!projectIds.length&&!data.has('settings')&&!db.spaces?.changed&&!db.projects.some(row=>row.live&&row.draft.visibility!==row.live.visibility))throw new Error('请至少选择一个作品、网站设置或分享空间修改。');const target={platform:'generic',projectName:'portfolio-site'};
      const job=await api('/api/publish','POST',{projectIds,includeSettings:data.has('settings'),deployment:target});closeDialog();
      return followJob(job,result=>{selected.clear();openDialog(`${modalHead('发布完成')}<div class="modal-body"><p>${cloudMode()?'作品网站已更新，分享空间的标签规则和访问设置已生效。':'展示副本已更新。点击下方按钮将主站和各分享空间部署到服务器。静态部署包包含主站和公开空间；完整备份请使用“备份数据”。'}</p><a class="btn primary" href="${esc(deploymentURL(result.id,target))}">${icon('download')}下载部署包</a></div><footer class="modal-foot">${cloudMode()?`<a class="btn" href="${esc(publishedSiteUrl())}" target="_blank" rel="noopener">查看站点</a>`:btn('增量部署到阿里云','remote-sync','','upload',`data-id="${result.id}"`)}${btn('完成','close-dialog')}</footer>`);});
    }
  };
  if (submit) submit.disabled = true;
  run().catch(error => { const node = form.querySelector('.form-error'); if (node) { node.hidden = false; node.textContent = error.message; } else toast(error.message, true); }).finally(() => { if (submit) submit.disabled = false; });
});
$('#dialog').addEventListener('cancel', event => { event.preventDefault();closeDialog(); });
$('#dialog').addEventListener('click', event => { if (event.target === $('#dialog')) { const box = event.target.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) closeDialog(); } });

window.addEventListener('beforeunload', event => { if (dirty || refreshSettingsDirty() || typeof spaceHasPending==='function'&&spaceHasPending() || projectImport?.committing || window.PortfolioUserBackup?.isRestoring() || brandSaving || brandEditing&&brandEditing.value.trim()!==db.settings.brand) { event.preventDefault(); event.returnValue = ''; } });
(async () => { try { await loadState(); } catch (error) { $('#app').innerHTML = `<div class="boot"><p>${esc(error.message)}</p><button class="btn" data-action="reload">刷新页面</button></div>`; } })();

document.addEventListener('dblclick',event=>{if(event.target.closest?.('[data-brand-name]')){event.preventDefault();beginBrandEdit().catch(error=>toast(error.message,true));}});
document.addEventListener('input',event=>{if(event.target.matches?.('[data-brand-editor] input')&&brandEditing){brandEditing.value=event.target.value;brandEditing.error='';event.target.closest('form').querySelector('.brand-edit-error')?.remove();}});
document.addEventListener('focusout',event=>{const form=event.target.closest?.('[data-brand-editor]');if(form&&!form.contains(event.relatedTarget))saveBrandEdit();});
document.addEventListener('keydown',event=>{
  if(event.target.matches?.('[data-brand-name]')&&['Enter','F2'].includes(event.key)){event.preventDefault();beginBrandEdit().catch(error=>toast(error.message,true));return;}
  if(!event.target.closest?.('[data-brand-editor]'))return;
  if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();if(!brandSaving){brandEditing=null;refreshBrandName();}}
  if(event.key==='Enter'&&!event.isComposing){event.preventDefault();saveBrandEdit();}
});

document.addEventListener('input',event=>{if(event.target.matches?.('.deployment-fields input'))event.target.closest('form').querySelector('.deployment-report')?.replaceChildren();});
