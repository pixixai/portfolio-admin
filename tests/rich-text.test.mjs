import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Window } from 'happy-dom';
import { fileURLToPath } from 'node:url';
import { markdown, renderBody } from '../renderer/scripts/content.mjs';
import { resizeTable, changeTableAxis, cellHasContent, toggleTableHeader, tableHeaders } from '../src/table-model.js';
import { serializeProjectBlocks } from '../lib/blocks.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = await readFile(path.join(root, 'public/rich-text.bundle.js'), 'utf8');

test('所有类型缩进安全展示，单独缩进的列表不变成代码，连续层级保留嵌套', () => {
  const render = blocks => markdown.render(serializeProjectBlocks({ title: '缩进', blocks }, new Map([['image', 'images/one.png']])));
  let html = render([{ type: 'text', text: '普通**文字**', indent: 2 }, { type: 'text', text: '# 标题', indent: 1 }, { type: 'image', assetId: 'image', indent: 1 }]);
  assert.ok(html.includes('<strong>文字</strong>')); assert.ok(html.includes('<h1>标题</h1>')); assert.ok(html.includes('margin-left:48px')); assert.ok(html.includes('images/one.png')); assert.ok(!html.includes('<pre>'));
  html = render([{ type: 'text', text: '- 父项', indent: 2 }, { type: 'text', text: '- 子项', indent: 3 }]);
  assert.ok(html.includes('margin-left:48px')); assert.equal((html.match(/<ul>/g) || []).length, 2); assert.ok(!html.includes('<pre>'));
  html = render([{ type: 'text', text: '1. 独立编号', indent: 4 }, { type: 'text', text: '2. 回到左侧', indent: 0 }]);
  assert.ok(html.includes('margin-left:96px')); assert.ok(html.includes('<ol start="2">')); assert.ok(!html.includes('<pre>'));
  assert.ok(!markdown.render('<!-- portfolio-indent level=99 -->\n文字\n<!-- /portfolio-indent -->').includes('style="margin-left:'));
});

async function fixture(t, platform = 'Win32', splitLists = false) {
  const window = new Window({ url: 'http://127.0.0.1:4180/' });
  Object.defineProperty(window.navigator, 'platform', { value: platform });
  window.document.body.innerHTML = '<article data-block="one"><div class="rich-block-host" data-block-id="one"></div><textarea data-block-field="text" aria-label="测试文字块"></textarea></article>';
  window.eval(bundle);
  const events = [], api = window.PortfolioRichText;
  api.mountAll({ root: window.document.body, onSelect: value => events.push(['select', value]), onEnter: (...value) => events.push(['enter', ...value]), onExit: id => events.push(['exit', id]), onSlash: id => events.push(['slash', id]), onBackspace: () => false, ...(splitLists ? { onListSplit: (...values) => events.push(['listSplit', ...values]) } : {}) });
  const editor = api.get('one');
  t.after(async () => { api.destroyAll(); await window.happyDOM.abort(); });
  function type(value) {
    for (const char of value) {
      const { from, to } = editor.state.selection; let handled = false;
      editor.view.someProp('handleTextInput', handler => { if (handler(editor.view, from, to, char)) { handled = true; return true; } });
      if (!handled) editor.view.dispatch(editor.state.tr.insertText(char, from, to));
    }
  }
  const reset = (value = '') => { editor.commands.setContent(value, { contentType: 'markdown' }); editor.commands.focus('end', { scrollIntoView: false }); };
  const key = (name, modifiers = {}) => { const event = new window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...modifiers }); editor.view.dom.dispatchEvent(event); return event; };
  return { window, api, editor, type, reset, key, events, source: window.document.querySelector('textarea') };
}

test('富文本输入规则实际转换为标题、列表、待办、分割线和代码块', async t => {
  const f = await fixture(t);
  for (const [syntax, selector] of [['# ', 'h1'], ['## ', 'h2'], ['### ', 'h3'], ['- ', 'ul'], ['* ', 'ul'], ['+ ', 'ul'], ['1. ', 'ol'], ['. ', 'ol'], ['[]', '[data-type=taskList]'], ['[ ] ', '[data-type=taskList]'], ['---', 'hr'], ['—-', 'hr'], ['```', 'pre']]) {
    f.reset(); f.type(syntax); assert.ok(f.editor.view.dom.querySelector(selector), `${JSON.stringify(syntax)} → ${selector}`);
  }
  f.reset(); f.type('[]待办内容'); const checkbox = f.editor.view.dom.querySelector('input[type=checkbox]'); assert.ok(checkbox); assert.equal(checkbox.checked, false);
  checkbox.click(); assert.ok(f.editor.getMarkdown().includes('[x]')); assert.equal(f.editor.view.dom.querySelector('li').dataset.checked, 'true');
});

