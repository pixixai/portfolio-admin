import { CellSelection, TableMap } from '@tiptap/pm/tables';
import { TextSelection } from '@tiptap/pm/state';
import { closeHistory } from '@tiptap/pm/history';
import { resizeTable, changeTableAxis, toggleTableHeader, tableHeaders } from './table-model.js';

const dots = '<svg viewBox="0 0 12 16" aria-hidden="true"><g fill="currentColor">' + [3,8,13].flatMap(y => [3,9].map(x => `<circle cx="${x}" cy="${y}" r="1.3"/>`)).join('') + '</g></svg>';
const rectStyle = (node, rect, parent) => { node.style.left = `${rect.left - parent.left}px`; node.style.top = `${rect.top - parent.top}px`; node.style.width = `${Math.max(1, rect.width)}px`; node.style.height = `${Math.max(1, rect.height)}px`; };
export function attachTableUI(editor, host) {
  const article = host.closest('[data-block]'), doc = host.ownerDocument;
  const overlay = doc.createElement('div'); overlay.className = 'table-ui'; overlay.contentEditable = 'false'; overlay.hidden = true;
  overlay.innerHTML = '<div class="table-axis-selection" hidden></div><div class="table-axis-drop" hidden></div><button type="button" class="table-edge table-edge-row" data-table-edge="row" aria-label="添加行，拖动可批量增减空行">+</button><button type="button" class="table-edge table-edge-column" data-table-edge="column" aria-label="添加列，拖动可批量增减空列">+</button>' + ['row', 'column'].map(axis => `<button type="button" class="table-axis-handle table-axis-${axis}" data-table-axis="${axis}" aria-haspopup="menu" aria-label="${axis === 'row' ? '行' : '列'}操作，拖动排序">${dots}</button>`).join('') + '<div class="table-resize-note" role="status" hidden></div>';
  article.append(overlay);
  let hovered = { row: 0, column: 0 }, selected = null, gesture = null, menu = null, frame = 0, suppressClick = 0, destroyed = false;
  const edge = axis => overlay.querySelector(`[data-table-edge=${axis}]`);
  const handle = axis => overlay.querySelector(`[data-table-axis=${axis}]`);
  const note = overlay.querySelector('.table-resize-note');
  function locate() {
    const dom = host.querySelector('table'); if (!dom) return null;
    let result; editor.state.doc.descendants((node, pos) => { if (!result && node.type.name === 'table') result = { node, pos, dom }; }); return result;
  }
  function geometry() {
    const table = locate(); if (!table) return null;
    const rows = [...table.dom.rows], cols = [...(rows[0]?.cells || [])];
    return { ...table, rows, cols, rect: table.dom.getBoundingClientRect(), parent: article.getBoundingClientRect() };
  }
  function axisRect(data, axis, index) {
    if (axis === 'row') return data.rows[index]?.getBoundingClientRect();
    const cell = data.cols[index]?.getBoundingClientRect(); return cell && { left: cell.left, top: data.rect.top, width: cell.width, height: data.rect.height, right: cell.right, bottom: data.rect.bottom };
  }
  function update() {
    frame = 0; if (destroyed) return;
    const data = geometry(); overlay.hidden = !data; if (!data) { closeMenu(); return; }
    hovered.row = Math.min(hovered.row, data.rows.length - 1); hovered.column = Math.min(hovered.column, data.cols.length - 1);
    const visibleRight = Math.min(data.rect.right, host.getBoundingClientRect().right || data.rect.right), base = data.parent;
    rectStyle(edge('row'), { left: data.rect.left, top: data.rect.bottom + 1, width: visibleRight - data.rect.left, height: 19 }, base);
    rectStyle(edge('column'), { left: visibleRight + 1, top: data.rect.top, width: 19, height: data.rect.height }, base);
    for (const axis of ['row', 'column']) {
      const index = (menu || gesture) && selected?.axis === axis ? selected.index : hovered[axis], rect = axisRect(data, axis, index), button = handle(axis); if (!rect) continue;
      rectStyle(button, axis === 'row' ? { left: data.rect.left - 18, top: rect.top + rect.height / 2 - 12, width: 16, height: 24 } : { left: rect.left + rect.width / 2 - 12, top: data.rect.top - 18, width: 24, height: 16 }, base);
      button.classList.toggle('is-active', selected?.axis === axis && selected.index === index); button.dataset.index = index;
    }
    const selection = overlay.querySelector('.table-axis-selection'), rect = selected && axisRect(data, selected.axis, selected.index);
    selection.hidden = !rect; if (rect) rectStyle(selection, rect, base);
    overlay.dataset.active = String(Boolean(selected || gesture || menu));
  }
  function schedule() { if (!destroyed && !frame) frame = requestAnimationFrame(update); }
  function select(axis, index) {
    const table = locate(); if (!table) return;
    const map = TableMap.get(table.node), start = table.pos + 1;
    index = Math.max(0, Math.min(index, axis === 'row' ? map.height - 1 : map.width - 1)); selected = { axis, index }; hovered[axis] = index;
    const a = axis === 'row' ? map.map[index * map.width] : map.map[index];
    const b = axis === 'row' ? map.map[(index + 1) * map.width - 1] : map.map[(map.height - 1) * map.width + index];
    editor.view.dispatch(editor.state.tr.setSelection(CellSelection.create(editor.state.doc, start + a, start + b))); update();
  }
  function replace(table, history = true) {
    const current = locate(); if (!current) return;
    const node = editor.schema.nodeFromJSON(table), tr = editor.state.tr.replaceWith(current.pos, current.pos + current.node.nodeSize, node).setMeta('addToHistory', history);
    tr.setSelection(TextSelection.near(tr.doc.resolve(current.pos + 4))); editor.view.dispatch(tr); update();
  }
  function closeMenu() { menu?.remove(); menu = null; }
  function showMenu(axis, index, anchor) {
    closeMenu(); select(axis, index);
    menu = doc.createElement('div'); menu.className = 'table-axis-menu'; menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', `${axis === 'row' ? '行' : '列'}操作`);
    const table = locate(), count = axis === 'row' ? table.node.childCount : table.node.firstChild.childCount;
    const header = doc.createElement('button'), checked = tableHeaders(table.node.toJSON())[axis === 'row' ? 'row' : 'column']; header.type = 'button'; header.className = 'table-header-toggle'; header.dataset.tableCommand = 'toggle-header'; header.setAttribute('role', 'menuitemcheckbox'); header.setAttribute('aria-checked', String(checked)); header.title = axis === 'row' ? '将最上方一行设为标题行' : '将最左侧一列设为标题列'; header.innerHTML = `<span aria-hidden="true">H</span>${axis === 'row' ? '标题行' : '标题列'}<span class="table-header-check" aria-hidden="true">${checked ? '✓' : ''}</span>`;
    header.addEventListener('click', () => { const current = locate(); if (!current) return; replace(toggleTableHeader(current.node.toJSON(), axis)); closeMenu(); editor.view.focus(); select(axis, 0); }); menu.append(header, doc.createElement('hr'));
    const options = [['before', axis === 'row' ? '在上方插入' : '在左侧插入', '↑'], ['after', axis === 'row' ? '在下方插入' : '在右侧插入', '↓'], ['duplicate', '复制', '⧉'], ['clear', '清除内容', '×'], ['delete', '删除', '⌫']];
    for (const [action, label, symbol] of options) {
      const button = doc.createElement('button'); button.type = 'button'; button.dataset.tableCommand = action; button.setAttribute('role', 'menuitem'); button.innerHTML = `<span aria-hidden="true">${symbol}</span>${label}`;
      button.disabled = action === 'delete' && count <= 1;
      button.addEventListener('click', () => { const current = locate(); if (!current) return; replace(changeTableAxis(current.node.toJSON(), axis, index, action)); closeMenu(); const next = action === 'after' || action === 'duplicate' ? index + 1 : index; editor.view.focus(); select(axis, next); });
      menu.append(button);
    }
    doc.body.append(menu); const box = anchor.getBoundingClientRect(); menu.style.left = `${Math.max(12, Math.min(box.left, innerWidth - 210))}px`; menu.style.top = `${Math.max(12, Math.min(box.bottom + 6, innerHeight - (menu.scrollHeight || 270) - 12))}px`;
    menu.querySelector('button').focus({ preventScroll: true }); update();
  }
  function showResize(axis, delta) {
    const wanted = gesture.count + Math.round(delta / (axis === 'row' ? 30 : 42)), result = resizeTable(gesture.original, axis, wanted);
    if (JSON.stringify(result.table) !== JSON.stringify(locate()?.node.toJSON())) replace(result.table, false);
    gesture.final = result.table; note.hidden = false; note.textContent = `${result.count} ${axis === 'row' ? '行' : '列'}${result.blocked ? ' · 已到有内容的边界' : ''}`;
    const data = geometry(); note.style.left = `${Math.max(0, data.rect.right - data.parent.left - 170)}px`; note.style.top = `${data.rect.bottom - data.parent.top + 23}px`; overlay.dataset.blocked = String(result.blocked);
  }
  function down(event) {
    const button = event.target.closest?.('[data-table-edge],[data-table-axis]'); if (!button || !overlay.contains(button) || event.button > 0) return;
    event.preventDefault(); event.stopPropagation(); closeMenu();
    const table = locate(); if (!table) return;
    editor.view.dispatch(closeHistory(editor.state.tr));
    const axis = button.dataset.tableEdge || button.dataset.tableAxis, index = Number(button.dataset.index || 0), mode = button.dataset.tableEdge ? 'resize' : 'move';
    if (mode === 'move') select(axis, index);
    gesture = { axis, mode, index, button, pointer: event.pointerId, x: event.clientX, y: event.clientY, original: table.node.toJSON(), count: axis === 'row' ? table.node.childCount : table.node.firstChild.childCount, dragged: false, target: index };
    button.setPointerCapture?.(event.pointerId); update();
  }
  function move(event) {
    if (!gesture || gesture.pointer !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation(); const delta = gesture.axis === 'row' ? event.clientY - gesture.y : event.clientX - gesture.x;
    if (!gesture.dragged && Math.abs(delta) < 6) return; gesture.dragged = true;
    if (gesture.mode === 'resize') return showResize(gesture.axis, delta);
    const data = geometry(), cells = gesture.axis === 'row' ? data.rows : data.cols, coordinate = gesture.axis === 'row' ? event.clientY : event.clientX;
    let index = cells.findIndex(cell => { const box = cell.getBoundingClientRect(); return coordinate < (gesture.axis === 'row' ? box.top + box.height / 2 : box.left + box.width / 2); });
    if (index < 0) index = cells.length - 1;
    gesture.target = index; const box = cells[index].getBoundingClientRect(), marker = overlay.querySelector('.table-axis-drop'); marker.hidden = false;
    rectStyle(marker, gesture.axis === 'row' ? { left: data.rect.left, top: index > gesture.index ? box.bottom : box.top, width: data.rect.width, height: 2 } : { left: index > gesture.index ? box.right : box.left, top: data.rect.top, width: 2, height: data.rect.height }, data.parent);
  }
  function cleanupGesture() {
    const current = gesture; gesture = null;
    if (current?.button.hasPointerCapture?.(current.pointer)) current.button.releasePointerCapture(current.pointer);
    overlay.querySelector('.table-axis-drop').hidden = true; note.hidden = true; delete overlay.dataset.blocked; update(); return current;
  }
  function up(event) {
    if (!gesture || gesture.pointer !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation(); const current = cleanupGesture(); suppressClick = Date.now() + 350;
    if (current.mode === 'resize') {
      const final = current.dragged ? current.final || current.original : resizeTable(current.original, current.axis, current.count + 1).table;
      if (current.dragged) replace(current.original, false); replace(final); selected = null; update();
    } else if (current.dragged) { replace(changeTableAxis(current.original, current.axis, current.index, 'move', current.target)); select(current.axis, current.target); }
    else showMenu(current.axis, current.index, current.button);
    editor.view.dispatch(closeHistory(editor.state.tr));
  }
  function cancel(event) {
    if (gesture) { const current = cleanupGesture(); if (current.mode === 'resize') replace(current.original, false); suppressClick = Date.now() + 350; }
    if (event?.type === 'pointercancel') { selected = null; update(); }
  }
  function click(event) {
    const button = event.target.closest?.('[data-table-edge],[data-table-axis]'); if (!button || !overlay.contains(button)) return;
    event.preventDefault(); event.stopPropagation(); if (Date.now() < suppressClick) return;
    if (button.dataset.tableEdge) { const table = locate(), axis = button.dataset.tableEdge; replace(resizeTable(table.node.toJSON(), axis, (axis === 'row' ? table.node.childCount : table.node.firstChild.childCount) + 1).table); }
    else showMenu(button.dataset.tableAxis, Number(button.dataset.index || 0), button);
  }
  function hover(event) {
    if (gesture || menu) return; const cell = event.target.closest?.('td,th'); if (!cell || !host.contains(cell)) return;
    hovered = { row: cell.parentElement.rowIndex, column: cell.cellIndex }; update();
  }
  function outside(event) {
    if (overlay.contains(event.target) || menu?.contains(event.target)) return;
    if (menu || selected) { closeMenu(); selected = null; update(); }
  }
  function key(event) {
    if (event.key === 'Escape' && (gesture || menu || selected)) { event.preventDefault(); event.stopImmediatePropagation(); cancel(); closeMenu(); selected = null; update(); return; }
    if (menu && ['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); event.stopImmediatePropagation(); const buttons = [...menu.querySelectorAll('button:not(:disabled)')], index = buttons.indexOf(doc.activeElement); buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length].focus(); }
  }
  overlay.addEventListener('pointerdown', down); overlay.addEventListener('click', click); host.addEventListener('pointermove', hover);
  doc.addEventListener('pointermove', move, true); doc.addEventListener('pointerup', up, true); doc.addEventListener('pointercancel', cancel, true); doc.addEventListener('pointerdown', outside, true); doc.addEventListener('keydown', key, true); doc.addEventListener('scroll', schedule, true); window.addEventListener('resize', schedule);
  editor.on('transaction', schedule); update();
  return () => { destroyed = true; cancelAnimationFrame(frame); closeMenu(); overlay.remove(); editor.off('transaction', schedule); host.removeEventListener('pointermove', hover); doc.removeEventListener('pointermove', move, true); doc.removeEventListener('pointerup', up, true); doc.removeEventListener('pointercancel', cancel, true); doc.removeEventListener('pointerdown', outside, true); doc.removeEventListener('keydown', key, true); doc.removeEventListener('scroll', schedule, true); window.removeEventListener('resize', schedule); };
}
