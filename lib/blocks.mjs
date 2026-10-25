// Keep document indentation separate from Markdown's indented-code syntax.
export function serializeProjectBlocks(project, assets) {
  const wrap = (value, level) => level ? `<!-- portfolio-indent level=${level} -->\n\n${value}\n\n<!-- /portfolio-indent -->` : value;
  const list = block => block.type === 'text' && /^(?:[-*+] |\d+\. )/.test(block.text);
  const content = block => block.type === 'image'
    ? `![${(block.alt || project.title).replace(/[\[\]\\\n]/g, ' ')}](${assets.get(block.assetId)})`
    : ['video', 'audio'].includes(block.type) ? `@[${block.type}](${assets.get(block.assetId)})`
    : block.type === 'heading' ? `## ${block.text.replace(/\n/g, ' ')}` : block.text;
  const output = [];
  for (let i = 0; i < project.blocks.length; i++) {
    const block = project.blocks[i];
    if (!list(block)) { output.push(wrap(content(block), block.indent || 0)); continue; }
    const group = [block];
    while (i + 1 < project.blocks.length && list(project.blocks[i + 1])) group.push(project.blocks[++i]);
    const base = Math.min(...group.map(item => item.indent || 0)); let previous = base;
    const nested = (group[0].indent || 0) === base && group.every(item => { const level = item.indent || 0, valid = level <= previous + 1; previous = level; return valid; });
    if (nested) output.push(wrap(group.map(item => content(item).split('\n').map(line => '    '.repeat((item.indent || 0) - base) + line).join('\n')).join('\n\n'), base));
    else output.push(...group.map(item => wrap(content(item), item.indent || 0)));
  }
  return output.join('\n\n');
}