test('结束标记后自动应用行内样式，快捷键支持加粗、斜体和下划线', async t => {
  const f = await fixture(t);
  for (const [syntax, selector, expected] of [['**加粗**', 'strong', '加粗'], ['*斜体*', 'em', '斜体'], ['_倾斜_', 'em', '倾斜'], ['`代码`', 'code', '代码'], ['~删除~', 's', '删除'], ['~~删除~~', 's', '删除']]) {
    f.reset(); f.type(syntax); assert.equal(f.editor.view.dom.querySelector(selector)?.textContent, expected, syntax); assert.ok(!f.editor.view.dom.textContent.includes(syntax));
  }
  for (const [key, selector] of [['b', 'strong'], ['i', 'em'], ['u', 'u']]) {
    f.reset('快捷键文字'); f.editor.commands.setTextSelection({ from: 1, to: 6 }); f.key(key, { ctrlKey: true }); assert.ok(f.editor.view.dom.querySelector(selector), `Ctrl+${key}`);
  }
  const saved = f.editor.getMarkdown(); assert.ok(saved.includes('++')); f.reset(saved); assert.ok(f.editor.view.dom.querySelector('u'), '下划线保存重载');
});

test('列表延续、Tab嵌套与取消嵌套、块分段和格式化光标切分', async t => {
  const f = await fixture(t);
  f.reset(); f.type('- 第一项'); f.key('Enter'); f.type('第二项');
  assert.equal(f.editor.view.dom.querySelectorAll('li').length, 2);
  f.key('Tab'); assert.ok(f.editor.view.dom.querySelector('li ul li')); assert.ok(f.editor.getMarkdown().includes('  - 第二项'));
  f.key('Tab', { shiftKey: true }); assert.equal(f.editor.view.dom.querySelector('li ul'), null);
  f.reset('左**粗体**右'); f.editor.commands.setTextSelection(3); const split = f.api.split({ id: 'one', from: 3, to: 3 });
  assert.ok(split.left.includes('**粗**')); assert.ok(split.right.includes('**体**'));
  f.key('Enter'); assert.ok(f.events.some(event => event[0] === 'enter'));
  f.reset(); f.key('/'); assert.ok(f.events.some(event => event[0] === 'slash'));
  f.reset('块内'); f.key('Enter', { shiftKey: true }); assert.ok(f.editor.getJSON().content[0].content.some(node => node.type === 'hardBreak'));
});

test('展示渲染保留待办、删除线、下划线、行内代码并转义原始HTML', () => {
  const body = '- [x] 已完成\n- [ ] 继续\n\n++下划线++ ~删除线~ **加粗** *斜体* `代码`\n\n<script>bad()</script>';
  const project = { title: '格式检查', tokens: markdown.parse(body, {}), images: [], media: [] };
  const html = renderBody(project, '');
  assert.ok(html.includes('type="checkbox"')); assert.ok(html.includes('checked=""')); assert.ok(html.includes('<u>下划线</u>')); assert.ok(html.includes('<s>删除线</s>')); assert.ok(html.includes('<strong>加粗</strong>')); assert.ok(html.includes('<code>代码</code>')); assert.ok(!html.includes('<script>'));
});

