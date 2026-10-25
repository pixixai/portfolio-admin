// Shared editor interactions. Loaded before app.js; event callbacks use its state.
let cropDraft = null, cropPan = null, editorReturn = null, editorLastId = null, uploading = 0, editorBackdropDown = false, editorHeaderObserver = null;
const mediaKind = asset => asset?.mime?.split('/')[0] || 'image';
const ratios = ['16:9', '3:2', '4:3', '1:1', '3:4', '2:3', '9:16'];
const ratioNumber = value => value.split(':').reduce((a, b) => Number(a) / Number(b));
const cropStyle = crop => crop ? `object-position:${crop.x * 100}% ${crop.y * 100}%;transform:scale(${crop.zoom});transform-origin:${crop.x * 100}% ${crop.y * 100}%` : '';
const availableAsset = asset => asset.library || editor && (asset.pendingProjects?.includes(editor.id) || asset.references?.projects.some(row => row.id === editor.id));

let categoryEditing = null, categorySaving = null;
function renderCategoryInput() {
  const state = categoryEditing;
  return `<form class="category-inline-form" data-category-editor><input class="category-inline-input" aria-label="${state.original === null ? '新标签名称' : '修改标签名称'}" maxlength="40" placeholder="输入标签名称" value="${esc(state.value)}" ${state.saving ? 'disabled' : ''} style="width:${Math.max(8, [...state.value].length * 1.6 + 2)}ch" autocomplete="off"><button class="category-inline-done" type="submit" aria-label="完成输入" title="完成输入" ${state.saving ? 'disabled' : ''}>${icon('check')}</button>${state.error ? `<span class="category-inline-error" role="alert">${esc(state.error)}</span>` : ''}</form>`;
}
function renderCategories() {
  return `<div class="category-manager" aria-label="作品标签"><span class="category-caption">标签</span><button class="category-chip ${!category ? 'active' : ''}" data-action="filter-category" data-category="">全部</button>${allLabelOptions().map(name => categoryEditing?.original === name ? renderCategoryInput() : `<span class="category-wrap"><button class="category-chip ${category === name ? 'active' : ''}" data-action="filter-category" data-category="${esc(name)}" title="双击修改标签名称">${esc(name)}<small>${activeProjects().filter(row => projectLabels(row.draft).includes(name)).length}</small></button><button class="category-delete" data-action="delete-category" data-name="${esc(name)}" aria-label="删除标签 ${esc(name)}">${icon('close')}</button></span>`).join('')}${categoryEditing?.original === null ? renderCategoryInput() : `<button class="category-chip add" data-action="add-category" aria-label="新增标签">${icon('plus')}</button>`}</div>`;
}
function refreshCategories(focus = false) {
  const manager = $('.category-manager'); if (!manager) return;
  manager.outerHTML = renderCategories();
  if (focus) { const input = $('[data-category-editor] input'); input?.focus({ preventScroll: true }); input?.select(); }
}
function filterCategory(name) {
  category = name;
  // Keep the chip itself mounted so the second click can form a double-click.
  document.querySelectorAll('.category-chip[data-category]').forEach(node => node.classList.toggle('active', node.dataset.category === name));
  $('#works-results').innerHTML = renderWorksResults();
}
async function beginCategoryEdit(original = null) {
  if (categorySaving) await categorySaving;
  categoryEditing = { original, value: original || '', error: '', saving: false }; refreshCategories(true);
}
function saveCategoryEdit() {
  if (categorySaving) return categorySaving;
  const state = categoryEditing; if (!state) return Promise.resolve();
  const name = state.value.trim();
  if (!name || name === state.original) { categoryEditing = null; refreshCategories(); return Promise.resolve(); }
  if (allLabelOptions().includes(name)) { state.error = '已存在同名标签'; refreshCategories(true); return Promise.resolve(); }
  state.saving = true;
  categorySaving = (async () => {
    try {
      await api('/api/categories', state.original === null ? 'POST' : 'PUT', { name: state.original ?? name, ...(state.original === null ? {} : { newName: name }), revision: db.settingsRevision });
      if (category === state.original) category = name;
      await loadState(false); if (categoryEditing === state) categoryEditing = null;
      if (view === 'works' && !editor) { refreshCategories(); $('#works-results').innerHTML = renderWorksResults(); $('.list-toolbar .tabs').innerHTML = renderWorkTabs(); }
    } catch (error) { state.saving = false; state.error = error.message; if (categoryEditing === state) refreshCategories(true); }
    finally { categorySaving = null; }
  })();
  return categorySaving;
}
async function deleteCategory(name) {
  if (categorySaving) await categorySaving;
  await api('/api/categories', 'DELETE', { name, revision: db.settingsRevision }); if (category === name) category = '';
  categoryEditing = null; await loadState();
}
document.addEventListener('dblclick', event => {
  const chip = event.target.closest?.('.category-chip[data-category]');
  if (chip?.dataset.category) { event.preventDefault(); beginCategoryEdit(chip.dataset.category).catch(error => toast(error.message, true)); }
});
document.addEventListener('input', event => {
  if (!event.target.matches?.('[data-category-editor] input') || !categoryEditing) return;
  categoryEditing.value = event.target.value; categoryEditing.error = '';
  event.target.style.width = `${Math.max(8, [...event.target.value].length * 1.6 + 2)}ch`;
  event.target.closest('form').querySelector('.category-inline-error')?.remove();
});
document.addEventListener('focusout', event => {
  const form = event.target.closest?.('[data-category-editor]');
  if (form && !form.contains(event.relatedTarget)) saveCategoryEdit();
});
document.addEventListener('submit', event => {
  if (event.target.matches?.('[data-category-editor]')) { event.preventDefault(); event.stopImmediatePropagation(); saveCategoryEdit(); }
});
document.addEventListener('keydown', event => {
  if (!event.target.matches?.('[data-category-editor] input, [data-category-editor] button')) return;
  if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); categoryEditing = null; refreshCategories(); }
  if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); saveCategoryEdit(); }
});
function renderEditorLayer() {
  return `<div class="editor-overlay" data-editor-overlay><section class="editor-shell" role="dialog" aria-modal="true" aria-labelledby="editor-title" tabindex="-1"><div class="editor-scroll">${renderEditor()}</div></section></div>`;
}
function renderEditor() { return renderDocument(); }
function renderBlock(block,index) { return renderDocumentBlock(block,index); }
async function closeEditor() {
  if (!editor) return;
  if (uploading) { toast('媒体正在上传，完成后即可关闭'); return; }
  await saveProject(true);
  // A second save catches edits made while the first request was in flight.
  if (dirty) await saveProject(true);
  closeBlockMenu(); labelsMenuOpen = false; activeTextCursor = null;
  clearTimeout(saveTimer); resetDraftSaveFeedback(); editor = null; dirty = false; previewUrl = ''; editorLastId = null; render();
  if (editorReturn) { window.scrollTo({ top: editorReturn.y, behavior: 'instant' }); document.querySelector(`[data-action="edit"][data-id="${editorReturn.id}"]`)?.focus({ preventScroll: true }); }
}
function syncEditorLayer(scrollTop = 0) {
  editorHeaderObserver?.disconnect(); editorHeaderObserver = null;
  document.body.classList.toggle('editor-open', Boolean(editor));
  const layout = $('.layout'); if (layout) { layout.inert = Boolean(editor); if (editor) layout.setAttribute('aria-hidden', 'true'); }
  if (!editor) return;
  syncDraftSaveButton();
  const heading = $('.editor-heading'), shell = $('.editor-shell');
  const measure = () => { if (heading.isConnected) shell.style.setProperty('--editor-heading-height', `${heading.getBoundingClientRect().height || 90}px`); };
  measure(); if (typeof ResizeObserver !== 'undefined') { editorHeaderObserver = new ResizeObserver(measure); editorHeaderObserver.observe(heading); }
  mountDocumentRich();
  document.querySelectorAll('.content-block textarea,[data-document-grow]').forEach(growText);
  // Rich hosts initially have little height. Restoring before mounting clamps
  // the offset to that temporary height, especially near the document bottom.
  $('.editor-scroll').scrollTop = scrollTop;
  if (editorLastId !== editor.id) { $('.document-title textarea').focus({ preventScroll: true }); editorLastId = editor.id; if (window.gsap && !matchMedia('(prefers-reduced-motion: reduce)').matches) gsap.fromTo('.editor-shell', { y: 18, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: .25, clearProps: 'transform,opacity,visibility' }); }
}
function growText(node) { node.style.height = 'auto'; const line = parseFloat(getComputedStyle(node).lineHeight) || 28; node.style.height = Math.max(node.scrollHeight, node.dataset.field === 'title' ? 64 : line + 8) + 'px'; }

