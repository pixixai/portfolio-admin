const copy = value => JSON.parse(JSON.stringify(value));
const emptyContent = () => [{ type: 'paragraph' }];
export function cellHasContent(node) {
  if (node.type === 'text') return Boolean(node.text?.replace(/[\s\u200b]/g, ''));
  if (node.type === 'hardBreak') return false;
  if (node.content) return node.content.some(cellHasContent);
  return !['paragraph', 'tableCell', 'tableHeader'].includes(node.type);
}
const emptyCell = template => ({ type: template?.type || 'tableCell', attrs: { ...(template?.attrs || {}), colspan: 1, rowspan: 1, colwidth: null }, content: emptyContent() });
export function tableHeaders(table) {
  const rows = table.content || [];
  return { row: table.attrs?.headerRow ?? Boolean(rows[0]?.content?.length && rows[0].content.every(cell => cell.type === 'tableHeader')), column: table.attrs?.headerColumn ?? (rows.length > 1 && rows.slice(1).every(row => row.content?.[0]?.type === 'tableHeader')) };
}
export function setTableHeaders(table, headers) {
  const result = copy(table); result.attrs = { ...result.attrs, headerRow: headers.row, headerColumn: headers.column };
  (result.content || []).forEach((row, r) => (row.content || []).forEach((cell, c) => { cell.type = (headers.row && r === 0) || (headers.column && c === 0) ? 'tableHeader' : 'tableCell'; }));
  return result;
}
export function toggleTableHeader(table, axis) {
  const headers = tableHeaders(table), key = axis === 'row' ? 'row' : 'column'; headers[key] = !headers[key]; return setTableHeaders(table, headers);
}
function finish(table, rows) {
  return setTableHeaders({ ...copy(table), content: rows }, tableHeaders(table));
}
export function resizeTable(table, axis, requested) {
  const rows = copy(table.content), limit = axis === 'row' ? 100 : 40;
  const wanted = Math.max(1, Math.min(limit, requested));
  let blocked = false;
  if (axis === 'row') {
    while (rows.length > wanted) {
      if (rows.at(-1).content.some(cellHasContent)) { blocked = true; break; }
      rows.pop();
    }
    while (rows.length < wanted) rows.push({ type: 'tableRow', content: rows.at(-1).content.map(emptyCell) });
  } else {
    while (rows[0].content.length > wanted) {
      if (rows.some(row => cellHasContent(row.content.at(-1)))) { blocked = true; break; }
      rows.forEach(row => row.content.pop());
    }
    while (rows[0].content.length < wanted) rows.forEach(row => row.content.push(emptyCell(row.content.at(-1))));
  }
  return { table: finish(table, rows), blocked, count: axis === 'row' ? rows.length : rows[0].content.length };
}
export function changeTableAxis(table, axis, index, action, target) {
  const rows = copy(table.content), count = axis === 'row' ? rows.length : rows[0].content.length;
  if (index < 0 || index >= count) return table;
  const apply = (items, makeEmpty) => {
    if (action === 'before' || action === 'after') items.splice(index + (action === 'after' ? 1 : 0), 0, makeEmpty(items[index]));
    if (action === 'duplicate') items.splice(index + 1, 0, copy(items[index]));
    if (action === 'delete' && items.length > 1) items.splice(index, 1);
    if (action === 'move' && target >= 0 && target < count && target !== index) items.splice(target, 0, items.splice(index, 1)[0]);
  };
  if (action === 'clear') {
    if (axis === 'row') rows[index].content.forEach(cell => { cell.content = emptyContent(); });
    else rows.forEach(row => { row.content[index].content = emptyContent(); });
  } else if (axis === 'row') apply(rows, row => ({ type: 'tableRow', content: row.content.map(emptyCell) }));
  else rows.forEach(row => apply(row.content, emptyCell));
  return finish(table, rows);
}
