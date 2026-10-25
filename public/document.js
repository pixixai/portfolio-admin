let activeTextCursor = null, blockMenu = null, labelsMenuOpen = false, labelSearch = '', pendingDocumentFocus = null, blockMenuSuppressUntil = 0, selectedBlockId = null;
let selectedDocumentBlocks = new Set(), documentTextRange = null, documentSelectionAnchor = null, documentSelectionPainting = false, documentPointerSelection = null, documentSelectionClick = false, documentSelectAllStage = null;
const projectLabels = doc => [...new Set((Array.isArray(doc?.labels) ? doc.labels : [doc?.category, ...(doc?.tags || [])]).filter(label => label && label !== '未分类'))];
const allLabelOptions = () => [...new Set([...db.settings.categories, ...db.projects.flatMap(row => projectLabels(row.draft))])].filter(label => label !== '未分类');
const labelTone = label => [...label].reduce((value, char) => value + char.charCodeAt(0), 0) % 6;
const newTextBlock = (text = '') => ({ id: crypto.randomUUID(), type: 'text', text });
const textBlock = block => block && ['text', 'heading', 'table'].includes(block.type);
const tableMarkdown = '<!-- portfolio-table row=0 column=0 -->\n|  |  |  |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |';
function clearLegacyTableLabels(block) {
  if (block.type !== 'table') return block;
  const lines = block.text.trim().split('\n'), cells = line => line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
  if (lines.length < 3 || !lines.every(line => /^\s*\|.*\|\s*$/.test(line))) return block;
  const header = cells(lines[0]);
  if (header.length < 3 || !header.every((cell, i) => !cell || cell === `列 ${i + 1}`) || !lines.slice(2).every(line => cells(line).every(cell => !cell))) return block;
  return { ...block, text: ['<!-- portfolio-table row=0 column=0 -->', '| ' + header.map(() => '').join(' | ') + ' |', ...lines.slice(1)].join('\n') };
}
const listBlock = block => block?.type === 'text' && /^(?:[-*+] |\d+\. )/.test(block.text);
function selectDocumentBlock(id) {
  if (documentSelectionPainting) return;
  selectedBlockId = id; selectedDocumentBlocks = new Set(id ? [id] : []); documentTextRange = null;
  if (id) documentSelectionAnchor = { id, pos: null };
  paintDocumentSelection();
}
function renumberDocumentLists() {
  const counters = new Map();
  for (const block of editor.blocks) {
    if (!listBlock(block)) { counters.clear(); continue; }
    const indent = Math.min(block.indent || 0, 6); block.indent = Math.max(0, indent);
    for (const level of counters.keys()) if (level > block.indent) counters.delete(level);
    const ordered = block.text.match(/^(\d+)\. /);
    if (!ordered) { counters.delete(block.indent); continue; }
    const number = counters.has(block.indent) ? counters.get(block.indent) + 1 : 1; counters.set(block.indent, number);
    block.text = block.text.replace(/^\d+\./, `${number}.`);
  }
}
const formatOf = text => /^#{1,6}\s/.test(text) ? `md-h${Math.min(3, text.match(/^#+/)[0].length)}` : /^>\s/.test(text) ? 'md-quote' : /^\s*(?:[-*+] |\d+\. )/.test(text) ? 'md-list' : /^```/.test(text) ? 'md-code' : /^\s*(?:---|\*\*\*)\s*$/.test(text) ? 'md-rule' : '';