function openCrop(asset, first = usesFirstImage(editor)) {
  if (!asset || mediaKind(asset) !== 'image') return;
  const same = asset.id === coverFor(editor)?.id;
  cropDraft = { asset, useFirstImage: first, ratio: same && editor.coverRatio !== 'auto' ? editor.coverRatio : closestRatio(asset), ...(same && editor.coverCrop || { x: .5, y: .5, zoom: 1 }) };
  renderCrop();
}
function closestRatio(asset) { return ratios.reduce((best, ratio) => Math.abs(Math.log(asset.width / asset.height / ratioNumber(ratio))) < Math.abs(Math.log(asset.width / asset.height / ratioNumber(best))) ? ratio : best, '1:1'); }
function renderCrop() {
  const c = cropDraft;
  openDialog(`${modalHead('封面比例与裁切', '滚轮缩放，拖动图片调整裁切区域。原图会保留。')}<div class="modal-body crop-body"><div class="crop-ratios">${ratios.map(ratio => `<button class="${ratio === c.ratio ? 'active' : ''}" data-action="crop-ratio" data-ratio="${ratio}">${ratio}</button>`).join('')}</div><div class="crop-workspace"><div class="crop-stage" tabindex="0" role="img" aria-label="滚轮缩放，拖动图片调整裁切位置" style="aspect-ratio:${c.ratio.replace(':', '/')};width:min(100%,${Math.min(620, 380 * ratioNumber(c.ratio))}px)"><img draggable="false" src="${c.asset.url}" alt="封面裁切预览" style="${cropStyle(c)}"><div class="crop-grid"></div></div></div><div class="crop-reset-row">${btn('重置', 'crop-reset', 'small text')}</div></div><footer class="modal-foot">${btn('取消', 'close-dialog')}${btn('应用封面', 'apply-crop', 'primary', 'check')}</footer>`, true);
}
function updateCropImage() { const image = $('.crop-stage img'); if (image && cropDraft) image.style.cssText = cropStyle(cropDraft); }
document.addEventListener('wheel', event => {
  if (!cropDraft || !event.target.closest?.('.crop-workspace')) return;
  event.preventDefault(); const box = $('.crop-stage').getBoundingClientRect();
  const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? box.height || 380 : 1), oldZoom = cropDraft.zoom, nextZoom = Math.min(4, Math.max(1, oldZoom * Math.exp(-delta * .0015)));
  if (nextZoom === oldZoom) return;
  const base = Math.max(box.width / cropDraft.asset.width, box.height / cropDraft.asset.height);
  for (const [axis, length, coordinate, natural] of [['x', box.width, Number.isFinite(event.clientX) ? event.clientX - box.left : box.width / 2, cropDraft.asset.width], ['y', box.height, Number.isFinite(event.clientY) ? event.clientY - box.top : box.height / 2, cropDraft.asset.height]]) {
    const oldSize = natural * base * oldZoom, nextSize = natural * base * nextZoom;
    if (oldSize && Math.abs(length - nextSize) > .001) { const point = (coordinate - (length - oldSize) * cropDraft[axis]) / oldSize; cropDraft[axis] = Math.max(0, Math.min(1, (coordinate - point * nextSize) / (length - nextSize))); }
  }
  cropDraft.zoom = nextZoom; cropPan = null; updateCropImage();
}, { passive: false });

