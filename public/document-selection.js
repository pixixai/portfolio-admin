// Coordinates selection across independently editable blocks. Positions are
// ProseMirror document positions, never offsets into Markdown source.
function orderedDocumentRange(range = documentTextRange) {
  if (!range || !editor) return null;
  const a = editor.blocks.findIndex(block => block.id === range.anchor.id), b = editor.blocks.findIndex(block => block.id === range.head.id);
  if (a < 0 || b < 0) return null;
  return a < b || a === b && (range.anchor.pos ?? 0) <= (range.head.pos ?? Infinity)
    ? { start: range.anchor, end: range.head, first: a, last: b }
    : { start: range.head, end: range.anchor, first: b, last: a };
}
function documentSelectedIds() {
  const range = orderedDocumentRange();
  return range ? editor.blocks.slice(range.first, range.last + 1).map(block => block.id) : [...selectedDocumentBlocks];
}
function documentBlockIsFullySelected(id) {
  if (!id || !editor) return false;
  if (selectedDocumentBlocks.has(id)) return true;
  const bounds = window.PortfolioRichText?.bounds(id); if (!bounds) return false;
  const range = orderedDocumentRange();
  if (range) {
    const index = editor.blocks.findIndex(block => block.id === id);
    return index >= range.first && index <= range.last
      && (index > range.first || range.start.pos == null || range.start.pos <= bounds.from)
      && (index < range.last || range.end.pos == null || range.end.pos >= bounds.to);
  }
  const selection = window.PortfolioRichText?.get(id)?.state.selection;
  return Boolean(selection && !selection.empty && selection.from <= bounds.from && selection.to >= bounds.to);
}
function paintDocumentSelection() {
  if (documentSelectionPainting || !editor) return;
  documentSelectionPainting = true;
  try {
    const range = orderedDocumentRange(), api = window.PortfolioRichText;
    document.querySelectorAll('#block-list>[data-block]').forEach(node => {
      const id = node.dataset.block, index = editor.blocks.findIndex(block => block.id === id), whole = selectedDocumentBlocks.has(id);
      const inside = range && index >= range.first && index <= range.last;
      node.classList.toggle('is-selected', whole || Boolean(inside && !node.querySelector('.rich-editor')));
      node.classList.toggle('has-document-selection', Boolean(inside)); node.dataset.selected = String(whole || Boolean(inside));
      const bounds = api?.bounds(id); let highlight = null;
      if (bounds && inside && !whole) {
        highlight = { from: inside && index === range.first && range.start.pos != null ? range.start.pos : 0, to: inside && index === range.last && range.end.pos != null ? range.end.pos : bounds.size };
      }
      api?.highlight(id, highlight);
    });
  } finally { documentSelectionPainting = false; }
}
function selectDocumentRange(anchor, head) {
  documentTextRange = { anchor: { ...anchor }, head: { ...head } }; selectedDocumentBlocks.clear(); selectedBlockId = null;
  window.getSelection()?.removeAllRanges(); paintDocumentSelection();
}
function indentDocumentSelection(direction, fallback = activeTextCursor?.id) {
  const ids = documentSelectedIds(), targets = new Set(ids.length ? ids : fallback ? [fallback] : []); if (!targets.size) return;
  const cursor = activeTextCursor && { ...activeTextCursor }, single = cursor && window.PortfolioRichText?.get(cursor.id)?.state.selection;
  const savedSelection = single ? { from: single.from, to: single.to } : null;
  for (const block of editor.blocks) if (targets.has(block.id)) block.indent = Math.max(0, Math.min(6, (block.indent || 0) + direction));
  renumberDocumentLists(); changed(); redrawDocument();
  if (!ids.length && cursor) {
    focusDocumentBlock(cursor.id); const instance = window.PortfolioRichText?.get(cursor.id);
    if (instance && savedSelection) instance.commands.setTextSelection({ from: Math.min(savedSelection.from, instance.state.doc.content.size), to: Math.min(savedSelection.to, instance.state.doc.content.size) });
  }
  if (ids.length) document.querySelector(`[data-block="${ids.at(-1)}"] [data-block-handle]`)?.focus({ preventScroll: true });
  paintDocumentSelection();
}
function selectedDocumentText(markdown = false) {
  const range = orderedDocumentRange(), ids = new Set(documentSelectedIds()), api = window.PortfolioRichText;
  return editor.blocks.filter(block => ids.has(block.id)).map(block => {
    if (!textBlock(block)) return markdown ? `@[${block.type}](${assetById(block.assetId)?.url || ''})` : block.alt || assetById(block.assetId)?.name || '';
    const bounds = api.bounds(block.id), from = range?.start.id === block.id && range.start.pos != null ? range.start.pos : 0, to = range?.end.id === block.id && range.end.pos != null ? range.end.pos : bounds.size;
    return markdown ? api.rangeMarkdown(block.id, from, to) : api.rangeText(block.id, from, to);
  }).join('\n\n');
}
function replaceDocumentSelection(value = '') {
  const range = orderedDocumentRange(), ids = new Set(documentSelectedIds()); if (!ids.size) return false;
  documentSelectionClick = false;
  let focus, offset = 0, richPosition = null;
  if (range) {
    const first = editor.blocks[range.first], last = editor.blocks[range.last], api = window.PortfolioRichText;
    const left = textBlock(first) && range.start.pos != null ? api.rangeMarkdown(first.id, 0, range.start.pos) : '';
    const right = textBlock(last) && range.end.pos != null ? api.rangeMarkdown(last.id, range.end.pos) : '';
    if (left || right || value || textBlock(first)) {
      const merged = textBlock(first) ? api.mergeRange(range.start, range.end, value) : null;
      richPosition = merged?.position;
      focus = { ...newTextBlock(merged?.value ?? left + value + right), id: first.id, ...(first.indent ? { indent: first.indent } : {}) };
      editor.blocks.splice(range.first, range.last - range.first + 1, focus); offset = left.length + value.length;
    } else editor.blocks.splice(range.first, range.last - range.first + 1);
  } else {
    const first = editor.blocks.findIndex(block => ids.has(block.id)); editor.blocks = editor.blocks.filter(block => !ids.has(block.id));
    if (value) { focus = newTextBlock(value); editor.blocks.splice(first, 0, focus); offset = value.length; }
    else focus = editor.blocks[Math.max(0, first - 1)] || editor.blocks[0];
  }
  if (!editor.blocks.length) { focus = newTextBlock(value); editor.blocks.push(focus); }
  focus ||= editor.blocks[Math.max(0, (range?.first || 0) - 1)] || editor.blocks[0];
  selectDocumentBlock(null); documentSelectionAnchor = null; closeBlockMenu(); renumberDocumentLists(); changed(); redrawDocument();
  if (focus) {
    focusDocumentBlock(focus.id, offset);
    const instance = window.PortfolioRichText?.get(focus.id);
    // Locate the insertion point using a parsed prefix, preserving formatted
    // boundary text rather than counting Markdown punctuation as characters.
    if (instance && range) {
      const prefix = range.start.pos != null ? range.start.pos : 1, position = Math.min(instance.state.doc.content.size - 1, Math.max(1, richPosition ?? prefix + value.length));
      instance.commands.setTextSelection(position);
    }
  }
  return true;
}
function documentPointAt(event) {
  const root = document.querySelector('#block-list'); if (!root) return null;
  let article = event.target.closest?.('#block-list>[data-block]');
  if (!article) {
    const nodes = [...root.querySelectorAll(':scope>[data-block]')];
    article = nodes.find(node => event.clientY <= node.getBoundingClientRect().bottom) || nodes.at(-1);
  }
  if (!article) return null;
  return window.PortfolioRichText?.point(article.dataset.block, event.clientX, event.clientY) || { id: article.dataset.block, pos: null };
}
function documentSelectionScroll() {
  const drag = documentPointerSelection; if (!drag?.active) return;
  const scroller = document.querySelector('.editor-scroll'), bounds = scroller?.getBoundingClientRect();
  if (bounds) {
    const top = Math.max(bounds.top, document.querySelector('.document-toolbar')?.getBoundingClientRect().bottom || bounds.top);
    const delta = drag.y < top + 30 ? -14 : drag.y > bounds.bottom - 30 ? 14 : 0;
    if (delta) { scroller.scrollTop += delta; const point = documentPointAt({ target: scroller, clientX: drag.x, clientY: drag.y }); if (point) selectDocumentRange(drag.anchor, point); }
  }
  drag.frame = requestAnimationFrame(documentSelectionScroll);
}
document.addEventListener('pointerdown', event => {
  if (!editor || event.button > 0 || event.pointerType === 'touch' || document.querySelector('#dialog').open) return;
  const block = event.target.closest?.('#block-list>[data-block]');
  if (event.target.id === 'block-list') {
    const last = event.target.querySelector(':scope>[data-block]:last-of-type');
    if (last && event.clientY < last.getBoundingClientRect().bottom) event.preventDefault();
  }
  if (!block || event.target.closest('.table-ui,.table-axis-menu,.code-copy-button,.block-hover-tools,input,textarea')) return;
  const id = block.dataset.block, handle = event.target.closest('[data-block-handle]');
  documentSelectionClick = false; documentSelectAllStage = null;
  if (event.ctrlKey || event.metaKey) {
    event.preventDefault(); event.stopImmediatePropagation(); closeBlockMenu();
    if (documentTextRange) { selectedDocumentBlocks = new Set(documentSelectedIds()); documentTextRange = null; }
    if (!selectedDocumentBlocks.size && activeTextCursor?.id && activeTextCursor.id !== id) selectedDocumentBlocks.add(activeTextCursor.id);
    selectedDocumentBlocks.has(id) ? selectedDocumentBlocks.delete(id) : selectedDocumentBlocks.add(id);
    selectedBlockId = selectedDocumentBlocks.has(id) ? id : [...selectedDocumentBlocks].at(-1) || null;
    documentSelectionAnchor ||= { id, pos: null }; documentSelectionClick = true;
    block.focus({ preventScroll: true }); window.getSelection()?.removeAllRanges(); paintDocumentSelection(); return;
  }
  const point = handle ? { id, pos: null } : documentPointAt(event);
  if (event.shiftKey && (documentSelectionAnchor || activeTextCursor)) {
    event.preventDefault(); event.stopImmediatePropagation(); closeBlockMenu();
    const anchor = documentSelectionAnchor || { id: activeTextCursor.id, pos: activeTextCursor.from ?? null };
    selectDocumentRange(handle ? { id: anchor.id, pos: null } : anchor, point); documentSelectionClick = true; return;
  }
  if (handle) return;
  selectDocumentBlock(null); documentSelectionAnchor = point;
  documentPointerSelection = { pointer: event.pointerId, anchor: point, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, active: false };
}, true);
document.addEventListener('pointermove', event => {
  const drag = documentPointerSelection; if (!drag || drag.pointer !== event.pointerId) return;
  drag.x = event.clientX; drag.y = event.clientY;
  if (!drag.active && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 4) return;
  const point = documentPointAt(event); if (!point || !drag.active && point.id === drag.anchor.id) return;
  if (!drag.active) { drag.active = true; drag.frame = requestAnimationFrame(documentSelectionScroll); }
  event.preventDefault(); event.stopImmediatePropagation(); selectDocumentRange(drag.anchor, point);
}, true);
function finishDocumentSelection() {
  if (documentPointerSelection?.frame) cancelAnimationFrame(documentPointerSelection.frame);
  if (documentPointerSelection?.active) documentSelectionClick = true;
  documentPointerSelection = null;
  if (documentSelectionClick) setTimeout(() => { documentSelectionClick = false; }, 0);
}
document.addEventListener('pointerup', finishDocumentSelection, true);
document.addEventListener('pointercancel', finishDocumentSelection, true);
document.addEventListener('click', event => { if (documentSelectionClick && event.target.closest?.('#block-list')) { event.preventDefault(); event.stopImmediatePropagation(); } }, true);
document.addEventListener('keydown', event => {
  if (!editor || document.querySelector('#dialog').open || event.isComposing || event.keyCode === 229) return;
  const target = event.target, inBody = target.closest?.('#block-list,#block-type-menu'), hasSelection = documentTextRange || selectedDocumentBlocks.size;
  if (!inBody && !(hasSelection && target.closest?.('.editor-shell'))) return;
  if (target.closest?.('input,textarea,.table-axis-menu,.table-ui')) return;
  const modifier = event.ctrlKey || event.metaKey;
  if (modifier && event.key.toLowerCase() === 'a') {
    event.preventDefault(); event.stopImmediatePropagation(); closeBlockMenu();
    const id = target.closest('[data-block]')?.dataset.block || selectedBlockId || activeTextCursor?.id;
    const instance = window.PortfolioRichText?.get(id);
    if (instance?.isEmpty || documentBlockIsFullySelected(id) || documentSelectAllStage === id || hasSelection && documentSelectAllStage === 'all') {
      documentTextRange = null; selectedDocumentBlocks = new Set(editor.blocks.map(block => block.id)); selectedBlockId = id; documentSelectAllStage = 'all';
      window.getSelection()?.removeAllRanges(); paintDocumentSelection();
    } else {
      selectDocumentBlock(null); documentSelectAllStage = id;
      const bounds = window.PortfolioRichText?.bounds(id);
      if (instance) instance.commands.setTextSelection({ from: bounds.from, to: bounds.to });
      else selectDocumentBlock(id);
    }
    return;
  }
  documentSelectAllStage = null;
  if (event.key === 'Tab') { event.preventDefault(); event.stopImmediatePropagation(); closeBlockMenu(); indentDocumentSelection(event.shiftKey ? -1 : 1, target.closest('[data-block]')?.dataset.block); return; }
  if (!hasSelection) return;
  if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); const id = orderedDocumentRange()?.start.id || selectedBlockId; closeBlockMenu(); focusDocumentBlock(id); return; }
  if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key) && !event.shiftKey && !modifier && !event.altKey) {
    const range = orderedDocumentRange(), ids = new Set(documentSelectedIds()), rows = editor.blocks.filter(block => ids.has(block.id)), start = ['ArrowLeft','ArrowUp'].includes(event.key);
    const point = range ? start ? range.start : range.end : { id: (start ? rows[0] : rows.at(-1)).id, pos: null };
    event.preventDefault(); event.stopImmediatePropagation(); focusDocumentBlock(point.id, start ? 0 : 1);
    const instance = window.PortfolioRichText?.get(point.id); if (instance && point.pos != null) instance.commands.setTextSelection(point.pos); return;
  }
  if (['Backspace','Delete'].includes(event.key) || event.key === 'Enter' && (documentTextRange || selectedDocumentBlocks.size > 1 || textBlock(editor.blocks.find(block => block.id === selectedBlockId)))) {
    event.preventDefault(); event.stopImmediatePropagation(); replaceDocumentSelection(event.key === 'Enter' ? '\n' : ''); return;
  }
  if (modifier && ['b','i','u'].includes(event.key.toLowerCase())) {
    event.preventDefault(); event.stopImmediatePropagation(); const range = orderedDocumentRange();
    documentSelectionPainting = true;
    for (const id of documentSelectedIds()) {
      const instance = window.PortfolioRichText?.get(id); if (!instance) continue;
      instance.commands.setTextSelection({ from: range?.start.id === id && range.start.pos != null ? range.start.pos : 0, to: range?.end.id === id && range.end.pos != null ? range.end.pos : instance.state.doc.content.size });
      instance.commands[{ b: 'toggleBold', i: 'toggleItalic', u: 'toggleUnderline' }[event.key.toLowerCase()]]();
    }
    documentSelectionPainting = false; paintDocumentSelection(); return;
  }
  if (event.key.length === 1 && !modifier && !event.altKey) { event.preventDefault(); event.stopImmediatePropagation(); replaceDocumentSelection(event.key); }
}, true);
document.addEventListener('copy', event => {
  if (!editor || !(documentTextRange || selectedDocumentBlocks.size) || !event.clipboardData || document.querySelector('#dialog').open || event.target.closest?.('input,textarea')) return;
  event.preventDefault(); event.stopImmediatePropagation(); event.clipboardData.setData('text/plain', selectedDocumentText());
  event.clipboardData.setData('text/x-markdown', selectedDocumentText(true));
}, true);
document.addEventListener('cut', event => {
  if (!editor || !(documentTextRange || selectedDocumentBlocks.size) || !event.clipboardData || document.querySelector('#dialog').open || event.target.closest?.('input,textarea')) return;
  event.preventDefault(); event.stopImmediatePropagation(); event.clipboardData.setData('text/plain', selectedDocumentText()); event.clipboardData.setData('text/x-markdown', selectedDocumentText(true)); replaceDocumentSelection();
}, true);
document.addEventListener('paste', event => {
  if (!editor || !(documentTextRange || selectedDocumentBlocks.size) || !event.clipboardData || document.querySelector('#dialog').open || event.target.closest?.('input,textarea')) return;
  event.preventDefault(); event.stopImmediatePropagation(); replaceDocumentSelection(event.clipboardData.getData('text/plain'));
}, true);
document.addEventListener('beforeinput', event => {
  if (!editor || !(documentTextRange || selectedDocumentBlocks.size) || !event.target.closest?.('#block-list') || event.target.closest('input,textarea')) return;
  if (!['insertText', 'insertCompositionText', 'insertParagraph', 'deleteContentBackward', 'deleteContentForward'].includes(event.inputType)) return;
  event.preventDefault(); event.stopImmediatePropagation(); replaceDocumentSelection(event.inputType === 'insertParagraph' ? '\n' : event.inputType.startsWith('insert') ? event.data || '' : '');
}, true);
