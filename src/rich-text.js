import { Editor, Extension, InputRule, markInputRule, wrappingInputRule, textblockTypeInputRule } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import { attachTableUI } from './table-ui.js';
import { attachCodeUI } from './code-ui.js';
import { PortfolioTable } from './table-extension.js';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { Slice } from '@tiptap/pm/model';

const documentSelectionKey = new PluginKey('portfolioDocumentSelection');
const documentSelection = Extension.create({
  name: 'portfolioDocumentSelection',
  addProseMirrorPlugins() { return [new Plugin({ key: documentSelectionKey,
    state: { init: () => null, apply: (tr, value) => tr.getMeta(documentSelectionKey) !== undefined ? tr.getMeta(documentSelectionKey) : value },
    props: { decorations(state) {
      const range = documentSelectionKey.getState(state); if (!range) return null;
      const decorations = []; state.doc.nodesBetween(range.from, range.to, (node, pos) => {
        if (node.isText) decorations.push(Decoration.inline(Math.max(pos, range.from), Math.min(pos + node.nodeSize, range.to), { class: 'document-text-selection' }));
      });
      return DecorationSet.create(state.doc, decorations);
    } },
  })]; },
});

const editors = new Map();
const shortcutExtension = Extension.create({
  name: 'portfolioShortcuts',
  addInputRules() {
    return [
      markInputRule({ find: /(?:^|\s)(~([^~\n]+)~)$/, type: this.editor.schema.marks.strike }),
      markInputRule({ find: /(?:^|\s)(\+\+([^+\n]+)\+\+)$/, type: this.editor.schema.marks.underline }),
      wrappingInputRule({ find: /^\.\s$/, type: this.editor.schema.nodes.orderedList }),
      textblockTypeInputRule({ find: /^```$/, type: this.editor.schema.nodes.codeBlock }),
      new InputRule({ find: /^(?:—-|——|───)$/, handler: ({ chain, range }) => { chain().deleteRange(range).setHorizontalRule().run(); } }),
    ];
  },
});
const tasks = TaskItem.extend({
  addInputRules() {
    return [...(this.parent?.() || []), wrappingInputRule({ find: /^\s*\[( |x|X)?\]$/, type: this.type, getAttributes: match => ({ checked: /x/i.test(match[1] || '') }) })];
  },
});
function extensions() {
  return [StarterKit.configure({ heading: { levels: [1, 2, 3] }, trailingNode: false, link: { openOnClick: false } }), TaskList, tasks.configure({ nested: true }), TableKit.configure({ table: false }), PortfolioTable.configure({ resizable: false }), Markdown.configure({ markedOptions: { gfm: true, breaks: true } }), shortcutExtension, documentSelection];
}
const listTypes = new Set(['bulletList', 'orderedList', 'taskList']);
function emptyMarkdown(value) {
  const paragraph = { type: 'paragraph' }; let node;
  if (/^[-*+]\s+$/.test(value)) node = { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph] }] };
  const ordered = value.match(/^(\d+)\.\s+$/);
  if (ordered) node = { type: 'orderedList', attrs: { start: Number(ordered[1]) }, content: [{ type: 'listItem', content: [paragraph] }] };
  const task = value.match(/^[-*+] \[([ xX])\]\s*$/);
  if (task) node = { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: /x/i.test(task[1]) }, content: [paragraph] }] };
  const heading = value.match(/^(#{1,3})\s+$/);
  if (heading) node = { type: 'heading', attrs: { level: heading[1].length } };
  return node ? { type: 'doc', content: [node] } : null;
}
// Each list item becomes one independently draggable document block. Legacy
// grouped/nested lists are expanded without dropping their text or marks.
function listParts(instance) {
  const { $from } = instance.state.selection; let selectedItem;
  for (let depth = $from.depth; depth > 0; depth--) if (['listItem', 'taskItem'].includes($from.node(depth).type.name)) { selectedItem = $from.node(depth); break; }
  const parts = []; let focusIndex = 0;
  const serialize = node => instance.markdown.serialize({ type: 'doc', content: [node] });
  const walk = (node, indent = 0) => {
    if (!listTypes.has(node.type.name)) { if (node === $from.node(1)) focusIndex = parts.length; parts.push({ text: serialize(node.toJSON()), indent: 0 }); return; }
    node.forEach((item, offset, index) => {
      const json = item.toJSON(), nested = []; json.content = [];
      item.forEach(child => listTypes.has(child.type.name) ? nested.push(child) : json.content.push(child.toJSON()));
      if (item === selectedItem) focusIndex = parts.length;
      const attrs = { ...node.attrs }; if (node.type.name === 'orderedList') attrs.start = (attrs.start || 1) + index;
      parts.push({ text: serialize({ type: node.type.name, attrs, content: [json] }), indent });
      nested.forEach(child => walk(child, indent + 1));
    });
  };
  instance.state.doc.forEach(node => walk(node)); return { parts, focusIndex };
}
function slice(instance, from, to = instance.state.doc.content.size) {
  if (from >= to) return '';
  return instance.markdown.serialize(instance.state.doc.cut(from, to).toJSON());
}
function context(id, instance) {
  const { from, to } = instance.state.selection;
  return { id, rich: true, from, to, start: slice(instance, 0, from).length, end: slice(instance, 0, to).length };
}
function updateGrip(host) {
  const article = host.closest('[data-block]'); if (!article) return;
  const first = host.querySelector('li p,h1,h2,h3,p,pre,blockquote,hr');
  if (!first) return;
  const root = article.getBoundingClientRect(), rect = first.getBoundingClientRect(), css = getComputedStyle(first);
  const line = parseFloat(css.lineHeight) || 28, padding = parseFloat(css.paddingTop) || 0;
  const top = first.tagName === 'HR' ? rect.top - root.top + Math.max(1, rect.height / 2) : rect.top - root.top + padding + line / 2;
  article.style.setProperty('--grip-top', `${Math.max(12, top)}px`);
}
export function destroyAll() { for (const item of editors.values()) { item.disposeTable?.(); item.disposeCode?.(); item.instance.destroy(); } editors.clear(); }
export function get(id) { return editors.get(id)?.instance; }
export function tableCommand(id, command) {
  const instance = get(id); if (!instance || !['addRowAfter', 'addColumnAfter', 'deleteRow', 'deleteColumn'].includes(command)) return false;
  return instance.chain().focus(undefined, { scrollIntoView: false })[command]().run();
}
export function selected() { for (const [id, { instance }] of editors) if (instance.isFocused) return context(id, instance); return null; }
export function split(saved) { const instance = get(saved.id); if (!instance) return null; return { left: slice(instance, 0, saved.from), right: slice(instance, saved.to) }; }
export function bounds(id) {
  const instance = get(id); if (!instance) return null;
  let first, last; instance.state.doc.descendants((node, pos) => { if (node.isTextblock) { first ??= pos + 1; last = pos + node.nodeSize - 1; } });
  return { from: first ?? 0, to: last ?? instance.state.doc.content.size, size: instance.state.doc.content.size };
}
export function point(id, x, y) {
  const instance = get(id); if (!instance) return null;
  try { const hit = instance.view.posAtCoords({ left: x, top: y }); if (hit) return { id, pos: hit.pos }; } catch {}
  const range = bounds(id), rect = instance.view.dom.getBoundingClientRect(); return { id, pos: y < rect.top || x < rect.left ? range.from : range.to };
}
export function highlight(id, range) { const instance = get(id); if (instance) instance.view.dispatch(instance.state.tr.setMeta(documentSelectionKey, range)); }
export function rangeText(id, from = 0, to = get(id)?.state.doc.content.size) { const instance = get(id); return instance ? instance.state.doc.textBetween(from, to, '\n') : ''; }
export function rangeMarkdown(id, from = 0, to = get(id)?.state.doc.content.size) { const instance = get(id); return instance ? slice(instance, from, to) : ''; }
export function mergeRange(start, end, value = '') {
  const first = get(start.id), last = get(end.id); if (!first) return null;
  const tr = first.state.tr, from = start.pos ?? 0;
  tr.deleteRange(from, first.state.doc.content.size);
  const position = Math.min(from, tr.doc.content.size - 1);
  if (last && end.pos != null) tr.replaceRange(position, position, Slice.fromJSON(first.schema, last.state.doc.slice(end.pos, last.state.doc.content.size).toJSON()));
  if (value) tr.insertText(value, Math.max(1, position));
  return { value: first.markdown.serialize(tr.doc.toJSON()), position: Math.max(1, position) + value.length };
}
export function convertText(id, format) {
  const instance = get(id); if (!instance) return null;
  const plain = instance.state.doc.textBetween(0, instance.state.doc.content.size, '\n');
  if (format === 'rule' || format === 'code') return { value: format === 'rule' ? '---' : '```\n' + plain + '\n```', leftover: format === 'rule' && plain ? instance.getMarkdown() : '' };
  const emptyFormats = { text: '', h1: '# ', h2: '## ', h3: '### ', list: '- ', ordered: '1. ', task: '- [ ] ', quote: '> ' };
  if (!plain && Object.hasOwn(emptyFormats, format)) return { value: emptyFormats[format], leftover: '' };
  const nodes = [], level = Number(format.slice(1)), wrapper = { list: 'bulletList', ordered: 'orderedList', task: 'taskList', quote: 'blockquote' }[format];
  instance.state.doc.descendants(node => { if (node.isTextblock) nodes.push({ type: ['h1','h2','h3'].includes(format) ? 'heading' : 'paragraph', ...(['h1','h2','h3'].includes(format) ? { attrs: { level } } : {}), ...(node.content.size ? { content: node.toJSON().content } : {}) }); });
  if (!nodes.length) nodes.push({ type: 'paragraph' });
  let content = nodes;
  if (wrapper) content = [{ type: wrapper, ...(wrapper === 'orderedList' ? { attrs: { start: 1 } } : {}), content: wrapper === 'blockquote' ? nodes : [{ type: wrapper === 'taskList' ? 'taskItem' : 'listItem', ...(wrapper === 'taskList' ? { attrs: { checked: false } } : {}), content: nodes.map(node => ({ ...node, type: 'paragraph', attrs: undefined })) }] }];
  return { value: instance.markdown.serialize({ type: 'doc', content }), leftover: '' };
}
export function focus(id, position = 0) {
  const instance = get(id); if (!instance) return false;
  instance.commands.focus(position > 0 ? 'end' : 'start', { scrollIntoView: false }); return true;
}
export function mountAll(options) {
  for (const host of options.root.querySelectorAll('.rich-block-host')) {
    const id = host.dataset.blockId, source = host.parentElement.querySelector('textarea[data-block-field=text]');
    if (!source || editors.has(id)) continue;
    let syncing = false; const initial = emptyMarkdown(source.value);
    const instance = new Editor({
      element: host, extensions: extensions(), content: initial || source.value, contentType: initial ? 'json' : 'markdown', injectCSS: false,
      editorProps: {
        attributes: { class: 'rich-editor', 'aria-label': source.getAttribute('aria-label'), 'data-rich-text': id, role: 'textbox', 'aria-multiline': 'true', spellcheck: 'false' },
        handleKeyDown(view, event) {
          if (event.isComposing || event.keyCode === 229) return false;
          const current = get(id); if (!current) return false;
          if (event.key === '/' && current.isEmpty) { options.onSlash(id, current.view.dom); return true; }
          if (event.key === 'Tab' && (options.onIndent || current.isActive('listItem') || current.isActive('taskItem'))) {
            if (options.onIndent) { options.onIndent(id, event.shiftKey ? -1 : 1); return true; }
            const type = current.isActive('taskItem') ? 'taskItem' : 'listItem'; event.shiftKey ? current.commands.liftListItem(type) : current.commands.sinkListItem(type); return true;
          }
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { options.onExit(id); return true; }
          if (event.key === 'Enter' && !event.shiftKey && options.onListSplit && (current.isActive('listItem') || current.isActive('taskItem'))) {
            const type = current.isActive('taskItem') ? 'taskItem' : 'listItem';
            if (current.commands.splitListItem(type) || current.commands.liftListItem(type)) { const result = listParts(current); options.onListSplit(id, result.parts, result.focusIndex); }
            return true;
          }
          if (event.key === 'Enter' && !event.shiftKey && !current.isActive('listItem') && !current.isActive('taskItem') && !current.isActive('codeBlock') && !current.isActive('table')) {
            const { from, to } = current.state.selection; options.onEnter(id, slice(current, 0, from), slice(current, to)); return true;
          }
          if (['Backspace', 'Delete'].includes(event.key) && current.isEmpty) return Boolean(options.onBackspace(id));
          if (event.key === 'Backspace' && current.state.selection.empty && current.state.selection.from === 1 && current.isActive('paragraph') && current.state.doc.childCount === 1) return Boolean(options.onBackspace(id));
          return false;
        },
      },
      onUpdate({ editor }) {
        syncing = true; source.value = editor.getMarkdown(); source.dispatchEvent(new Event('input', { bubbles: true })); syncing = false;
        host.dataset.empty = String(editor.isEmpty); options.onSelect(context(id, editor)); requestAnimationFrame(() => updateGrip(host));
      },
      onFocus({ editor }) { options.onFocus?.(id); options.onSelect(context(id, editor)); },
      onSelectionUpdate({ editor }) { options.onSelect(context(id, editor)); },
    });
    editors.set(id, { instance, source, host, disposeTable: attachTableUI(instance, host), disposeCode: attachCodeUI(instance, host) });
    source.hidden = true; host.dataset.empty = String(instance.isEmpty); host.parentElement.classList.add('rich-mode');
    source.addEventListener('input', () => { if (!syncing) { const empty = emptyMarkdown(source.value); instance.commands.setContent(empty || source.value, { contentType: empty ? 'json' : 'markdown', emitUpdate: false }); host.dataset.empty = String(instance.isEmpty); requestAnimationFrame(() => updateGrip(host)); } });
    requestAnimationFrame(() => updateGrip(host));
  }
}