function mediaVisual(asset, selectable) {
  const kind = mediaKind(asset);
  if (kind === 'image') return `<img class="media-thumb" draggable="false" src="${asset.url}" alt="${esc(asset.name)}" loading="lazy">`;
  if (selectable) return `<div class="media-thumb media-symbol">${icon(kind)}<span>${kind === 'video' ? '视频' : '音频'}</span></div>`;
  return kind === 'video' ? `<video class="media-thumb" src="${asset.url}" controls preload="metadata" playsinline></video>` : `<div class="media-thumb media-audio">${icon('audio')}<audio src="${asset.url}" controls preload="metadata"></audio></div>`;
}
function mediaCards(assets, selectable = false) { return assets.map(asset => mediaAssetCard(asset, selectable)).join(''); }
function openMediaPicker(multiple, callback, kind = 'all') { picker = { multiple, callback, kind, selected: new Set(), query: '', browser: newMediaBrowser() }; renderPicker(); }
function renderPicker() {
  openDialog(`${modalHead('上传或选择媒体', editor ? '可选素材库内容，或上传到当前作品的暂存媒体。' : '选择素材库中的媒体。')}<div class="modal-body">${renderMediaBrowser(true)}</div><footer class="modal-foot">${btn('上传新媒体', 'upload-picker', '', 'upload')}${mediaButton('创建文件夹','create',true,'folder')}${mediaButton('上传文件夹','upload-folder',true,'upload')}<span class="toolbar-spacer"></span>${btn('取消', 'close-dialog')}${btn(`使用所选 ${picker.selected.size} 项`, 'use-media', 'primary', '', picker.selected.size ? '' : 'disabled')}</footer>`, true);
}

