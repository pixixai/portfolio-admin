import taskLists from 'markdown-it-task-lists';

export function installFormatting(markdown) {
  markdown.use(taskLists, { enabled: false, label: true });
  markdown.block.ruler.before('table', 'portfolio_indent', (state, startLine, endLine, silent) => {
    const line = state.src.slice(state.bMarks[startLine] + state.tShift[startLine], state.eMarks[startLine]);
    const match = line.match(/^<!-- portfolio-indent level=([1-6]) -->$/); if (!match) return false;
    let end = startLine + 1;
    while (end < endLine && state.src.slice(state.bMarks[end] + state.tShift[end], state.eMarks[end]) !== '<!-- /portfolio-indent -->') end++;
    if (end === endLine) return false; if (silent) return true;
    const open = state.push('portfolio_indent_open', 'div', 1); open.attrSet('class', 'portfolio-indent'); open.attrSet('style', `margin-left:${Number(match[1]) * 24}px`);
    state.md.block.tokenize(state, startLine + 1, end); state.push('portfolio_indent_close', 'div', -1); state.line = end + 1; return true;
  });
  markdown.block.ruler.before('table', 'portfolio_table_headers', (state, startLine, endLine, silent) => {
    const line = state.src.slice(state.bMarks[startLine] + state.tShift[startLine], state.eMarks[startLine]);
    const match = line.match(/^<!-- portfolio-table row=([01]) column=([01]) -->$/);
    if (!match || startLine + 2 >= endLine) return false;
    const first = state.src.slice(state.bMarks[startLine + 1], state.eMarks[startLine + 1]), separator = state.src.slice(state.bMarks[startLine + 2], state.eMarks[startLine + 2]);
    if (!first.includes('|') || !/^\s*\|[\s:|\-]+\|\s*$/.test(separator)) return false;
    if (silent) return true;
    const token = state.push('portfolio_table_headers', '', 0); token.hidden = true; token.meta = { row: match[1] === '1', column: match[2] === '1' }; state.line = startLine + 1; return true;
  });
  markdown.core.ruler.after('block', 'portfolio_table_header_tags', state => {
    for (let i = 0; i < state.tokens.length; i++) {
      const marker = state.tokens[i]; if (marker.type !== 'portfolio_table_headers' || state.tokens[i + 1]?.type !== 'table_open') continue;
      let row = -1, column = 0;
      for (let j = i + 1; j < state.tokens.length; j++) {
        const token = state.tokens[j]; if (token.type === 'table_close') break;
        if (!marker.meta.row && token.tag === 'thead') { token.tag = 'tbody'; token.type = token.nesting > 0 ? 'tbody_open' : 'tbody_close'; }
        if (token.type === 'tr_open') { row++; column = 0; }
        if (['th', 'td'].includes(token.tag)) {
          const title = marker.meta.row && row === 0 || marker.meta.column && column === 0;
          token.tag = title ? 'th' : 'td'; token.type = token.tag + (token.nesting > 0 ? '_open' : '_close');
          if (title && token.nesting > 0) token.attrSet('scope', marker.meta.row && row === 0 ? 'col' : 'row');
          if (token.nesting < 0) column++;
        }
      }
    }
  });
  // GFM stores cell line breaks as <br>. Recognize only that exact marker in
  // table text, keeping arbitrary HTML disabled everywhere.
  markdown.core.ruler.after('inline', 'portfolio_table_breaks', state => {
    let cell = false;
    for (const token of state.tokens) {
      if (['td_open', 'th_open'].includes(token.type)) cell = true;
      if (['td_close', 'th_close'].includes(token.type)) cell = false;
      if (!cell || token.type !== 'inline') continue;
      token.children = token.children.flatMap(child => {
        if (child.type !== 'text' || !/<br\s*\/?\s*>/i.test(child.content)) return [child];
        return child.content.split(/(<br\s*\/?\s*>)/i).filter(Boolean).map(piece => {
          const br = /^<br\s*\/?\s*>$/i.test(piece), next = new state.Token(br ? 'softbreak' : 'text', br ? 'br' : '', 0); next.content = br ? '' : piece; return next;
        });
      });
    }
  });
  markdown.inline.ruler.before('emphasis', 'portfolio_marks', (state, silent) => {
    const source = state.src.slice(state.pos), delimiter = source.startsWith('++') ? '++' : source.startsWith('~') && !source.startsWith('~~') ? '~' : null;
    if (!delimiter) return false;
    let end = source.indexOf(delimiter, delimiter.length);
    while (end >= 0 && source[end - 1] === '\\') end = source.indexOf(delimiter, end + delimiter.length);
    if (end < delimiter.length || !source.slice(delimiter.length, end).trim() || /^\s|\s$/.test(source.slice(delimiter.length, end))) return false;
    if (!silent) {
      const tag = delimiter === '++' ? 'u' : 's';
      const open = state.push(`${tag}_open`, tag, 1); open.markup = delimiter;
      const children = []; state.md.inline.parse(source.slice(delimiter.length, end), state.md, state.env, children); state.tokens.push(...children);
      const close = state.push(`${tag}_close`, tag, -1); close.markup = delimiter;
    }
    state.pos += end + delimiter.length; return true;
  });
  return markdown;
}