test('Mac快捷键和六点按钮按首行定位，不随整段高度下移', async t => {
  const f = await fixture(t, 'MacIntel');
  for (const [key, selector] of [['b', 'strong'], ['i', 'em'], ['u', 'u']]) {
    f.reset('格式'); f.editor.commands.setTextSelection({ from: 1, to: 3 }); f.key(key, { metaKey: true }); assert.ok(f.editor.view.dom.querySelector(selector), `Cmd+${key}`);
  }
  f.reset('第一行\n第二行\n第三行');
  const article = f.window.document.querySelector('article'), p = f.editor.view.dom.querySelector('p');
  article.getBoundingClientRect = () => ({ top: 100 }); p.getBoundingClientRect = () => ({ top: 104, height: 112 }); p.style.lineHeight = '28px';
  f.type('末尾'); await new Promise(resolve => f.window.requestAnimationFrame(resolve));
  assert.equal(article.style.getPropertyValue('--grip-top'), '18px');
  p.getBoundingClientRect = () => ({ top: 104, height: 280 }); f.type('更多行'); await new Promise(resolve => f.window.requestAnimationFrame(resolve));
  assert.equal(article.style.getPropertyValue('--grip-top'), '18px');
});

test('列表回车产生独立块数据，连续编号、待办状态、旧嵌套内容和行内格式保留', async t => {
  const f = await fixture(t, 'Win32', true);
  f.type('1. **左边右边**'); f.editor.commands.setTextSelection(5); f.key('Enter');
  let split = f.events.filter(event => event[0] === 'listSplit').at(-1);
  assert.equal(split[2].length, 2); assert.equal(split[2][0].text, '1. **左边**'); assert.equal(split[2][1].text, '2. **右边**'); assert.equal(split[3], 1);
  f.reset('- [x] 任务'); f.key('Enter'); split = f.events.filter(event => event[0] === 'listSplit').at(-1);
  assert.ok(split[2][0].text.includes('[x]')); assert.ok(split[2][1].text.includes('[ ]'));
  f.reset(); f.type('- '); f.key('Enter'); split = f.events.filter(event => event[0] === 'listSplit').at(-1); assert.equal(split[2].length, 1, JSON.stringify(split)); assert.equal(split[2][0].text, '');
  f.reset('- 父级\n  - 子级'); f.key('Enter'); split = f.events.filter(event => event[0] === 'listSplit').at(-1);
  assert.ok(split[2].some(part => part.text.includes('父级'))); assert.ok(split[2].some(part => part.text.includes('子级') && part.indent === 1));
});

test('表格节点可直接编辑、增加删除行列，Markdown重载与展示渲染保留表格', async t => {
  const f = await fixture(t);
  f.reset('| 名称 | 说明 |\n| --- | --- |\n| 品牌 | 视觉 |');
  assert.equal(f.editor.view.dom.querySelectorAll('tr').length, 2);
  f.editor.commands.focus('start', { scrollIntoView: false });
  assert.equal(f.api.tableCommand('one', 'addRowAfter'), true); assert.equal(f.editor.view.dom.querySelectorAll('tr').length, 3);
  assert.equal(f.api.tableCommand('one', 'addColumnAfter'), true); assert.equal(f.editor.view.dom.querySelector('tr').children.length, 3);
  assert.equal(f.api.tableCommand('one', 'deleteColumn'), true); assert.equal(f.editor.view.dom.querySelector('tr').children.length, 2);
  assert.equal(f.api.tableCommand('one', 'deleteRow'), true); assert.equal(f.editor.view.dom.querySelectorAll('tr').length, 2);
  f.type('内容'); const saved = f.editor.getMarkdown(); f.reset(saved); assert.ok(f.editor.view.dom.querySelector('table').textContent.includes('内容'));
  const html = renderBody({ title: '表格', tokens: markdown.parse(saved, {}), images: [], media: [] }, ''); assert.ok(html.includes('<table>')); assert.ok(html.includes('<td>'));
  const breaks = renderBody({ title: '换行', tokens: markdown.parse('| 列 |\n| --- |\n| 前<br>后<script>bad()</script> |', {}), images: [], media: [] }, '');
  assert.ok(breaks.includes('前<br>\n后')); assert.ok(!breaks.includes('<script>')); assert.ok(breaks.includes('&lt;script&gt;'));
});