// Reorder the existing DOM nodes first, then animate the positional difference.
let sorting = null, sortSaving = false, touchSort = null, sortScrollFrame = 0, workClickSuppressUntil = 0;
function ensureSortMarker() {
  if (!$('#block-drop-marker')) { const marker = document.createElement('div'); marker.id = 'block-drop-marker'; marker.hidden = true; document.body.append(marker); }
}
function updateSortMarker() {
  const marker = $('#block-drop-marker'); if (!marker || !sorting) return;
  if (sorting.kind === 'block') {
    const rect = sorting.members[0].getBoundingClientRect(); marker.hidden = false;
    Object.assign(marker.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: '2px' }); return;
  }
  const drop = sorting.drop;
  marker.hidden = !drop?.target.isConnected; if (marker.hidden) return;
  const rect = drop.target.getBoundingClientRect(), grid = sorting.parent.classList.contains('work-cards');
  marker.classList.toggle('work-insertion', grid);
  marker.dataset.target = drop.target.dataset.row; marker.dataset.side = drop.after ? 'after' : 'before';
  if (grid) {
    const gap = parseFloat(getComputedStyle(sorting.parent).columnGap) || 18;
    Object.assign(marker.style, { left: `${(drop.after ? rect.left + rect.width + gap / 2 : rect.left - gap / 2) - 1}px`, top: `${rect.top}px`, width: '2px', height: `${rect.height}px` });
  } else Object.assign(marker.style, { left: `${rect.left}px`, top: `${drop.after ? rect.bottom : rect.top}px`, width: `${rect.width}px`, height: '2px' });
}
function clearPointerSort() {
  if (touchSort?.grip.hasPointerCapture?.(touchSort.pointer)) touchSort.grip.releasePointerCapture(touchSort.pointer);
  touchSort = null; cancelAnimationFrame(sortScrollFrame); sortScrollFrame = 0;
  document.body.classList.remove('block-dragging'); $('#block-drag-preview')?.remove(); $('#block-drop-marker')?.remove();
}
function pointerSortAt(x, y) {
  if (!sorting) return;
  let target;
  if (sorting.kind === 'block') {
    // The handle sits in the gutter, so hit testing only inside block content
    // misses the entire drag. Use vertical block geometry, including gaps.
    const nodes = sortNodes(sorting.parent).filter(node => !sorting.members.includes(node));
    const overSelection = sorting.members.some(node => { const rect = node.getBoundingClientRect(); return y >= rect.top && y <= rect.bottom; });
    if (!overSelection) {
      target = nodes.find(node => { const rect = node.getBoundingClientRect(); return y >= rect.top && y <= rect.bottom; });
      if (!target) target = nodes.reduce((nearest, node) => !nearest || Math.abs(y - (node.getBoundingClientRect().top + node.getBoundingClientRect().bottom) / 2) < Math.abs(y - (nearest.getBoundingClientRect().top + nearest.getBoundingClientRect().bottom) / 2) ? node : nearest, null);
    }
  } else {
    // Pointer capture keeps the event on the original card/handle. Hit-test the
    // current layout instead, including the gaps between thumbnail cards.
    const nodes = sortNodes(sorting.parent).filter(node => !sorting.members.includes(node));
    const grid = sorting.parent.classList.contains('work-cards');
    const contains = node => { const rect = node.getBoundingClientRect(); return y >= rect.top && y <= rect.bottom && (!grid || x >= rect.left && x <= rect.right); };
    if (!sorting.members.some(contains)) {
      target = nodes.find(contains);
      if (!target) {
        const distance = node => { const rect = node.getBoundingClientRect(); return Math.hypot(grid ? x - (rect.left + rect.right) / 2 : 0, y - (rect.top + rect.bottom) / 2); };
        target = nodes.reduce((nearest, node) => !nearest || distance(node) < distance(nearest) ? node : nearest, null);
      }
    }
  }
  if (target) {
    sortOver(target, x, y);
  }
  updateSortMarker();
  const preview = $('#block-drag-preview'); if (preview) { preview.style.left = `${x + 15}px`; preview.style.top = `${y + 12}px`; }
}
function autoScrollSort() {
  if (!touchSort || !sorting) { sortScrollFrame = 0; return; }
  const scroller = sorting.kind === 'block' ? $('.editor-scroll') : document.scrollingElement;
  if (scroller) {
    const rect = sorting.kind === 'block' ? scroller.getBoundingClientRect() : { top: 0, bottom: innerHeight }, y = touchSort.y;
    const dy = y < rect.top + 65 ? -Math.min(18, (rect.top + 65 - y) / 4) : y > rect.bottom - 65 ? Math.min(18, (y - rect.bottom + 65) / 4) : 0;
    if (dy) { scroller.scrollTop += dy; pointerSortAt(touchSort.x, y); }
  }
  if (sorting.kind === 'work') updateSortMarker();
  sortScrollFrame = requestAnimationFrame(autoScrollSort);
}
function sortNodes(parent) { return [...parent.children].filter(node => node.matches('[data-row], [data-block]')); }
function moveWithAnimation(node, target, after) {
  const parent = node.parentElement, nodes = sortNodes(parent);
  const moving = sorting?.node === node ? sorting.members : [node];
  if (moving.includes(target) || node.parentElement !== target.parentElement) return;
  const remaining = nodes.filter(item => !moving.includes(item)), index = remaining.indexOf(target) + (after ? 1 : 0);
  const order = [...remaining.slice(0, index), ...moving, ...remaining.slice(index)];
  if (order.every((item, i) => item === nodes[i])) return;
  const positions = new Map(nodes.map(item => [item, item.getBoundingClientRect()]));
  if (window.gsap) gsap.killTweensOf(nodes);
  nodes.forEach(item => { item.style.transform = ''; });
  target[after ? 'after' : 'before'](...moving);
  const next = nodes.map(item => [item, item.getBoundingClientRect()]);
  if (window.gsap && !matchMedia('(prefers-reduced-motion: reduce)').matches) for (const [item, rect] of next) {
    const previous = positions.get(item);
    gsap.fromTo(item, { x: previous.left - rect.left, y: previous.top - rect.top }, { x: 0, y: 0, duration: .25, ease: 'power2.out', overwrite: true, clearProps: 'transform' });
  }
}
function beginSort(node, kind) {
  if (sortSaving) return false;
  const nodes = sortNodes(node.parentElement);
  const selectionBefore = kind === 'block' ? { ids: [...selectedDocumentBlocks], range: documentTextRange && structuredClone(documentTextRange), active: selectedBlockId, anchor: documentSelectionAnchor && { ...documentSelectionAnchor } } : null;
  const selectedIds = kind === 'block' ? new Set(documentSelectedIds()) : selected;
  const key = kind === 'block' ? 'block' : 'row';
  const members = selectedIds.has(node.dataset[key]) ? nodes.filter(item => selectedIds.has(item.dataset[key])) : [node];
  sorting = { node, members, kind, parent: node.parentElement, order: nodes.map(item => item.dataset.row || item.dataset.block), selectionBefore, dropped: false };
  if (kind === 'block') { closeBlockMenu(); selectedDocumentBlocks = new Set(members.map(item => item.dataset.block)); documentTextRange = null; selectedBlockId = node.dataset.block; window.getSelection()?.removeAllRanges(); paintDocumentSelection(); }
  members.forEach(item => item.classList.add('sorting-source')); if (kind === 'work') { workClickSuppressUntil = Infinity; ensureSortMarker(); } return true;
}
async function commitSort() {
  if (!sorting) return;
  const current = sorting; sorting = null; current.members.forEach(item => item.classList.remove('sorting-source'));
  $('#block-drop-marker')?.remove(); if (current.kind === 'work') workClickSuppressUntil = Date.now() + 350;
  const ids = sortNodes(current.parent).map(item => item.dataset.row || item.dataset.block);
  if (ids.join('|') === current.order.join('|')) return;
  if (current.kind === 'block') { blockMenuSuppressUntil = Date.now() + 300; const lookup = new Map(editor.blocks.map(block => [block.id, block])); editor.blocks = ids.map(id => lookup.get(id)); renumberDocumentLists(); changed(); render(); document.querySelector(`[data-block="${current.node.dataset.block}"] [data-block-handle]`)?.focus({ preventScroll: true }); return; }
  // Preserve hidden/filtered projects in their existing slots.
  const original = activeProjects().map(row => row.id), visible = new Set(ids); let index = 0;
  const all = original.map(id => visible.has(id) ? ids[index++] : id);
  sortSaving = true;
  try {
    await api('/api/reorder', 'POST', { ids: all }); await loadState(false);
    const tabs = $('.list-toolbar .tabs'); if (tabs) tabs.innerHTML = renderWorkTabs();
    document.querySelectorAll('[data-row]').forEach(node => { const row = db.projects.find(row => row.id === node.dataset.row), state = node.querySelector('.status'); if (row && state) state.outerHTML = node.classList.contains('work-card') ? cardBadge(row) : badge(row); });
    toast('顺序已保存，发布后生效');
  }
  catch (error) { await loadState(false); render(); throw error; }
  finally { sortSaving = false; }
}
function cancelSort() {
  clearPointerSort();
  if (!sorting) return;
  const current = sorting; sorting = null;
  if (current.kind === 'work') workClickSuppressUntil = Date.now() + 350;
  const nodes = new Map(sortNodes(current.parent).map(node => [node.dataset.row || node.dataset.block, node]));
  current.order.forEach(id => { const node = nodes.get(id); if (current.kind === 'block') current.parent.insertBefore(node, $('#editor-dropzone')); else current.parent.append(node); });
  current.members.forEach(item => item.classList.remove('sorting-source'));
  const restored = sortNodes(current.parent); if (window.gsap) gsap.killTweensOf(restored); restored.forEach(item => { item.style.transform = ''; });
  if (current.selectionBefore) { selectedDocumentBlocks = new Set(current.selectionBefore.ids); documentTextRange = current.selectionBefore.range; selectedBlockId = current.selectionBefore.active; documentSelectionAnchor = current.selectionBefore.anchor; paintDocumentSelection(); }
}
function sortOver(target, x, y) {
  if (!sorting || sorting.members.includes(target) || target.parentElement !== sorting.parent) return;
  const rect = target.getBoundingClientRect();
  const sameRow = sorting.kind === 'work' && sorting.parent.classList.contains('work-cards');
  const after = sameRow ? y > rect.bottom || (y >= rect.top && x > rect.left + rect.width / 2) : y > rect.top + rect.height / 2;
  if (sorting.kind === 'work') sorting.drop = { target, after };
  moveWithAnimation(sorting.node, target, after);
  updateSortMarker();
}
document.addEventListener('dragstart', event => {
  if (touchSort || event.target.closest('input, label')) { event.preventDefault(); return; }
  const grip = event.target.closest('[data-block-handle]'), row = event.target.closest('[data-row][draggable]');
  const node = grip?.closest('[data-block]') || row;
  if (!node || !beginSort(node, grip ? 'block' : 'work')) return;
  event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', grip ? grip.dataset.blockId : row.dataset.row);
}, true);
document.addEventListener('dragover', event => {
  if (sorting) { event.preventDefault(); const node = event.target.closest(sorting.kind === 'block' ? '[data-block]' : '[data-row]'); if (node) sortOver(node, event.clientX, event.clientY); }
  else if (event.target.closest('#editor-dropzone') && event.dataTransfer?.types?.includes('Files')) { event.preventDefault(); $('#editor-dropzone').classList.add('over'); }
}, true);
document.addEventListener('drop', event => {
  if (sorting) { event.preventDefault(); commitSort().catch(error => toast(error.message, true)); }
  else if (editor && event.dataTransfer?.files?.length && event.target.closest('#editor-dropzone')) { event.preventDefault(); $('#editor-dropzone').classList.remove('over'); uploadFiles([...event.dataTransfer.files], { projectId: editor.id }).then(assets => { if (assets.length) addImages(assets); }).catch(error => toast(error.message, true)); }
}, true);
document.addEventListener('dragend', cancelSort);
document.addEventListener('dragleave', event => event.target.closest('#editor-dropzone')?.classList.remove('over'));

