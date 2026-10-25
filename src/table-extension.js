import { Table, renderTableToMarkdown } from '@tiptap/extension-table';
import { tableHeaders, setTableHeaders } from './table-model.js';

const marker = /^<!-- portfolio-table row=([01]) column=([01]) -->\r?\n/;
export const PortfolioTable = Table.extend({
  addAttributes() {
    return { ...this.parent?.(), headerRow: { default: null, rendered: false }, headerColumn: { default: null, rendered: false } };
  },
  parseMarkdown(token, helpers) {
    const table = Table.config.parseMarkdown(token, helpers);
    return setTableHeaders(table, token.portfolioHeaders || { row: true, column: false });
  },
  renderMarkdown(node, helpers) {
    const headers = tableHeaders(node);
    // GFM syntax needs a delimiter after its first row. The exact header flags
    // distinguish ordinary cells from title cells without inventing an extra row.
    const syntax = setTableHeaders(node, { row: true, column: false });
    return `<!-- portfolio-table row=${Number(headers.row)} column=${Number(headers.column)} -->\n` + renderTableToMarkdown(syntax, helpers).trim();
  },
  markdownTokenizer: {
    name: 'table', level: 'block',
    start(source) { const index = source.indexOf('<!-- portfolio-table row='); return index >= 0 ? index : Table.config.markdownTokenizer.start(source); },
    tokenize(source, tokens, helpers) {
      const match = source.match(marker);
      if (!match) return Table.config.markdownTokenizer.tokenize(source, tokens, helpers);
      const table = helpers.blockTokens(source.slice(match[0].length))[0]; if (table?.type !== 'table') return undefined;
      return { ...table, raw: match[0] + table.raw, portfolioHeaders: { row: match[1] === '1', column: match[2] === '1' } };
    },
  },
});