test('表格边缘批量缩减保护每个非空单元格；复制、清空、重排保留原始格式', async t => {
  const f = await fixture(t); f.reset('| A |  |  |\n| --- | --- | --- |\n| **甲** | 乙 |  |\n|  |  |  |');
  const original = f.editor.getJSON().content[0];
  let result = resizeTable(original, 'row', 1); assert.equal(result.count, 2); assert.equal(result.blocked, true);
  result = resizeTable(original, 'column', 1); assert.equal(result.count, 2); assert.equal(result.blocked, true); assert.equal(result.table.content[1].content[1].content[0].content[0].text, '乙');
  const expanded = resizeTable(original, 'column', 6).table; assert.equal(expanded.content[0].content.length, 6); assert.deepEqual(resizeTable(expanded, 'column', 1).table, resizeTable(original, 'column', 1).table);
  const duplicated = changeTableAxis(original, 'row', 1, 'duplicate'); assert.deepEqual(duplicated.content[1], duplicated.content[2]); assert.equal(duplicated.content[1].content[0].content[0].content[0].marks[0].type, 'bold');
  const cleared = changeTableAxis(duplicated, 'row', 2, 'clear'); assert.equal(cleared.content[2].content.some(cellHasContent), false); assert.equal(cleared.content[1].content.some(cellHasContent), true);
  const moved = changeTableAxis(original, 'row', 1, 'move', 0); assert.equal(moved.content[0].content[0].type, 'tableHeader'); assert.equal(moved.content[0].content[0].content[0].content[0].text, '甲');
  assert.ok(cellHasContent({ type: 'image' })); assert.equal(cellHasContent({ type: 'paragraph', content: [{ type: 'text', text: '  \u200b' }] }), false);
});

test('表格边缘加号和拖拽增减、非空边界、撤销与取消、行列手柄菜单和排序', async t => {
  const f = await fixture(t), doc = f.window.document;
  f.reset('| A |  |  |\n| --- | --- | --- |\n| 甲 | 乙 |  |\n|  |  |  |');
  const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
  const old = f.window.HTMLElement.prototype.getBoundingClientRect;
  f.window.HTMLElement.prototype.getBoundingClientRect = function () {
    const table = this.closest('table') || this.querySelector('table'), rows = table?.rows.length || 3, cols = table?.rows[0]?.cells.length || 3;
    if (this.tagName === 'TABLE') return rect(100, 100, cols * 100, rows * 40);
    if (this.tagName === 'TR') return rect(100, 100 + this.rowIndex * 40, cols * 100, 40);
    if (['TD','TH'].includes(this.tagName)) return rect(100 + this.cellIndex * 100, 100 + this.parentElement.rowIndex * 40, 100, 40);
    if (this.matches('article,.rich-block-host')) return rect(100, 100, cols * 100, rows * 40);
    return old.call(this);
  };
  t.after(() => { f.window.HTMLElement.prototype.getBoundingClientRect = old; });
  await new Promise(resolve => f.window.requestAnimationFrame(resolve));
  const $ = selector => doc.querySelector(selector), table = () => $('.rich-editor table'), edge = axis => $(`[data-table-edge=${axis}]`), handle = axis => $(`[data-table-axis=${axis}]`);
  const pointer = (node, type, x, y) => node.dispatchEvent(new f.window.PointerEvent(type, { pointerId: 21, pointerType: 'mouse', button: 0, bubbles: true, cancelable: true, clientX: x, clientY: y }));
  const drag = (node, x, y, toX, toY, cancel = false) => { pointer(node, 'pointerdown', x, y); pointer(node, 'pointermove', toX, toY); if (cancel) doc.dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); else pointer(node, 'pointerup', toX, toY); };
  const tap = node => { pointer(node, 'pointerdown', 100, 100); pointer(node, 'pointerup', 100, 100); };
  assert.equal($('.table-controls'), null); assert.ok(edge('row')); edge('row').click(); assert.equal(table().rows.length, 4);
  drag(edge('row'), 150, 260, 150, 350); assert.equal(table().rows.length, 7); f.editor.commands.undo(); assert.equal(table().rows.length, 4, '整个批量手势一步撤销');
  drag(edge('row'), 150, 260, 150, 0); assert.equal(table().rows.length, 2); assert.ok(table().textContent.includes('乙'));
  drag(edge('column'), 400, 130, 0, 130); assert.equal(table().rows[0].cells.length, 2); assert.ok(table().textContent.includes('乙'));
  const saved = f.editor.getMarkdown(); drag(edge('column'), 300, 130, 468, 130, true); assert.equal(f.editor.getMarkdown(), saved); assert.equal($('.table-resize-note').hidden, true);
  pointer(table().rows[1].cells[1], 'pointermove', 250, 160); assert.equal(handle('row').dataset.index, '1'); assert.equal(handle('column').dataset.index, '1');
  tap(handle('column')); assert.ok($('.table-axis-menu')); assert.equal($('.table-axis-selection').hidden, false);
  $('[data-table-command=duplicate]').click(); assert.equal(table().rows[0].cells.length, 3); assert.equal(table().rows[1].cells[2].textContent, '乙');
  pointer(table().rows[1].cells[2], 'pointermove', 350, 160); tap(handle('column')); $('[data-table-command=clear]').click(); assert.equal(table().rows[1].cells[2].textContent, '');
  tap(handle('column')); $('[data-table-command=delete]').click(); assert.equal(table().rows[0].cells.length, 2);
  pointer(table().rows[1].cells[1], 'pointermove', 250, 160); tap(handle('row')); assert.ok($('.table-axis-menu').textContent.includes('在上方插入')); $('[data-table-command=duplicate]').click(); assert.equal(table().rows.length, 3);
  pointer(table().rows[2].cells[0], 'pointermove', 150, 200); drag(handle('row'), 85, 200, 85, 102); assert.ok(table().rows[0].cells[0].textContent.includes('甲')); assert.equal($('.table-axis-menu'), null);
  pointer(table().rows[1].cells[1], 'pointermove', 250, 160); drag(handle('column'), 250, 82, 105, 82); assert.ok(table().rows[0].cells[0].textContent.includes('乙'));
  tap(handle('column')); $('[data-table-command=before]').click(); assert.equal(table().rows[0].cells.length, 3); assert.equal(table().rows[0].cells[0].textContent, '');
  tap(handle('row')); $('[data-table-command=after]').click(); assert.equal(table().rows.length, 4);
});