document.addEventListener('pointerdown', event => {
  editorBackdropDown = Boolean(event.target.closest?.('[data-editor-overlay]') && event.target.matches('[data-editor-overlay]'));
  const stage = event.target.closest('.crop-stage');
  if (stage && cropDraft) { event.preventDefault(); const box = stage.getBoundingClientRect(), scale = Math.max(box.width / cropDraft.asset.width, box.height / cropDraft.asset.height) * cropDraft.zoom; cropPan = { pointer: event.pointerId, x: event.clientX, y: event.clientY, originalX: cropDraft.x, originalY: cropDraft.y, rangeX: cropDraft.asset.width * scale - box.width, rangeY: cropDraft.asset.height * scale - box.height }; stage.setPointerCapture?.(event.pointerId); return; }
  const handle = event.target.closest('[data-block-handle], [data-work-handle]');
  const card = event.target.closest('.work-card[data-row]');
  const cardSurface = card && !event.target.closest('button, a, input, label, summary, details');
  const grip = handle || (cardSurface ? card : null);
  if (!grip || event.button > 0 || sortSaving) return;
  if (grip.matches('[data-block-handle]') && (event.ctrlKey || event.metaKey || event.shiftKey)) return;
  const node = grip.closest('[data-block], [data-row]');
  if (handle || event.pointerType !== 'touch') event.preventDefault(); closeBlockMenu();
  if (node.dataset.block && !node.querySelector('.rich-block-host') && !documentSelectedIds().includes(node.dataset.block)) selectDocumentBlock(node.dataset.block);
  touchSort = { pointer: event.pointerId, grip, node, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY };
  grip.setPointerCapture?.(event.pointerId);
}, true);
document.addEventListener('pointermove', event => {
  if (cropPan && cropDraft && cropPan.pointer === event.pointerId) {
    cropDraft.x = Math.min(1, Math.max(0, cropPan.originalX - (event.clientX - cropPan.x) / (cropPan.rangeX || Infinity)));
    cropDraft.y = Math.min(1, Math.max(0, cropPan.originalY - (event.clientY - cropPan.y) / (cropPan.rangeY || Infinity))); updateCropImage();
  }
  if (touchSort && touchSort.pointer === event.pointerId) {
    event.preventDefault(); touchSort.x = event.clientX; touchSort.y = event.clientY;
    if (!sorting && Math.hypot(event.clientX - touchSort.startX, event.clientY - touchSort.startY) >= 6) {
      if (!beginSort(touchSort.node, touchSort.node.dataset.block ? 'block' : 'work')) return clearPointerSort();
      document.body.classList.add('block-dragging');
      const preview = document.createElement('div'); preview.id = 'block-drag-preview'; preview.textContent = sorting.members.length > 1 ? `移动 ${sorting.members.length} ${sorting.kind === 'work' ? '件作品' : '个内容块'}` : touchSort.node.querySelector('.work-card-title, .work-title, .block-file-name')?.textContent || touchSort.node.querySelector('.rich-editor')?.textContent.slice(0, 32) || '移动内容块'; document.body.append(preview);
      ensureSortMarker(); sortScrollFrame = requestAnimationFrame(autoScrollSort);
    }
    if (sorting) pointerSortAt(event.clientX, event.clientY);
  }
}, { passive: false, capture: true });
document.addEventListener('pointerup', event => { if (cropPan?.pointer === event.pointerId) cropPan = null; if (touchSort?.pointer === event.pointerId) { if (sorting) { event.preventDefault(); blockMenuSuppressUntil = Date.now() + 350; clearPointerSort(); commitSort().catch(error => toast(error.message, true)); } else clearPointerSort(); } }, true);
document.addEventListener('pointercancel', () => { cropPan = null; touchSort = null; cancelSort(); });