function renderLabelProperty() {
  const labels = editor.labels, options = allLabelOptions().filter(label => label.toLowerCase().includes(labelSearch.toLowerCase()));
  return `<div class="document-property-label">${icon('tag')}<span>标签</span></div><div class="label-select"><div class="label-value" role="button" tabindex="0" data-action="doc-label-menu" aria-expanded="${labelsMenuOpen}" aria-label="选择作品标签">${labels.length ? labels.map(label => `<span class="document-label tone-${labelTone(label)}">${esc(label)}<button data-action="doc-label-toggle" data-name="${esc(label)}" aria-label="移除标签 ${esc(label)}">${icon('close')}</button></span>`).join('') : '<span class="property-empty">选择标签</span>'}</div>${labelsMenuOpen ? `<div class="label-options" role="menu" aria-label="作品标签选项"><input id="document-label-search" value="${esc(labelSearch)}" placeholder="选择或创建一个标签" maxlength="40" aria-label="搜索标签"><div class="label-option-list">${options.map(label => `<button role="menuitemcheckbox" aria-checked="${labels.includes(label)}" data-action="doc-label-toggle" data-name="${esc(label)}"><span class="document-label tone-${labelTone(label)}">${esc(label)}</span>${labels.includes(label) ? icon('check') : ''}</button>`).join('')}${labelSearch.trim() && !allLabelOptions().includes(labelSearch.trim()) ? `<button data-action="doc-label-create" data-name="${esc(labelSearch.trim())}">${icon('plus')}创建“${esc(labelSearch.trim())}”</button>` : ''}${!options.length && !labelSearch.trim() ? '<p class="inline-note">输入名称创建第一个标签。</p>' : ''}</div></div>` : ''}</div>`;
}
function renderDocument() {
  const asset = coverFor(editor), ratio = ratioFor(editor);
  return `<header class="editor-heading"><div class="editor-heading-row"><div><h1 id="editor-title">编辑作品</h1><div class="save-state" id="save-state">${icon(dirty ? 'edit' : 'check')}${dirty ? '等待自动保存…' : '草稿已保存'}</div></div><div class="heading-actions">${btn('保存草稿', 'save', '', 'check', 'title="保存草稿（Ctrl+S / ⌘S）" aria-keyshortcuts="Control+s Meta+s"')}${btn('发布作品', 'publish-editor', 'primary', 'upload', 'data-job-action')}<button class="editor-close icon-btn" data-action="close-editor" aria-label="关闭编辑作品">${icon('close')}</button></div></div></header><div class="editor-layout document-layout"><div class="block-editor document-editor"><h1 class="document-title"><textarea rows="1" data-field="title" data-document-grow maxlength="120" aria-label="作品名称" placeholder="未命名作品">${esc(editor.title === '未命名作品' ? '' : editor.title)}</textarea></h1><div class="document-property" id="editor-labels">${renderLabelProperty()}</div><div class="document-property description-property"><div class="document-property-label">${icon('list')}<span>简介</span></div><textarea rows="1" data-field="description" data-document-grow maxlength="2000" aria-label="作品简介" placeholder="添加作品简介…">${esc(editor.description)}</textarea></div><div class="document-divider"></div><div class="block-toolbar document-toolbar">${btn('图片', 'add-images', 'small text', 'image')}${btn('视频', 'add-video', 'small text', 'video')}${btn('音频', 'add-audio', 'small text', 'audio')}${btn('表格', 'add-table', 'small text', 'grid')}${btn('在上方插入', 'doc-insert-before', 'small text', 'up')}${btn('在下方插入', 'doc-insert-after', 'small text', 'down')}<span>输入 / 切换块类型</span></div><div class="block-list document-body" id="block-list">${editor.blocks.map(renderDocumentBlock).join('')}<button class="document-tail" data-action="doc-append" id="editor-dropzone" aria-label="点击添加文字块"><span>点击继续输入，或输入 / 选择类型</span></button></div></div><aside class="editor-side content-card document-sidebar"><section class="document-cover"><div class="field-label"><strong>作品封面</strong><span class="cover-ratio-label" aria-label="当前封面比例">${esc(ratio)}</span></div><button class="cover-picker" data-action="edit-crop" ${asset ? '' : 'disabled'} aria-label="调整封面比例与裁切" style="aspect-ratio:${ratio.replace(':', '/')}">${asset ? `<img draggable="false" src="${asset.url}" style="${cropStyle(editor.coverCrop)}" alt="当前封面"><span>${icon('crop')}调整比例与裁切</span>` : `<span class="cover-placeholder">${icon('image')}${usesFirstImage(editor) ? '先在正文中添加图片，或选择封面' : '先选择一张封面图片'}</span>`}</button><div class="cover-options">${btn('选择封面', 'choose-cover', 'small soft', 'image')}<button type="button" role="switch" class="first-image-switch" data-action="toggle-first-cover" aria-checked="${usesFirstImage(editor)}"><span class="switch-track" aria-hidden="true"></span><span>使用内容首图</span></button><span class="cover-source-note">${usesFirstImage(editor) ? '跟随首图 · 点击封面调整裁切' : '独立封面 · 点击封面调整裁切'}</span></div></section><section class="document-preview"><h2>页面预览</h2>${renderPreview()}</section></aside></div>`;
}
function renderDocumentBlock(block, index) {
  const asset = assetById(block.assetId), media = !textBlock(block);
  const content = block.type === 'image' ? asset ? `<img draggable="false" src="${asset.url}" width="${asset.width}" height="${asset.height}" alt="${esc(block.alt)}">` : '<p class="empty">请选择媒体。</p>'
    : block.type === 'video' ? `<video controls playsinline preload="metadata" src="${asset?.url || ''}"></video>`
    : block.type === 'audio' ? `<div class="audio-block">${icon('audio')}<audio controls preload="metadata" src="${asset?.url || ''}"></audio></div>`
    : `<div class="rich-block-host" data-block-id="${block.id}"></div><textarea rows="1" data-block-field="text" data-block-id="${block.id}" placeholder="输入文字，或输入 / 选择类型" aria-label="第${index + 1}段文字">${esc(block.text)}</textarea>`;
  return `<article class="content-block ${media ? block.type : `text ${block.type === 'table' ? 'table' : formatOf(block.text)}`} ${selectedBlockId === block.id ? 'is-selected' : ''}" data-block="${block.id}" data-indent="${block.indent || 0}" style="--block-indent:${block.indent || 0}" ${media ? 'tabindex="0" role="group" aria-label="媒体块，点击选中，使用左侧手柄拖动"' : ''}><button class="block-grip" draggable="true" data-block-handle data-block-id="${block.id}" data-action="doc-block-menu" aria-haspopup="menu" aria-label="第${index + 1}块：拖动排序或点击切换类型" title="拖动排序 · 点击切换类型">${icon('drag')}</button>${content}${media ? `<div class="block-hover-tools"><span class="block-file-name">${esc(asset?.name || '媒体文件')}</span><span class="block-hover-actions"><button class="icon-btn" data-action="replace-image" data-block-id="${block.id}" aria-label="更换媒体">${icon('replace')}</button><button class="icon-btn" data-action="doc-remove" data-block-id="${block.id}" aria-label="删除此块">${icon('trash')}</button></span></div>` : ''}</article>`;
}
function updateLabelProperty() { const node = $('#editor-labels'); if (node) node.innerHTML = renderLabelProperty(); }
function revealDocumentCaret(id) {
  const scroller = $('.editor-scroll'), block = document.querySelector(`#block-list>[data-block="${id}"]`); if (!scroller || !block) return;
  const viewport = scroller.getBoundingClientRect(); if (!viewport.height) return;
  const toolbar = $('.document-toolbar'), top = Math.max(viewport.top, toolbar?.getBoundingClientRect().bottom || viewport.top) + 12, bottom = viewport.bottom - 20;
  if (bottom <= top) return;
  let rect;
  const instance = window.PortfolioRichText?.get(id);
  if (instance) { try { rect = instance.view.coordsAtPos(instance.state.selection.head); } catch {} }
  if (!rect || !Number.isFinite(rect.top) || !Number.isFinite(rect.bottom)) {
    const bounds = block.getBoundingClientRect(); rect = { top: bounds.top, bottom: bounds.top + Math.min(28, bounds.height) };
  }
  if (rect.bottom < rect.top || rect.bottom === 0 && rect.top === 0) return;
  if (rect.top < top) scroller.scrollTop -= top - rect.top;
  else if (rect.bottom > bottom) scroller.scrollTop += rect.bottom - bottom;
}
function focusDocumentBlock(id, position = 0) {
  selectDocumentBlock(null);
  if (window.PortfolioRichText?.focus(id, position)) {
    const scroller = $('.editor-scroll');
    requestAnimationFrame(() => { if (scroller?.isConnected && document.activeElement?.closest?.(`[data-block="${id}"]`)) revealDocumentCaret(id); });
    return;
  }
  pendingDocumentFocus = { id, position }; const node = document.querySelector(`textarea[data-block-id="${id}"]`);
  if (node) { node.focus({ preventScroll: true }); node.setSelectionRange(position, position); activeTextCursor = { id, start: position, end: position }; pendingDocumentFocus = null; }
  else { const media = document.querySelector(`#block-list>[data-block="${id}"]`); if (media) { selectDocumentBlock(id); media.focus({ preventScroll: true }); } }
  revealDocumentCaret(id);
}
function rememberDocumentCursor(node = document.activeElement) { const rich = window.PortfolioRichText?.selected(); if (rich) { activeTextCursor = rich; return; } if (node?.matches?.('textarea[data-block-field=text]')) activeTextCursor = { id: node.dataset.blockId, start: node.selectionStart, end: node.selectionEnd }; }
function mountDocumentRich() {
  if (!window.PortfolioRichText || !editor) return;
  PortfolioRichText.mountAll({ root: $('#block-list'),
    onFocus: () => { if (!documentTextRange && selectedDocumentBlocks.size === 1) selectDocumentBlock(null); },
    onSelect: context => { if (documentSelectionPainting) return; activeTextCursor = context; if (PortfolioRichText.get(context.id)?.isFocused && !documentTextRange && !selectedDocumentBlocks.size) documentSelectionAnchor = { id: context.id, pos: context.from }; },
    onSlash: (id, node) => showBlockMenu(id, node),
    onListSplit: (id, parts, focusIndex) => {
      const index = editor.blocks.findIndex(block => block.id === id); if (index < 0) return;
      const original = editor.blocks[index], replacements = parts.map((part, i) => ({ ...newTextBlock(part.text), id: i ? crypto.randomUUID() : original.id, indent: listBlock({ type: 'text', text: part.text }) ? (original.indent || 0) + part.indent : 0 }));
      editor.blocks.splice(index, 1, ...replacements); renumberDocumentLists(); changed(); redrawDocument({ id: replacements[focusIndex]?.id });
    },
    onIndent: (id, direction) => indentDocumentSelection(direction, id),
    onEnter: (id, left, right) => { const index = editor.blocks.findIndex(block => block.id === id); if (index < 0) return; editor.blocks[index].text = left; const next = newTextBlock(right); editor.blocks.splice(index + 1, 0, next); changed(); redrawDocument({ id: next.id }); },
    onExit: id => { const index = editor.blocks.findIndex(block => block.id === id), next = newTextBlock(); editor.blocks.splice(index + 1, 0, next); changed(); redrawDocument({ id: next.id }); },
    onBackspace: id => {
      const index = editor.blocks.findIndex(block => block.id === id); if (index <= 0) return false;
      const previous = editor.blocks[index - 1], current = editor.blocks[index];
      if (!textBlock(previous)) { if (PortfolioRichText.get(id)?.isEmpty || !current.text.trim()) { editor.blocks.splice(index, 1); changed(); redrawDocument(); focusDocumentBlock(previous.id); return true; } return false; }
      const at = previous.text.length; previous.text += current.text; editor.blocks.splice(index, 1); changed(); redrawDocument({ id: previous.id, position: at }); return true;
    },
  });
  paintDocumentSelection();
}
function redrawDocument(focus = null) { const id = focus?.id, position = focus?.position || 0; render(); if (id) focusDocumentBlock(id, position); }
function appendDocumentBlock() {
  const last = editor.blocks.at(-1);
  if (textBlock(last) && !last.text) return focusDocumentBlock(last.id);
  const block = newTextBlock(); editor.blocks.push(block); changed(); redrawDocument({ id: block.id });
}
function insertRelativeText(after) {
  const anchor = selectedBlockId || activeTextCursor?.id, index = editor.blocks.findIndex(block => block.id === anchor), block = newTextBlock();
  editor.blocks.splice(index < 0 ? (after ? editor.blocks.length : 0) : index + (after ? 1 : 0), 0, block);
  selectDocumentBlock(null); closeBlockMenu(); changed(); redrawDocument({ id: block.id });
}
function removeDocumentBlock(id) { const index = editor.blocks.findIndex(block => block.id === id); if (index < 0) return; editor.blocks.splice(index, 1); if (!editor.blocks.length) editor.blocks.push(newTextBlock()); if (selectedBlockId === id) selectedBlockId = null; renumberDocumentLists(); changed(); closeBlockMenu(); redrawDocument({ id: editor.blocks[Math.max(0, index - 1)]?.id }); }