test('实际待办DOM的复选框与正文采用同行布局，回车数据为独立且未选中的新待办', async t => {
  const f = await fixture(t, 'Win32', true), style = f.window.document.createElement('style'); style.textContent = await readFile(path.join(root, 'public/style.css'), 'utf8'); f.window.document.head.append(style);
  f.type('[]待办内容'); const li = f.editor.view.dom.querySelector('li');
  assert.equal(li.getAttribute('data-type'), null, '检查真实节点，不依赖不存在的taskItem属性');
  assert.equal(f.window.getComputedStyle(li).display, 'flex'); assert.equal(f.window.getComputedStyle(li).flexDirection, 'row'); assert.equal(li.querySelector('label').nextElementSibling.textContent, '待办内容');
  f.key('Enter'); const result = f.events.filter(event => event[0] === 'listSplit').at(-1); assert.equal(result[2].length, 2); assert.ok(result[2][1].text.includes('[ ]')); assert.equal(result[3], 1);
});

test('代码复制按钮只复制代码正文，保留空格换行，失败时使用本地回退且不修改文档', async t => {
  const f = await fixture(t), copied = [];
  Object.defineProperty(f.window.navigator, 'clipboard', { configurable: true, value: { writeText: async value => copied.push(value) } });
  f.reset('```js\nconst value = 1;\n  console.log(value);\n```\n\n```\n第二段\n```');
  await new Promise(resolve => f.window.requestAnimationFrame(resolve));
  const before = f.editor.getMarkdown(), buttons = [...f.window.document.querySelectorAll('.code-copy-button')]; assert.equal(buttons.length, 2);
  buttons[0].click(); await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(copied[0], 'const value = 1;\n  console.log(value);'); assert.equal(buttons[0].dataset.copied, 'true'); assert.equal(f.editor.getMarkdown(), before);
  Object.defineProperty(f.window.navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('test denied'); } } });
  f.window.document.execCommand = command => { assert.equal(command, 'copy'); copied.push(f.window.document.activeElement.value); return true; };
  buttons[1].click(); await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(copied.at(-1), '第二段'); assert.equal(f.editor.getMarkdown(), before);
});