document.addEventListener('click', event => {
  const card = event.target.closest?.('.work-card[data-row]');
  if (!card || event.target.closest('button, input, label, a')) return;
  if (Date.now() < workClickSuppressUntil) { event.preventDefault(); event.stopImmediatePropagation(); return; }
  if (selected.size) { event.preventDefault(); event.stopImmediatePropagation(); toggleWorkSelection(card.dataset.row); }
}, true);
document.addEventListener('input', event => { if (event.target.matches('[data-block-field=text]')) growText(event.target); });
document.addEventListener('click', event => { if (editorBackdropDown && event.target.matches('[data-editor-overlay]') && !$('#dialog').open) closeEditor().catch(error => toast(error.message, true)); editorBackdropDown = false; });
document.addEventListener('keydown', event => {
  if ((sorting || touchSort) && event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); cancelSort(); return; }
  if (event.target.closest?.('[data-block-handle]') && event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
    event.preventDefault(); const node = event.target.closest('[data-block]'); if (!beginSort(node, 'block')) return;
    const nodes = sortNodes(node.parentElement), after = event.key === 'ArrowDown', boundary = after ? sorting.members.at(-1) : sorting.members[0], next = nodes[nodes.indexOf(boundary) + (after ? 1 : -1)];
    if (next) { moveWithAnimation(node, next, after); commitSort().catch(error => toast(error.message, true)); } else cancelSort(); return;
  }
  if (!editor || $('#dialog').open) return;
  if (event.key === 'Escape' && (blockMenu || labelsMenuOpen)) return;
  if (event.key === 'Escape') { event.preventDefault(); closeEditor().catch(error => toast(error.message, true)); }
  if (event.key === 'Tab') { const nodes = [...$('.editor-shell').querySelectorAll('button,input,select,textarea,a[href],[tabindex="0"]')].filter(node => !node.disabled && !node.closest('[hidden]')); const first = nodes[0], last = nodes.at(-1); if (event.shiftKey && (document.activeElement === first || document.activeElement === $('.editor-shell'))) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } }
});