function documentMediaContext() { return selectedBlockId ? { id: selectedBlockId, afterBlock: true } : activeTextCursor && { ...activeTextCursor }; }
function insertDocumentMedia(assets, context = documentMediaContext()) {
  if (!editor || !assets.length) return;
  let index = editor.blocks.findIndex(block => block.id === (context?.replaceId || context?.id));
  const blocks = assets.map(asset => ({ id: crypto.randomUUID(), type: mediaKind(asset), assetId: asset.id, alt: '' }));
  let focus;
  if (context?.replaceId && index >= 0) {
    const previous = editor.blocks[index]; blocks[0].id = previous.id;
    if (textBlock(previous) && previous.text.trim()) blocks.push(newTextBlock(previous.text));
    else if (!textBlock(previous)) blocks.push({ ...previous, id: crypto.randomUUID() });
    else if (index === editor.blocks.length - 1) blocks.push(newTextBlock());
    editor.blocks.splice(index, 1, ...blocks); focus = blocks.findLast(textBlock);
  } else if (index >= 0 && textBlock(editor.blocks[index]) && !context?.afterBlock) {
    const previous = editor.blocks[index], start = Math.min(context.start, previous.text.length), end = Math.min(context.end ?? start, previous.text.length);
    const rich = context.rich ? window.PortfolioRichText?.split(context) : null;
    const left = rich ? rich.left : previous.text.slice(0, start), right = rich ? rich.right : previous.text.slice(end), replacement = [];
    if (left) replacement.push({ ...previous, text: left });
    replacement.push(...blocks); focus = newTextBlock(right); replacement.push(focus); editor.blocks.splice(index, 1, ...replacement);
  } else {
    index = index >= 0 ? index + 1 : editor.blocks.length; editor.blocks.splice(index, 0, ...blocks); focus = newTextBlock(); editor.blocks.splice(index + blocks.length, 0, focus);
  }
  changed(); redrawDocument(focus && { id: focus.id });
}
function chooseDocumentMedia(kind, context = documentMediaContext()) {
  closeBlockMenu(); openMediaPicker(true, assets => insertDocumentMedia(assets, context), kind);
}
function closeBlockMenu() { $('#block-type-menu')?.remove(); blockMenu = null; }
function showBlockMenu(id, anchor) {
  if (!editor) return; closeBlockMenu();
  blockMenu = { id, focusIndex: 0, anchor };
  const menu = document.createElement('div'); menu.id = 'block-type-menu'; menu.className = 'block-type-menu'; menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', '切换块类型');
  const formats = [['text', '正文', '普通文字，支持 Markdown'], ['h1', '标题 1', '# 一级标题'], ['h2', '标题 2', '## 二级标题'], ['h3', '标题 3', '### 三级标题'], ['list', '项目列表', '- 列表项'], ['ordered', '编号列表', '1. 列表项'], ['task', '待办事项', '[] 复选框'], ['quote', '引用', '> 引用文字'], ['code', '代码块', '``` 代码围栏'], ['rule', '分割线', '---']];
  const formatButtons = formats.map(([format, label, hint]) => `<button role="menuitem" data-action="doc-type" data-type="text" data-format="${format}">${icon('type')}<span>${label}<small>${esc(hint)}</small></span></button>`);
  const mediaButtons = [['image','图片'],['video','视频'],['audio','音频']].map(([kind,label]) => `<button role="menuitem" data-action="doc-type" data-type="${kind}">${icon(kind)}<span>${label}<small>上传或从素材库选择</small></span></button>`).join('');
  menu.innerHTML = '<p>切换为</p>' + formatButtons[0] + mediaButtons + `<button role="menuitem" data-action="doc-type" data-type="table">${icon('grid')}<span>表格<small>独立表格块，支持增删行列</small></span></button>` + '<hr>' + formatButtons.slice(1).join('') + `<hr><button role="menuitem" data-action="doc-remove" data-block-id="${id}">${icon('trash')}<span>删除此块</span></button>`;
  document.body.append(menu); const rect = anchor.getBoundingClientRect(), height = Math.min(440, window.innerHeight - 40);
  menu.style.left = Math.max(12, Math.min(rect.left, window.innerWidth - 282)) + 'px'; menu.style.top = Math.max(12, Math.min(rect.top + Math.min(rect.height, 35), window.innerHeight - height - 16)) + 'px'; menu.style.maxHeight = height + 'px';
  menu.querySelector('button').focus({ preventScroll: true });
}
function convertDocumentBlock(kind, format) {
  const id = blockMenu?.id, block = editor.blocks.find(block => block.id === id); if (!block) return;
  if (kind === 'table') {
    closeBlockMenu(); const index = editor.blocks.indexOf(block), table = { ...newTextBlock(tableMarkdown), type: 'table' };
    if (textBlock(block)) { const value = window.PortfolioRichText?.rangeText(id) || block.text; table.text = tableMarkdown.replace('|  |  |  |', '| ' + value.replace(/\|/g, '\\|').replace(/\n/g, '<br>') + ' |  |  |'); editor.blocks.splice(index, 1, { ...table, id }); }
    else editor.blocks.splice(index + 1, 0, table);
    changed(); redrawDocument({ id: textBlock(block) ? id : table.id }); return;
  }
  if (kind !== 'text') return chooseDocumentMedia(kind, { replaceId: id });
  closeBlockMenu();
  const converted = textBlock(block) ? window.PortfolioRichText?.convertText(id, format) : null;
  let plain = textBlock(block) ? block.text : block.alt || '';
  plain = plain.replace(/^#{1,6}\s+|^>\s+|^(?:[-*+] |\d+\. )/, '');
  const prefix = { text: '', h1: '# ', h2: '## ', h3: '### ', list: '- ', ordered: '1. ', task: '- [ ] ', quote: '> ', code: '```\n', rule: '---' }[format] || '';
  const value = converted?.value ?? (format === 'code' ? prefix + plain + '\n```' : format === 'rule' ? '---' : prefix + plain);
  if (!textBlock(block)) { const next = newTextBlock(value); editor.blocks.splice(editor.blocks.indexOf(block) + 1, 0, next); changed(); redrawDocument({ id: next.id }); toast('原媒体已保留，转换内容放在下方'); return; }
  Object.assign(block, { type: 'text', text: value }); delete block.assetId; delete block.alt;
  if (converted?.leftover) editor.blocks.splice(editor.blocks.indexOf(block) + 1, 0, newTextBlock(converted.leftover));
  renumberDocumentLists(); changed(); redrawDocument({ id, position: format === 'code' ? 4 : value.length });
}

const documentActions = new Set(['doc-append', 'doc-block-menu', 'doc-type', 'doc-remove', 'doc-label-menu', 'doc-label-toggle', 'doc-label-create', 'doc-insert-before', 'doc-insert-after', 'add-table', 'add-text', 'add-heading', 'add-images', 'add-video', 'add-audio']);
async function documentAction(name, element) {
  if (name === 'doc-append' || name === 'add-text') return appendDocumentBlock();
  if (name === 'doc-block-menu') { if (sorting || documentSelectionClick || Date.now() < blockMenuSuppressUntil) return; selectDocumentBlock(element.dataset.blockId); activeTextCursor = { id: element.dataset.blockId, start: 0, end: 0 }; return showBlockMenu(element.dataset.blockId, element); }
  if (name === 'doc-insert-before' || name === 'doc-insert-after') return insertRelativeText(name === 'doc-insert-after');
  if (name === 'doc-type') return convertDocumentBlock(element.dataset.type, element.dataset.format);
  if (name === 'add-table') { const index = editor.blocks.findIndex(block => block.id === (selectedBlockId || activeTextCursor?.id)), block = { ...newTextBlock(tableMarkdown), type: 'table' }; editor.blocks.splice(index < 0 ? editor.blocks.length : index + 1, 0, block); changed(); return redrawDocument({ id: block.id }); }
  if (name === 'doc-remove') return removeDocumentBlock(element.dataset.blockId);
  if (name === 'add-heading') { const block = newTextBlock('## '); editor.blocks.push(block); changed(); return redrawDocument({ id: block.id, position: 3 }); }
  if (['add-images', 'add-video', 'add-audio'].includes(name)) { rememberDocumentCursor(); return chooseDocumentMedia(name === 'add-images' ? 'image' : name === 'add-video' ? 'video' : 'audio'); }
  if (name === 'doc-label-menu') { labelsMenuOpen = !labelsMenuOpen; labelSearch = ''; updateLabelProperty(); if (labelsMenuOpen) $('#document-label-search').focus(); return; }
  if (name === 'doc-label-toggle') {
    const label = element.dataset.name;
    if (editor.labels.includes(label)) editor.labels = editor.labels.filter(value => value !== label);
    else if (editor.labels.length < 30) editor.labels.push(label); else return toast('最多选择30个标签', true);
    editor.tags = [...editor.labels]; editor.category = editor.labels[0] || '未分类'; changed(); updateLabelProperty(); return;
  }
  if (name === 'doc-label-create') {
    const id = editor.id, label = element.dataset.name;
    await api('/api/tags', 'POST', { name: label, revision: db.settingsRevision }); await loadState(false);
    if (editor?.id !== id) return; if (!editor.labels.includes(label) && editor.labels.length < 30) editor.labels.push(label);
    editor.tags = [...editor.labels]; editor.category = editor.labels[0] || '未分类'; labelSearch = ''; changed(); updateLabelProperty();
  }
}

document.addEventListener('focusin', event => rememberDocumentCursor(event.target));
document.addEventListener('selectionchange', () => rememberDocumentCursor());
document.addEventListener('pointerdown', event => {
  const block = event.target.closest?.('[data-block]'); if (block && !block.querySelector('textarea')) activeTextCursor = { id: block.dataset.block, start: 0, end: 0 };
  if (event.target.closest?.('.document-toolbar')) rememberDocumentCursor();
  if (blockMenu && !event.target.closest?.('#block-type-menu,[data-block-handle]')) closeBlockMenu();
  if (labelsMenuOpen && !event.target.closest?.('#editor-labels')) { labelsMenuOpen = false; updateLabelProperty(); }
});
document.addEventListener('click', event => {
  if (documentSelectionClick) return;
  const selected = event.target.closest?.('#block-list>[data-block]');
  if (selected && !selected.querySelector('.rich-block-host') && !event.target.closest('[data-action]')) { selectDocumentBlock(selected.dataset.block); activeTextCursor = { id: selected.dataset.block, start: 0, end: 0 }; }
  else if (selected?.querySelector('.rich-block-host') && !documentTextRange && !event.target.closest?.('[data-block-handle],.block-hover-tools,.table-ui,.document-toolbar,#block-type-menu')) selectDocumentBlock(null);
  if (!editor || event.target.id !== 'block-list') return;
  const last = document.querySelector('#block-list>[data-block]:last-of-type');
  if (!last || event.clientY >= last.getBoundingClientRect().bottom) return appendDocumentBlock();
});
document.addEventListener('input', event => {
  const node = event.target;
  if (node.id === 'document-label-search') { const position = node.selectionStart; labelSearch = node.value; updateLabelProperty(); $('#document-label-search').focus(); $('#document-label-search').setSelectionRange(position, position); }
  if (node.matches?.('[data-document-grow]')) growText(node);
  if (node.matches?.('[data-block-field=text]')) { const article = node.closest('[data-block]'), table = Boolean(article.querySelector('.rich-editor table')); article.className = 'content-block text ' + (table ? 'table' : formatOf(node.value)) + (node.hidden ? ' rich-mode' : ''); const block = editor?.blocks.find(block => block.id === node.dataset.blockId); if (block && table) block.type = 'table'; else if (block?.type === 'table') block.type = 'text'; rememberDocumentCursor(node); }
});

document.addEventListener('pointerdown', event => {
  if (event.ctrlKey || event.metaKey || event.shiftKey || documentPointerSelection?.active) return;
  if (event.target.closest?.('.rich-editor,.table-ui,.table-axis-menu,.document-title,.document-property')) selectDocumentBlock(null);
}, true);
document.addEventListener('keydown', event => {
  if (editor && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); event.stopImmediatePropagation(); if (!event.repeat) saveProject().catch(error => toast(error.message, true)); return; }
  if (editor && selectedBlockId && event.key === 'Enter' && !event.isComposing && !$('#dialog').open && !event.target.closest?.('input,textarea,[contenteditable="true"],.table-ui,.table-axis-menu') && ['image','video','audio'].includes(editor.blocks.find(block => block.id === selectedBlockId)?.type)) { event.preventDefault(); event.stopImmediatePropagation(); insertRelativeText(true); return; }
  if (!editor || !selectedBlockId || !['Backspace', 'Delete'].includes(event.key) || event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey || $('#dialog').open) return;
  if (event.target.closest?.('input,textarea,[contenteditable="true"],.table-ui,.table-axis-menu')) return;
  const id = selectedBlockId; event.preventDefault(); event.stopImmediatePropagation(); removeDocumentBlock(id);
}, true);
document.addEventListener('keydown', event => {
  if (!editor || event.isComposing || event.keyCode === 229) return;
  const node = event.target;
  if (blockMenu) {
    if (event.key === 'Tab') { event.preventDefault(); const id = blockMenu.id; closeBlockMenu(); focusDocumentBlock(id, activeTextCursor?.start || 0); return; }
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); const id = blockMenu.id; closeBlockMenu(); focusDocumentBlock(id, activeTextCursor?.start || 0); return; }
    const buttons = [...$('#block-type-menu').querySelectorAll('button')], index = buttons.indexOf(document.activeElement);
    if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length].focus(); return; }
  }
  if (labelsMenuOpen && event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); labelsMenuOpen = false; updateLabelProperty(); $('#editor-labels [role=button]')?.focus(); return; }
  if (node.matches?.('[data-action=doc-label-menu]') && ['Enter', ' '].includes(event.key)) { event.preventDefault(); node.click(); return; }
  if (node.matches?.('[data-field=title]') && event.key === 'Enter') { event.preventDefault(); const block = newTextBlock(); editor.blocks.unshift(block); changed(); redrawDocument({ id: block.id }); return; }
  if (!node.matches?.('textarea[data-block-field=text]') || $('#dialog').open) return;
  rememberDocumentCursor(node); const index = editor.blocks.findIndex(block => block.id === node.dataset.blockId), block = editor.blocks[index];
  if (event.key === '/' && !node.value.trim()) { event.preventDefault(); showBlockMenu(block.id, node); return; }
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault(); const start = node.selectionStart, end = node.selectionEnd;
    block.text = node.value.slice(0, start); const next = newTextBlock(node.value.slice(end)); editor.blocks.splice(index + 1, 0, next); changed(); redrawDocument({ id: next.id }); return;
  }
  if (event.key === 'Backspace' && node.selectionStart === 0 && node.selectionEnd === 0 && index > 0) {
    const previous = editor.blocks[index - 1];
    if (textBlock(previous)) { event.preventDefault(); const at = previous.text.length; previous.text += node.value; editor.blocks.splice(index, 1); changed(); redrawDocument({ id: previous.id, position: at }); }
    else if (!node.value) { event.preventDefault(); removeDocumentBlock(block.id); }
  }
});