test('表格四种标题设置保存重开及展示均保持3×3，不增加表头、不填入列名', async t => {
  const f = await fixture(t), body = '| **甲** | 乙 | 丙 |\n| --- | --- | --- |\n| 丁 | 戊 | 己 |\n| 庚 | 辛 | 壬 |';
  for (const [row, column] of [[false,false],[true,false],[false,true],[true,true]]) {
    f.reset(`<!-- portfolio-table row=${Number(row)} column=${Number(column)} -->\n${body}`);
    const table = f.editor.view.dom.querySelector('table'), count = Number(row) * 3 + Number(column) * 3 - Number(row && column);
    assert.equal(table.rows.length, 3); assert.equal(table.querySelectorAll('td,th').length, 9); assert.equal(table.querySelectorAll('th').length, count); assert.ok(table.querySelector('strong'));
    const saved = f.editor.getMarkdown(); f.reset(saved); assert.equal(f.editor.view.dom.querySelectorAll('tr').length, 3); assert.equal(f.editor.view.dom.querySelectorAll('th').length, count); assert.equal(f.editor.view.dom.querySelector('table').textContent, '甲乙丙丁戊己庚辛壬');
    const html = renderBody({ title: '标题设置', tokens: markdown.parse(saved, {}), images: [], media: [] }, '');
    assert.equal((html.match(/<tr>/g) || []).length, 3); assert.equal((html.match(/<th(?:\s|>)/g) || []).length, count); assert.ok(!html.includes('portfolio-table')); assert.ok(html.includes('<strong>甲</strong>'));
    if (column) assert.ok(html.includes('scope="row"')); if (row) assert.ok(html.includes('scope="col"'));
  }
  f.reset('<!-- portfolio-table row=0 column=0 -->\n|  |  |  |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |');
  assert.equal(f.editor.view.dom.querySelectorAll('tr').length, 3); assert.equal(f.editor.view.dom.querySelectorAll('th').length, 0); assert.equal(f.editor.view.dom.textContent, '');
  const original = f.editor.getJSON().content[0], resized = resizeTable(original, 'row', 4).table; assert.deepEqual(tableHeaders(resized), { row: false, column: false }); assert.ok(resized.content.every(row => row.content.every(cell => cell.type === 'tableCell')));
  const title = toggleTableHeader(original, 'column'); assert.deepEqual(tableHeaders(title), { row: false, column: true }); assert.ok(title.content.every(row => row.content[0].type === 'tableHeader')); assert.ok(!title.content.some(cellHasContent));
});

test('行列菜单顶部开关只改变首行或首列，保留原文字并可关闭', async t => {
  const f = await fixture(t), doc = f.window.document;
  f.reset('<!-- portfolio-table row=0 column=0 -->\n| 甲 | 乙 | 丙 |\n| --- | --- | --- |\n| 丁 | 戊 | 己 |\n| 庚 | 辛 | 壬 |'); await new Promise(resolve => f.window.requestAnimationFrame(resolve));
  const open = axis => { doc.querySelector(`[data-table-axis=${axis}]`).click(); return doc.querySelector('.table-axis-menu button'); };
  let header = open('row'); assert.equal(header.dataset.tableCommand, 'toggle-header'); assert.ok(header.textContent.includes('标题行')); assert.equal(header.getAttribute('aria-checked'), 'false'); header.click();
  assert.equal(f.editor.view.dom.querySelectorAll('th').length, 3); assert.equal(f.editor.view.dom.querySelectorAll('tr').length, 3);
  header = open('column'); assert.ok(header.textContent.includes('标题列')); header.click(); assert.equal(f.editor.view.dom.querySelectorAll('th').length, 5);
  header = open('row'); assert.equal(header.getAttribute('aria-checked'), 'true'); header.click(); assert.equal(f.editor.view.dom.querySelectorAll('th').length, 3);
  assert.ok([...f.editor.view.dom.querySelectorAll('tr')].every(row => row.cells[0].tagName === 'TH' && row.cells[1].tagName === 'TD')); assert.equal(f.editor.view.dom.querySelector('table').textContent, '甲乙丙丁戊己庚辛壬');
  f.reset(f.editor.getMarkdown()); assert.deepEqual(tableHeaders(f.editor.getJSON().content[0]), { row: false, column: true });
  open('column').click(); assert.equal(f.editor.view.dom.querySelectorAll('th').length, 0); assert.equal(f.editor.view.dom.querySelector('table').textContent, '甲乙丙丁戊己庚辛壬');
});
